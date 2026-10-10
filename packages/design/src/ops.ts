import {
  type Component,
  type ComponentProp,
  type Design,
  NODE_PROPS,
  type Node,
  type Page,
  type Variant,
  componentSchema,
  isRef,
  nodeSchema,
  pageSchema,
  refPath,
  toRef,
} from './schema';
import { z } from 'zod';
import {
  TOKEN_PATH,
  TOKEN_TYPES,
  type Token,
  TokenError,
  type TokenSet,
  coerceValue,
  findToken,
} from './tokens';
import { allNodes, childrenIn, holderId, idNumber, locate, walk } from './tree';

/** A design file and its project's tokens, which change together. */
export interface Studio {
  design: Design;
  tokens: TokenSet;
}

/**
 * One change to a design. Every edit, by a person in Studio or by a clank's design tools, is a
 * list of these, so it can be shown as it happens, saved, and undone.
 */
export type Op =
  /** Adds a layer to a page or a frame. */
  | { op: 'insert'; parent: string; index?: number | undefined; node: Node }
  | { op: 'remove'; id: string }
  /** Sets a layer's properties. A null value takes the property away. */
  | { op: 'update'; id: string; set: Record<string, unknown> }
  | { op: 'move'; id: string; parent: string; index?: number | undefined }
  | { op: 'page.add'; page: Page; index?: number | undefined }
  | { op: 'page.remove'; id: string }
  | { op: 'page.update'; id: string; name: string }
  | { op: 'page.move'; id: string; index: number }
  | { op: 'component.add'; component: Component; index?: number | undefined }
  | { op: 'component.remove'; id: string }
  | {
      op: 'component.update';
      id: string;
      set: { name?: string; description?: string | null; props?: ComponentProp[] };
    }
  | { op: 'variant.add'; component: string; variant: Variant; index?: number | undefined }
  | { op: 'variant.remove'; component: string; name: string }
  | { op: 'variant.rename'; component: string; name: string; to: string }
  /** Links a layer to a frame for the prototype. Null takes the link away. */
  | { op: 'link'; from: string; to: string | null }
  | { op: 'token.set'; token: Token; index?: number | undefined }
  | { op: 'token.remove'; path: string }
  /** Renames a token, and every reference to it. */
  | { op: 'token.rename'; path: string; to: string }
  | { op: 'modes.set'; modes: string[] };

/** A change that can't be made, worded for whoever asked for it. */
export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

/** Applies changes in order. Returns the new state and the changes that undo them. */
export function applyOps(state: Studio, ops: Op[]): { state: Studio; inverse: Op[] } {
  let current = state;
  const inverse: Op[] = [];
  for (const op of ops) {
    const result = applyOp(current, op);
    current = result.state;
    inverse.unshift(...result.inverse);
  }
  return { state: current, inverse };
}

