import {
  type Design,
  Ids,
  MarkupError,
  type Node,
  type Op,
  OpError,
  PROP_TOKEN_TYPES,
  type Studio,
  type Token,
  TokenError,
  type TokenSet,
  WIRE_TOKENS,
  allNodes,
  componentText,
  designText,
  exportTokens,
  findComponent,
  findToken,
  fitText,
  holderId,
  iconShapes,
  iconsLike,
  issuesText,
  locate,
  makeComponent,
  makeToken,
  nodeRefs,
  nodesNamed,
  parseMarkup,
  refsIn,
  suggest,
  tokenGroups,
  tokensText,
  topOf,
  treeText,
  updateProps,
  walk,
} from '@clanks/design';
import { type DesignAccess, ToolFailure } from '@clanks/tools';
import { DesignError, type DesignService } from './service';

/** Room between frames put on a page without a place of their own. */
const FRAME_GAP = 80;
/** How wide a frame is taken to be when its width is left to its content. */
const HUG_WIDTH = 400;

export interface DesignAccessContext {
  /** The folder the run works in: its worktree. */
  dir: string;
  conversationId: string;
  /** The most a result may hold, in characters. */
  maxChars: number;
}

/** A design step that failed, worded for the clank. */
function fail(message: string): never {
  throw new ToolFailure(message);
}

/** Runs a step, turning the design engine's own errors into ones the clank reads. */
async function guard<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof DesignError ||
      error instanceof MarkupError ||
      error instanceof TokenError ||
      error instanceof OpError
    ) {
      throw new ToolFailure(error.message);
    }
    throw error;
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** One layer by id or name. Fails saying so when there's none, or more than one. */
function oneNode(design: Design, ref: string): Node {
  const matches = nodesNamed(design, ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    return fail(`There's no layer "${ref}". Read the design with design_read for the ids.`);
  }
  return fail(
    `${matches.length} layers are called "${ref}": ${matches
      .slice(0, 8)
      .map((n) => `[${n.id}]`)
      .join(', ')}. Use the id of the one you mean.`,
  );
}

/** A frame or page to put layers in, by a frame's id or name, or a page's name or id. */
function container(design: Design, ref: string): { id: string; name: string } | null {
  const page = design.pages.find(
    (p) => p.id === ref.trim() || p.name.toLowerCase() === ref.trim().toLowerCase(),
  );
  if (page) return { id: page.id, name: `the page "${page.name}"` };
  const matches = nodesNamed(design, ref);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return fail(
      `${matches.length} layers are called "${ref}". Use the id of the frame you mean: ${matches
        .slice(0, 8)
        .map((n) => `[${n.id}]`)
        .join(', ')}.`,
    );
  }
  const node = matches[0]!;
  if (node.type !== 'frame') {
    return fail(
      `[${node.id}] "${node.name}" is a ${node.type}, which can't hold layers. Give a frame.`,
    );
  }
  return { id: node.id, name: `[${node.id}] "${node.name}"` };
}

/**
 * Checks what new or changed layers refer to: tokens that exist and fit the property, icons in
 * the set, images in the project. Wireframe tokens used for the first time are returned to add.
 */
function checkRefs(nodes: Node[], tokens: TokenSet, service: DesignService, dir: string): Token[] {
  const missing: Token[] = [];
  for (const top of nodes) {
    for (const node of walk(top)) {
      for (const { prop, path } of nodeRefs(node)) {
        const token =
          findToken(tokens, path) ??
          missing.find((t) => t.path === path) ??
          WIRE_TOKENS.find((t) => t.path === path);
        if (!token) {
          fail(
            `"${node.name}" uses {${path}} for ${prop}, which isn't a token${suggest(path, tokens)}. Use a token that exists, or add it with design_tokens_set first.`,
          );
        }
        if (!findToken(tokens, path) && !missing.includes(token)) missing.push(token);
        const wanted = PROP_TOKEN_TYPES[prop];
        if (wanted && !wanted.includes(token.type)) {
          fail(
            `"${node.name}" uses {${path}} for ${prop}, but ${prop} takes a ${wanted[0]} token and {${path}} is a ${token.type}.`,
          );
        }
      }
      if (node.type === 'icon' && !iconShapes(node.icon)) {
        const close = iconsLike(node.icon);
        fail(
          `There's no icon called "${node.icon}".${close.length ? ` Close ones: ${close.join(', ')}.` : ' Icons are from Lucide, such as search, menu, shopping-cart.'}`,
        );
      }
      if (node.type === 'image' && node.src && !service.hasAsset(dir, node.src)) {
        fail(
          `"${node.name}" points at ${node.src}, which isn't an image in the project. Leave src out for a placeholder, and say what the image should show in alt.`,
        );
      }
    }
  }
  return missing;
}