/** Applies one change. The state it was given is never altered; what didn't change is shared. */
export function applyOp(state: Studio, op: Op): { state: Studio; inverse: Op[] } {
  const { design, tokens } = state;
  const next = (d: Design, inverse: Op[]) => ({ state: { design: d, tokens }, inverse });
  switch (op.op) {
    case 'insert': {
      const node = checkNode(op.node);
      assertFresh(design, node);
      const siblings = childrenIn(design, op.parent);
      if (!siblings)
        throw new OpError(`${op.parent} isn't a page or a frame, so it can't hold layers.`);
      const index = clampIndex(op.index, siblings.length);
      const updated = mapChildren(design, op.parent, (children) => insertAt(children, index, node));
      return next(bumpIds(updated, node), [{ op: 'remove', id: node.id }]);
    }
    case 'remove': {
      const found = locate(design, op.id);
      if (!found) throw new OpError(`There's no layer ${op.id}.`);
      const parent = holderId(found);
      if (!parent) {
        throw new OpError(
          `${op.id} is the root of a variant of ${found.component!.name}. Remove the variant instead.`,
        );
      }
      const gone = new Set([...walk(found.node)].map((n) => n.id));
      const lost = design.links.filter((l) => gone.has(l.from) || gone.has(l.to));
      const updated = mapChildren(design, parent, (children) =>
        children.filter((c) => c.id !== op.id),
      );
      return next(
        {
          ...updated,
          links: lost.length ? design.links.filter((l) => !lost.includes(l)) : design.links,
        },
        [
          { op: 'insert', parent, index: found.index, node: found.node },
          ...lost.map((l): Op => ({ op: 'link', from: l.from, to: l.to })),
        ],
      );
    }
    case 'update': {
      const found = locate(design, op.id);
      if (!found) throw new OpError(`There's no layer ${op.id}.`);
      const allowed = NODE_PROPS[found.node.type];
      const before: Record<string, unknown> = {};
      const changed: Record<string, unknown> = { ...found.node };
      for (const [key, value] of Object.entries(op.set)) {
        if (!allowed.includes(key)) {
          throw new OpError(
            `A ${found.node.type} layer has no "${key}". It has: ${allowed.join(', ')}.`,
          );
        }
        before[key] = (found.node as unknown as Record<string, unknown>)[key] ?? null;
        if (value === null || value === undefined) delete changed[key];
        else changed[key] = value;
      }
      const node = checkNode(changed as unknown as Node, true);
      return next(replaceNode(design, op.id, node), [{ op: 'update', id: op.id, set: before }]);
    }
    case 'move': {
      const found = locate(design, op.id);
      if (!found) throw new OpError(`There's no layer ${op.id}.`);
      const from = holderId(found);
      if (!from) throw new OpError(`${op.id} is a variant's root, so it can't be moved.`);
      for (const inner of walk(found.node)) {
        if (inner.id === op.parent) throw new OpError("A layer can't be moved into itself.");
      }
      const target = childrenIn(design, op.parent);
      if (!target)
        throw new OpError(`${op.parent} isn't a page or a frame, so it can't hold layers.`);
      const without = mapChildren(design, from, (children) =>
        children.filter((c) => c.id !== op.id),
      );
      const length = childrenIn(without, op.parent)!.length;
      const index = clampIndex(op.index, length);
      const updated = mapChildren(without, op.parent, (children) =>
        insertAt(children, index, found.node),
      );
      return next(updated, [{ op: 'move', id: op.id, parent: from, index: found.index }]);
    }
    case 'page.add': {
      const page = check(pageSchema, op.page, 'page');
      if (design.pages.some((p) => p.id === page.id) || locate(design, page.id)) {
        throw new OpError(`There's already something with the id ${page.id}.`);
      }
      for (const node of page.children) assertFresh(design, node);
      const index = clampIndex(op.index, design.pages.length);
      let updated: Design = { ...design, pages: insertAt(design.pages, index, page) };
      updated = { ...updated, nextId: Math.max(updated.nextId, idNumber(page.id) + 1) };
      for (const node of page.children) updated = bumpIds(updated, node);
      return next(updated, [{ op: 'page.remove', id: page.id }]);
    }
    case 'page.remove': {
      const index = design.pages.findIndex((p) => p.id === op.id);
      const page = design.pages[index];
      if (!page) throw new OpError(`There's no page ${op.id}.`);
      if (design.pages.length === 1) throw new OpError('A design keeps at least one page.');
      const gone = new Set(page.children.flatMap((n) => [...walk(n)].map((x) => x.id)));
      const lost = design.links.filter((l) => gone.has(l.from) || gone.has(l.to));
      return next(
        {
          ...design,
          pages: design.pages.filter((p) => p.id !== op.id),
          links: lost.length ? design.links.filter((l) => !lost.includes(l)) : design.links,
        },
        [
          { op: 'page.add', page, index },
          ...lost.map((l): Op => ({ op: 'link', from: l.from, to: l.to })),
        ],
      );
    }
    case 'page.update': {
      const page = design.pages.find((p) => p.id === op.id);
      if (!page) throw new OpError(`There's no page ${op.id}.`);
      return next(
        {
          ...design,
          pages: design.pages.map((p) => (p === page ? { ...p, name: op.name.slice(0, 200) } : p)),
        },
        [{ op: 'page.update', id: op.id, name: page.name }],
      );
    }
    case 'page.move': {
      const from = design.pages.findIndex((p) => p.id === op.id);
      const page = design.pages[from];
      if (!page) throw new OpError(`There's no page ${op.id}.`);
      const rest = design.pages.filter((p) => p !== page);
      return next({ ...design, pages: insertAt(rest, clampIndex(op.index, rest.length), page) }, [
        { op: 'page.move', id: op.id, index: from },
      ]);
    }
    case 'component.add': {
      const component = check(componentSchema, op.component, 'component');
      if (design.components.some((c) => c.id === component.id)) {
        throw new OpError(`There's already a component with the id ${component.id}.`);
      }
      if (design.components.some((c) => sameName(c.name, component.name))) {
        throw new OpError(`There's already a component called ${component.name}.`);
      }
      assertVariantNames(component.variants);
      for (const variant of component.variants) assertFresh(design, variant.root);
      const index = clampIndex(op.index, design.components.length);
      let updated: Design = {
        ...design,
        components: insertAt(design.components, index, component),
        nextId: Math.max(design.nextId, idNumber(component.id) + 1),
      };
      for (const variant of component.variants) updated = bumpIds(updated, variant.root);
      return next(updated, [{ op: 'component.remove', id: component.id }]);
    }
    case 'component.remove': {
      const index = design.components.findIndex((c) => c.id === op.id);
      const component = design.components[index];
      if (!component) throw new OpError(`There's no component ${op.id}.`);
      return next({ ...design, components: design.components.filter((c) => c !== component) }, [
        { op: 'component.add', component, index },
      ]);
    }
    case 'component.update': {
      const component = design.components.find((c) => c.id === op.id);
      if (!component) throw new OpError(`There's no component ${op.id}.`);
      const { name, description, props } = op.set;
      if (
        name !== undefined &&
        design.components.some((c) => c !== component && sameName(c.name, name))
      ) {
        throw new OpError(`There's already a component called ${name}.`);
      }
      const changed: Component = { ...component };
      const before: Extract<Op, { op: 'component.update' }>['set'] = {};
      if (name !== undefined) {
        before.name = component.name;
        changed.name = name;
      }
      if (description !== undefined) {
        before.description = component.description ?? null;
        if (description === null) delete changed.description;
        else changed.description = description;
      }
      if (props !== undefined) {
        before.props = component.props;
        changed.props = props;
      }
      const checked = check(componentSchema, changed, 'component');
      return next(
        { ...design, components: design.components.map((c) => (c === component ? checked : c)) },
        [{ op: 'component.update', id: op.id, set: before }],
      );
    }
    case 'variant.add': {
      const component = design.components.find((c) => c.id === op.component);
      if (!component) throw new OpError(`There's no component ${op.component}.`);
      const root = checkNode(op.variant.root);
      assertFresh(design, root);
      const variants = insertAt(
        component.variants,
        clampIndex(op.index, component.variants.length),
        {
          name: op.variant.name,
          root,
        },
      );
      assertVariantNames(variants);
      const updated = {
        ...design,
        components: design.components.map((c) => (c === component ? { ...c, variants } : c)),
      };
      return next(bumpIds(updated, root), [
        { op: 'variant.remove', component: component.id, name: op.variant.name },
      ]);
    }
    case 'variant.remove': {
      const component = design.components.find((c) => c.id === op.component);
      if (!component) throw new OpError(`There's no component ${op.component}.`);
      const index = component.variants.findIndex((v) => v.name === op.name);
      const variant = component.variants[index];
      if (!variant) throw new OpError(`${component.name} has no variant ${op.name}.`);
      if (component.variants.length === 1) {
        throw new OpError(`${op.name} is ${component.name}'s only variant. Remove the component.`);
      }
      return next(
        {
          ...design,
          components: design.components.map((c) =>
            c === component ? { ...c, variants: c.variants.filter((v) => v !== variant) } : c,
          ),
        },
        [{ op: 'variant.add', component: component.id, variant, index }],
      );
    }
    case 'variant.rename': {
      const component = design.components.find((c) => c.id === op.component);
      if (!component) throw new OpError(`There's no component ${op.component}.`);
      const variant = component.variants.find((v) => v.name === op.name);
      if (!variant) throw new OpError(`${component.name} has no variant ${op.name}.`);
      const variants = component.variants.map((v) => (v === variant ? { ...v, name: op.to } : v));
      assertVariantNames(variants);
      // Instances that used it keep using it.
      const renamed = mapNodes(
        {
          ...design,
          components: design.components.map((c) => (c === component ? { ...c, variants } : c)),
        },
        (node) =>
          node.type === 'instance' && node.component === component.id && node.variant === op.name
            ? { ...node, variant: op.to }
            : node,
      );
      return next(renamed, [
        { op: 'variant.rename', component: component.id, name: op.to, to: op.name },
      ]);
    }
    case 'link': {
      const existing = design.links.find((l) => l.from === op.from);
      if (op.to === null) {
        if (!existing) return next(design, []);
        return next({ ...design, links: design.links.filter((l) => l !== existing) }, [
          { op: 'link', from: op.from, to: existing.to },
        ]);
      }
      if (!locate(design, op.from)) throw new OpError(`There's no layer ${op.from}.`);
      const target = locate(design, op.to);
      if (!target || target.holder.kind !== 'page' || target.node.type !== 'frame') {
        throw new OpError(`${op.to} isn't a frame on a page, so nothing can link to it.`);
      }
      const link = { from: op.from, to: op.to };
      return next(
        {
          ...design,
          links: existing
            ? design.links.map((l) => (l === existing ? link : l))
            : [...design.links, link],
        },
        [{ op: 'link', from: op.from, to: existing?.to ?? null }],
      );
    }
    case 'token.set': {
      const token = checkToken(op.token);
      const at = tokens.tokens.findIndex((t) => t.path === token.path);
      const previous = tokens.tokens[at];
      const list = previous
        ? tokens.tokens.map((t) => (t === previous ? token : t))
        : insertAt(tokens.tokens, clampIndex(op.index, tokens.tokens.length), token);
      const modes = [...tokens.modes];
      for (const mode of Object.keys(token.modes ?? {}))
        if (!modes.includes(mode)) modes.push(mode);
      return {
        state: { design, tokens: { modes, tokens: list } },
        inverse: [
          ...(modes.length !== tokens.modes.length
            ? [{ op: 'modes.set', modes: tokens.modes } as Op]
            : []),
          previous
            ? { op: 'token.set', token: previous }
            : { op: 'token.remove', path: token.path },
        ],
      };
    }
    case 'token.remove': {
      const index = tokens.tokens.findIndex((t) => t.path === op.path);
      const token = tokens.tokens[index];
      if (!token) throw new OpError(`There's no token ${op.path}.`);
      return {
        state: { design, tokens: { ...tokens, tokens: tokens.tokens.filter((t) => t !== token) } },
        inverse: [{ op: 'token.set', token, index }],
      };
    }
    case 'token.rename': {
      const token = findToken(tokens, op.path);
      if (!token) throw new OpError(`There's no token ${op.path}.`);
      if (findToken(tokens, op.to)) throw new OpError(`There's already a token ${op.to}.`);
      if (!TOKEN_PATH.test(op.to)) {
        throw new OpError(
          `"${op.to}" isn't a token name. Use lowercase groups joined by dots, such as color.brand.`,
        );
      }
      const from = toRef(op.path);
      const to = toRef(op.to);
      const swap = <T>(value: T): T => renameRefs(value, from, to);
      return {
        state: {
          design: mapNodes(design, (node) => swap(node)),
          tokens: {
            ...tokens,
            tokens: tokens.tokens.map((t) => {
              const renamed = t === token ? { ...t, path: op.to } : t;
              return swap(renamed);
            }),
          },
        },
        inverse: [{ op: 'token.rename', path: op.to, to: op.path }],
      };
    }
    case 'modes.set': {
      if (op.modes.length === 0) throw new OpError('Tokens keep at least one mode.');
      return {
        state: { design, tokens: { ...tokens, modes: [...new Set(op.modes)] } },
        inverse: [{ op: 'modes.set', modes: tokens.modes }],
      };
    }
  }
}

/** A token in the form its type keeps, whoever wrote it. */
function checkToken(token: Token): Token {
  if (!TOKEN_PATH.test(token.path)) {
    throw new OpError(
      `"${token.path}" isn't a token name. Use lowercase groups joined by dots, such as color.brand.`,
    );
  }
  try {
    const checked: Token = {
      path: token.path,
      type: token.type,
      value: coerceValue(token.type, token.value, token.path),
    };
    const modes = Object.entries(token.modes ?? {});
    if (modes.length > 0) {
      checked.modes = Object.fromEntries(
        modes.map(([mode, value]) => [mode, coerceValue(token.type, value, token.path)]),
      );
    }
    if (token.description) checked.description = token.description;
    return checked;
  } catch (error) {
    if (error instanceof TokenError) throw new OpError(error.message);
    throw error;
  }
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || index < 0 || index > length) return length;
  return Math.floor(index);
}

function insertAt<T>(list: T[], index: number, item: T): T[] {
  return [...list.slice(0, index), item, ...list.slice(index)];
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function assertVariantNames(variants: Variant[]): void {
  const names = variants.map((v) => v.name);
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice) throw new OpError(`There's already a variant called ${twice}.`);
}

function check<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: T,
  what: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data === undefined) {
    throw new OpError(`That isn't a valid ${what}.`);
  }
  return parsed.data;
}