/**
 * The design tools, for one clank in one run. Every change is applied as operations, so it shows
 * on the user's canvas as it's made; what the user changed by hand meanwhile is kept.
 */
export function designAccess(service: DesignService, ctx: DesignAccessContext): DesignAccess {
  const { dir, conversationId } = ctx;
  const user = () => service.userName();

  /** What the user changed that this call would have overwritten, taken out of it. */
  const kept = (lines: string[]): string =>
    lines.length === 0
      ? ''
      : `\n\n${user()} changed these by hand while you worked, so they were kept as ${user()} left them:\n${lines.map((l) => `- ${l}`).join('\n')}\nLeave them unless the ticket or ${user()} asks otherwise.`;

  return {
    read: (input) =>
      guard(() => {
        const file = service.resolveFile(dir, input.file);
        const { state, exists, problems } = service.load(dir, file);
        if (input.tokens) {
          if (input.tokens === true)
            return fitText(tokensText(state.tokens).split('\n'), ctx.maxChars, '');
          return exportTokens(state.tokens, input.tokens);
        }
        if (!exists) {
          return [
            `There's no design yet (${file} doesn't exist). ${state.tokens.tokens.length > 0 ? `The project has ${state.tokens.tokens.length} tokens (${tokenGroups(state.tokens)}).` : 'There are no tokens either.'}`,
            'Start with the tokens (design_tokens_set), then build frames with design_create.',
            ...problems,
          ].join('\n');
        }
        const more = 'Read a frame on its own with node and its id.';
        if (input.node) {
          // A component's name means the component, whatever layers share it.
          const byId = /^\[?[a-z]\d+\]?$/i.test(input.node.trim());
          const component = findComponent(state.design, input.node);
          if (component && (!byId || nodesNamed(state.design, input.node).length === 0)) {
            return fitText(
              componentText(component, state.design, input.depth ?? 12),
              ctx.maxChars,
              more,
            );
          }
          const node = oneNode(state.design, input.node);
          const lines = treeText([node], state.design, input.depth ?? 12);
          if (node.type === 'instance') {
            const used = state.design.components.find((c) => c.id === node.component);
            if (used) lines.push('', ...componentText(used, state.design, 6));
          }
          return fitText(lines, ctx.maxChars, 'Read a layer inside it with node and its id.');
        }
        return fitText(
          designText(file, state.design, state.tokens, input.depth ?? 3).split('\n'),
          ctx.maxChars,
          more,
        );
      }),

    create: (input) =>
      guard(() => {
        const file = service.resolveFile(dir, input.file);
        const { state } = service.load(dir, file);
        const { design } = state;
        const ids = new Ids(design);
        const ops: Op[] = [];
        let parent: { id: string; name: string };
        let made = '';
        if (input.parent?.trim()) {
          const found = container(design, input.parent);
          if (found) parent = found;
          else if (/^\[?[a-z]\d+\]?$/i.test(input.parent.trim())) {
            return fail(`There's no layer or page ${input.parent}. Read the design for the ids.`);
          } else {
            // A name nothing has is a new page.
            const page = { id: ids.page(), name: input.parent.trim().slice(0, 200), children: [] };
            ops.push({ op: 'page.add', page });
            parent = { id: page.id, name: `the new page "${page.name}"` };
            made = ` Made the page "${page.name}".`;
          }
        } else {
          const first = design.pages[0]!;
          parent = { id: first.id, name: `the page "${first.name}"` };
        }
        const nodes = parseMarkup(input.markup, { ids, design });
        for (const token of checkRefs(nodes, state.tokens, service, dir)) {
          ops.push({ op: 'token.set', token });
        }
        const page = design.pages.find((p) => p.id === parent.id) ?? null;
        const onPage = page !== null || ops.some((op) => op.op === 'page.add');
        if (onPage) {
          // Frames go side by side, to the right of what's on the page.
          let x = 0;
          for (const existing of page?.children ?? []) {
            const width = typeof existing.w === 'number' ? existing.w : HUG_WIDTH;
            x = Math.max(x, (existing.x ?? 0) + width + FRAME_GAP);
          }
          for (const node of nodes) {
            if (node.x === undefined && node.y === undefined) {
              node.x = x;
              node.y = 0;
            }
            x = Math.max(
              x,
              (node.x ?? 0) + (typeof node.w === 'number' ? node.w : HUG_WIDTH) + FRAME_GAP,
            );
          }
        }
        nodes.forEach((node, i) =>
          ops.push({
            op: 'insert',
            parent: parent.id,
            ...(input.index === undefined ? {} : { index: input.index + i }),
            node,
          }),
        );
        const { state: after } = service.commit(dir, file, ops);
        const count = nodes.reduce((sum, node) => sum + [...walk(node)].length, 0);
        const tree = fitText(
          treeText(nodes, after.design, 4),
          Math.min(ctx.maxChars, 6000),
          'Read the rest with design_read.',
        );
        return `Added ${plural(count, 'layer')} to ${parent.name} in ${file}.${made}\n\n${tree}`;
      }),

    update: (input) =>
      guard(() => {
        const file = service.resolveFile(dir, input.file);
        const { state } = service.load(dir, file);
        const { design } = state;
        const untold = service.untoldEdits(conversationId);
        const ops: Op[] = [];
        const changed: Node[] = [];
        const keptLines: string[] = [];
        const told: string[] = [];
        for (const update of input.updates) {
          const node = oneNode(design, update.id);
          let set: Record<string, unknown>;
          try {
            set = updateProps(node, update.set, design);
          } catch (error) {
            if (error instanceof MarkupError) {
              return fail(`[${node.id}] "${node.name}": ${error.message}`);
            }
            throw error;
          }
          for (const prop of Object.keys(set)) {
            const key = `${node.id}.${prop}`;
            const line = untold.get(key);
            if (line === undefined) continue;
            delete set[prop];
            keptLines.push(line);
            told.push(key);
          }
          if (Object.keys(set).length > 0) {
            const next = { ...node, ...set };
            checkRefs(
              [{ ...next, ...(next.type === 'frame' ? { children: [] } : {}) }],
              state.tokens,
              service,
              dir,
            );
            ops.push({ op: 'update', id: node.id, set });
            changed.push(node);
          }
          if (update.parent !== undefined || update.index !== undefined) {
            const located = locate(design, node.id)!;
            const target = update.parent
              ? container(design, update.parent)
              : { id: holderId(located) ?? '', name: '' };
            if (!target?.id) {
              return fail(
                update.parent
                  ? `There's no frame or page "${update.parent}" to move [${node.id}] into.`
                  : `[${node.id}] is a component's root, so it can't be moved.`,
              );
            }
            const key = `${node.id}.>`;
            if (untold.has(key)) {
              keptLines.push(untold.get(key)!);
              told.push(key);
            } else {
              ops.push({
                op: 'move',
                id: node.id,
                parent: target.id,
                ...(update.index === undefined ? {} : { index: update.index }),
              });
              if (!changed.includes(node)) changed.push(node);
            }
          }
        }
        if (ops.length === 0) {
          service.told(conversationId, told);
          return `Nothing changed.${kept(keptLines)}`;
        }
        const { state: after } = service.commit(dir, file, ops);
        service.told(conversationId, told);
        const lines = treeText(
          changed
            .map((n) => locate(after.design, n.id)?.node)
            .filter((n): n is Node => n !== undefined)
            .map((n) => (n.type === 'frame' ? { ...n, children: [] } : n)),
          after.design,
          1,
        );
        return `Changed ${plural(changed.length, 'layer')}.\n\n${fitText(lines, Math.min(ctx.maxChars, 4000), '')}${kept(keptLines)}`;
      }),

    remove: (input) =>
      guard(() => {
        const file = service.resolveFile(dir, input.file);
        const { state } = service.load(dir, file);
        const { design } = state;
        const untold = service.untoldEdits(conversationId);
        const ops: Op[] = [];
        const keptLines: string[] = [];
        const told: string[] = [];
        let count = 0;
        const names: string[] = [];
        for (const ref of input.ids) {
          const matches = nodesNamed(design, ref);
          const component = matches.length === 0 ? findComponent(design, ref) : undefined;
          if (component) {
            const used = [...allNodes(design)].filter(
              (n) => n.type === 'instance' && n.component === component.id,
            );
            ops.push({ op: 'component.remove', id: component.id });
            names.push(
              `the component ${component.name}${used.length ? ` (${plural(used.length, 'instance')} of it ${used.length === 1 ? 'is' : 'are'} now broken: ${used.map((n) => `[${n.id}]`).join(', ')})` : ''}`,
            );
            count++;
            continue;
          }
          const node = oneNode(design, ref);
          const located = locate(design, node.id)!;
          // Deleting something the user just changed or made would throw their work away.
          const touched = [...walk(node)]
            .flatMap((inner) => [...untold.keys()].filter((key) => key.startsWith(`${inner.id}.`)))
            .filter((key) => !key.endsWith('.-'));
          if (touched.length > 0) {
            keptLines.push(...new Set(touched.map((key) => untold.get(key)!)));
            told.push(...touched);
            continue;
          }
          if (located.holder.kind === 'variant') {
            const { component: owner, variant } = located.holder;
            ops.push(
              owner.variants.length === 1
                ? { op: 'component.remove', id: owner.id }
                : { op: 'variant.remove', component: owner.id, name: variant.name },
            );
            names.push(`the variant ${variant.name} of ${owner.name}`);
          } else {
            ops.push({ op: 'remove', id: node.id });
            names.push(`[${node.id}] "${node.name}"`);
          }
          count += [...walk(node)].length;
        }
        if (ops.length === 0) {
          service.told(conversationId, told);
          return `Nothing was deleted.${kept(keptLines)}`;
        }
        service.commit(dir, file, ops);
        service.told(conversationId, told);
        return `Deleted ${names.join(', ')}${count > names.length ? `: ${plural(count, 'layer')} in all` : ''}.${kept(keptLines)}`;
      }),

    setTokens: (input) =>
      guard(() => {
        const file = service.resolveFile(dir, undefined);
        const { state } = service.load(dir, file);
        const untold = service.untoldEdits(conversationId);
        let working: TokenSet = state.tokens;
        const ops: Op[] = [];
        const keptLines: string[] = [];
        const told: string[] = [];
        let added = 0;
        let changed = 0;
        for (const draft of input.tokens) {
          const token = makeToken(working, {
            name: draft.name,
            value: draft.value,
            type: draft.type as Token['type'] | undefined,
            modes: draft.modes,
            description: draft.description,
          });
          const key = `token:${token.path}`;
          if (untold.has(key)) {
            keptLines.push(untold.get(key)!);
            told.push(key);
            continue;
          }
          const existing = findToken(working, token.path);
          if (existing) {
            if (JSON.stringify(existing) === JSON.stringify(token)) continue;
            // A mode this call doesn't mention keeps the value it had.
            token.modes = { ...existing.modes, ...token.modes };
            if (Object.keys(token.modes).length === 0) delete token.modes;
            changed++;
          } else added++;
          ops.push({ op: 'token.set', token });
          working = {
            modes: [...new Set([...working.modes, ...Object.keys(token.modes ?? {})])],
            tokens: existing
              ? working.tokens.map((t) => (t === existing ? token : t))
              : [...working.tokens, token],
          };
        }
        for (const name of input.remove) {
          const path = name.trim().replace(/^\{|\}$/g, '');
          if (!findToken(working, path)) {
            return fail(`There's no token {${path}} to delete${suggest(path, working)}.`);
          }
          const users = [...allNodes(state.design)].filter((node) =>
            nodeRefs(node).some((r) => r.path === path),
          );
          const aliases = working.tokens.filter(
            (t) =>
              t.path !== path &&
              [t.value, ...Object.values(t.modes ?? {})].some((v) =>
                refsIn(v).includes(`{${path}}`),
              ),
          );
          if (users.length > 0 || aliases.length > 0) {
            return fail(
              `{${path}} is still used by ${[
                ...users.slice(0, 8).map((n) => `[${n.id}] "${n.name}"`),
                ...aliases.slice(0, 8).map((t) => `{${t.path}}`),
              ].join(', ')}. Change those first.`,
            );
          }
          ops.push({ op: 'token.remove', path });
          working = { ...working, tokens: working.tokens.filter((t) => t.path !== path) };
        }
        if (ops.length === 0) {
          service.told(conversationId, told);
          return `Nothing changed: the tokens are already like that.${kept(keptLines)}`;
        }
        const { state: after } = service.commit(dir, file, ops);
        service.told(conversationId, told);
        const parts = [
          added ? `added ${added}` : '',
          changed ? `changed ${changed}` : '',
          input.remove.length ? `deleted ${input.remove.length}` : '',
        ].filter(Boolean);
        return `Tokens: ${parts.join(', ')}. The project now has ${after.tokens.tokens.length}: ${tokenGroups(after.tokens)}. Use one in a layer as {its.name}.${kept(keptLines)}`;
      }),

    makeComponent: (input) =>
      guard(() => {
        const file = service.resolveFile(dir, input.file);
        const { state } = service.load(dir, file);
        const node = oneNode(state.design, input.node);
        const made = makeComponent(state.design, node.id, input.name, input.variant);
        service.commit(dir, file, made.ops);
        const propText =
          made.props.length > 0
            ? ` Its properties: ${made.props.map((p) => p.name).join(', ')}.`
            : '';
        const example = made.props.find((p) => p.type === 'text');
        return `${made.added ? `Added the variant "${made.variant}" to ${made.component.name}` : `Made the component ${made.component.name} (${made.component.id}) with the variant "${made.variant}"`}.${propText} [${made.instance}] is an instance of it, where [${node.id}] was. Reuse it with <Instance of="${made.component.name}" variant="${made.variant}"${example ? ` ${example.name}="…"` : ''} />.`;
      }),

    link: (input) =>
      guard(() => {
        const file = service.resolveFile(dir, input.file);
        const { state } = service.load(dir, file);
        const from = oneNode(state.design, input.from);
        if (input.to === null) {
          service.commit(dir, file, [{ op: 'link', from: from.id, to: null }]);
          return `[${from.id}] "${from.name}" links nowhere now.`;
        }
        const target = oneNode(state.design, input.to);
        const located = locate(state.design, target.id)!;
        const frame = located.page ? topOf(located) : null;
        if (!frame || frame.type !== 'frame') {
          return fail(`"${target.name}" isn't a frame on a page, so nothing can link to it.`);
        }
        service.commit(dir, file, [{ op: 'link', from: from.id, to: frame.id }]);
        return `Clicking [${from.id}] "${from.name}" now goes to "${frame.name}".`;
      }),

    render: (input) =>
      guard(async () => {
        const file = service.resolveFile(dir, input.file);
        const { state } = service.load(dir, file);
        const node = oneNode(state.design, input.frame);
        const located = locate(state.design, node.id)!;
        const frame = topOf(located);
        const mode = input.mode?.trim().toLowerCase() || state.tokens.modes[0] || 'light';
        if (state.tokens.tokens.length > 0 && !state.tokens.modes.includes(mode)) {
          return fail(`There's no mode "${mode}". The modes are ${state.tokens.modes.join(', ')}.`);
        }
        const picture = await service.picture(dir, state, frame, mode);
        if (!picture) return fail("Frames can't be drawn here. Check the design with design_lint.");
        const inside = frame.id === node.id ? '' : ` (the frame [${node.id}] is in)`;
        return {
          content: `Drew "${frame.name}"${inside} in ${mode} mode: ${Math.round(picture.width)}×${Math.round(picture.height)}${picture.cut ? ', cut off at the bottom because it is so tall' : ''}. ${user()} sees the picture too. If you can't see pictures, check the frame with design_lint.`,
          image: { data: picture.png, mediaType: 'image/png' },
        };
      }),

    lint: (input) =>
      guard(async () => {
        const file = service.resolveFile(dir, input.file);
        const { state, exists } = service.load(dir, file);
        if (!exists) return fail(`There's no design to check yet (${file} doesn't exist).`);
        let frames: string[] | undefined;
        if (input.frame) {
          const node = oneNode(state.design, input.frame);
          frames = [topOf(locate(state.design, node.id)!).id];
        }
        const result = await service.lint(dir, state, frames);
        return fitText(
          issuesText(result.issues, { frames: result.frames, measured: result.measured }).split(
            '\n',
          ),
          ctx.maxChars,
          'Fix these, then check again.',
        );
      }),
  };
}

/** The state after a tool's changes, for tests and callers that want it. */
export type { Studio };