/** Checks a layer's shape. `shallow` skips its children, which an update doesn't touch. */
function checkNode(node: Node, shallow = false): Node {
  const subject = shallow && node.type === 'frame' ? { ...node, children: [] } : node;
  const parsed = nodeSchema.safeParse(subject);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.filter((p) => typeof p === 'string').join('.') ?? '';
    throw new OpError(
      `${where ? `"${where}" of ` : ''}the ${node.type ?? 'layer'} ${node.id ?? ''} isn't valid: ${issue?.message ?? 'wrong shape'}.`,
    );
  }
  return shallow ? node : parsed.data;
}

/** New layers can't reuse an id that's taken. */
function assertFresh(design: Design, node: Node): void {
  const taken = new Set<string>(design.pages.map((p) => p.id));
  for (const existing of allNodes(design)) taken.add(existing.id);
  for (const component of design.components) taken.add(component.id);
  const seen = new Set<string>();
  for (const inner of walk(node)) {
    if (taken.has(inner.id) || seen.has(inner.id)) {
      throw new OpError(`There's already something with the id ${inner.id}.`);
    }
    seen.add(inner.id);
  }
}

/** Keeps the id counter ahead of every id in a new layer. */
function bumpIds(design: Design, node: Node): Design {
  let max = design.nextId;
  for (const inner of walk(node)) max = Math.max(max, idNumber(inner.id) + 1);
  return max === design.nextId ? design : { ...design, nextId: max };
}

/** Rewrites every layer, sharing whatever the rewrite leaves alone. */
function mapNodes(design: Design, visit: (node: Node) => Node): Design {
  const mapList = (nodes: Node[]): Node[] => {
    let changed = false;
    const mapped = nodes.map((node) => {
      let next = visit(node);
      if (next.type === 'frame') {
        const children = mapList(next.children);
        if (children !== next.children) next = { ...next, children };
      }
      if (next !== node) changed = true;
      return next;
    });
    return changed ? mapped : nodes;
  };
  let pagesChanged = false;
  const pages = design.pages.map((page) => {
    const children = mapList(page.children);
    if (children === page.children) return page;
    pagesChanged = true;
    return { ...page, children };
  });
  let componentsChanged = false;
  const components = design.components.map((component) => {
    let changed = false;
    const variants = component.variants.map((variant) => {
      const [root] = mapList([variant.root]);
      if (root === variant.root) return variant;
      changed = true;
      return { ...variant, root: root! };
    });
    if (!changed) return component;
    componentsChanged = true;
    return { ...component, variants };
  });
  if (!pagesChanged && !componentsChanged) return design;
  return {
    ...design,
    pages: pagesChanged ? pages : design.pages,
    components: componentsChanged ? components : design.components,
  };
}

/** Rewrites the children of one page or frame. */
function mapChildren(
  design: Design,
  containerId: string,
  change: (children: Node[]) => Node[],
): Design {
  const page = design.pages.find((p) => p.id === containerId);
  if (page) {
    return {
      ...design,
      pages: design.pages.map((p) => (p === page ? { ...p, children: change(p.children) } : p)),
    };
  }
  return mapNodes(design, (node) =>
    node.id === containerId && node.type === 'frame'
      ? { ...node, children: change(node.children) }
      : node,
  );
}

function replaceNode(design: Design, id: string, replacement: Node): Design {
  return mapNodes(design, (node) => (node.id === id ? replacement : node));
}

/** Swaps one token reference for another, wherever a value holds it. */
function renameRefs<T>(value: T, from: string, to: string): T {
  if (typeof value === 'string') return (value === from ? to : value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = renameRefs(item as unknown, from, to);
      if (next !== item) changed = true;
      return next;
    });
    return (changed ? mapped : value) as T;
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // A frame's children are visited on their own.
      const next = key === 'children' ? item : renameRefs(item, from, to);
      if (next !== item) changed = true;
      result[key] = next;
    }
    return (changed ? result : value) as T;
  }
  return value;
}

/** Every token a layer's own properties name, with the property that names it. */
export function nodeRefs(node: Node): { prop: string; path: string }[] {
  const found: { prop: string; path: string }[] = [];
  for (const [prop, value] of Object.entries(node)) {
    if (prop === 'children' || prop === 'props') continue;
    const values = Array.isArray(value) ? (value as unknown[]) : [value];
    for (const item of values) if (isRef(item)) found.push({ prop, path: refPath(item) });
  }
  return found;
}

const indexSchema = z.number().int().min(0).optional();
const idSchema = z.string().min(1).max(40);
const tokenSchema = z.object({
  path: z.string().min(1).max(200),
  type: z.enum(TOKEN_TYPES),
  value: z.unknown(),
  modes: z.record(z.string().max(40), z.unknown()).optional(),
  description: z.string().max(2000).optional(),
}) as unknown as z.ZodType<Token>;

/** Checks a change that crossed a boundary, such as one the window sends, before it's applied. */
export const opSchema: z.ZodType<Op> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('insert'), parent: idSchema, index: indexSchema, node: nodeSchema }),
  z.object({ op: z.literal('remove'), id: idSchema }),
  z.object({
    op: z.literal('update'),
    id: idSchema,
    set: z.record(z.string().max(40), z.unknown()),
  }),
  z.object({ op: z.literal('move'), id: idSchema, parent: idSchema, index: indexSchema }),
  z.object({ op: z.literal('page.add'), page: pageSchema, index: indexSchema }),
  z.object({ op: z.literal('page.remove'), id: idSchema }),
  z.object({ op: z.literal('page.update'), id: idSchema, name: z.string().max(200) }),
  z.object({ op: z.literal('page.move'), id: idSchema, index: z.number().int().min(0) }),
  z.object({ op: z.literal('component.add'), component: componentSchema, index: indexSchema }),
  z.object({ op: z.literal('component.remove'), id: idSchema }),
  z.object({
    op: z.literal('component.update'),
    id: idSchema,
    set: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(2000).nullable().optional(),
      props: z
        .array(
          z.object({
            name: z.string().trim().min(1).max(60),
            type: z.enum(['text', 'boolean']),
            default: z.union([z.string().max(20_000), z.boolean()]),
          }),
        )
        .max(40)
        .optional(),
    }),
  }),
  z.object({
    op: z.literal('variant.add'),
    component: idSchema,
    variant: z.object({ name: z.string().trim().min(1).max(120), root: nodeSchema }),
    index: indexSchema,
  }),
  z.object({ op: z.literal('variant.remove'), component: idSchema, name: z.string().max(120) }),
  z.object({
    op: z.literal('variant.rename'),
    component: idSchema,
    name: z.string().max(120),
    to: z.string().trim().min(1).max(120),
  }),
  z.object({ op: z.literal('link'), from: idSchema, to: idSchema.nullable() }),
  z.object({ op: z.literal('token.set'), token: tokenSchema, index: indexSchema }),
  z.object({ op: z.literal('token.remove'), path: z.string().max(200) }),
  z.object({ op: z.literal('token.rename'), path: z.string().max(200), to: z.string().max(200) }),
  z.object({
    op: z.literal('modes.set'),
    modes: z.array(z.string().trim().min(1).max(40)).min(1).max(12),
  }),
]);
