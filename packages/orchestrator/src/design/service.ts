import {
  DEFAULT_DESIGN,
  type Design,
  DesignFileError,
  EXPORT_FILES,
  type Geometry,
  type Issue,
  LANGUAGE_FILE,
  type Node,
  type Op,
  OpError,
  type Studio,
  type TokenExport,
  type TokenSet,
  applyOps,
  componentText,
  componentsUsed,
  designPath,
  emptyDesign,
  exportTokens,
  findNode,
  frameHtml,
  lint,
  locate,
  nodeLine,
  nodePath,
  tokenLines,
  topFrames,
  treeText,
  valueText,
} from '@clanks/design';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AssetInfo,
  assetUrl,
  hasAsset,
  listAssets,
  listDesigns,
  readDesign,
  readLanguage,
  readTokens,
  writeAsset,
  writeDesign,
  writeTokens,
} from './files';

/** A design problem worded for the user, or for the clank whose tool call caused it. */
export class DesignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignError';
  }
}

/** A frame as a browser drew it: where every layer ended up and, when asked for, a picture. */
export interface Drawing {
  boxes: Geometry;
  width: number;
  height: number;
  png: Uint8Array | null;
  /** The picture's own size in pixels, and whether the frame's foot was left off it. */
  picture?: { width: number; height: number; cut: boolean } | undefined;
}

/** How big a picture of a frame may be. */
export interface PictureLimits {
  /** The most pixels across. */
  maxWidth: number;
  /** The most pixels in all. A frame too tall for it is drawn smaller, then cut at the foot. */
  maxPixels: number;
  /** The smallest it's drawn, as a share of its real size, before it's cut instead. */
  minScale: number;
}

/** What the desktop app does for designs: draws a frame's HTML in a view nobody sees. */
export interface DesignHost {
  draw(input: {
    html: string;
    /** The width to lay it out in, in CSS pixels. */
    width: number;
    /** Take a picture too, within these limits. */
    capture: PictureLimits | null;
  }): Promise<Drawing>;
}

/** A design as Studio shows it. */
export interface DesignSnapshot {
  /** Every design file in the folder, such as `design/site.design`. */
  files: string[];
  /** The one shown. It may not exist yet. */
  file: string;
  /** Null when there's no design yet, or it can't be read. */
  design: Design | null;
  tokens: TokenSet;
  /** Changes whenever the design or the tokens do. */
  rev: string;
  /** Why something couldn't be read. */
  problems: string[];
  /** There's a `design/DESIGN.md`. */
  language: boolean;
  assets: AssetInfo[];
}

export interface DesignServiceOptions {
  /** Draws frames. Without one, nothing is measured or pictured. */
  host: DesignHost | null;
  userName: () => string;
  /** The user changed a run's design by hand: its clank should hear, and the files moved on. */
  userEdited?: (conversationId: string, file: string, lines: Record<string, string>) => void;
}

/**
 * The picture a clank is shown: about a megapixel, like a screenshot of a page. A model's vision
 * encoder works on the whole picture at once, and a much bigger one can take a local model's
 * server down with it.
 */
const PICTURE: PictureLimits = { maxWidth: 1024, maxPixels: 1_150_000, minScale: 0.4 };
/** Frames measured by one lint, so a huge file doesn't hold a run up. */
const MAX_MEASURED = 40;

/**
 * Projects' designs: the design files and tokens in a folder's `design/`, read and written as
 * operations. A folder is a run's worktree or a project's own checkout. Emits `change` with the
 * folder when a design in it changes, so Studio redraws as a clank works.
 */
export class DesignService extends EventEmitter<{ change: [dir: string] }> {
  /** What the user changed by hand in a run's design that its clank hasn't been told yet. */
  private readonly untold = new Map<string, Map<string, string>>();

  constructor(private readonly options: DesignServiceOptions) {
    super();
    this.setMaxListeners(100);
  }

  /** Whether frames can be drawn here. */
  get canDraw(): boolean {
    return this.options.host !== null;
  }

  /**
   * The design file a name means. Without a name: the folder's only one, or the default when it
   * has none yet. Throws when there are several to choose from.
   */
  resolveFile(dir: string, file?: string): string {
    const files = listDesigns(dir);
    if (file?.trim()) {
      const wanted = designPath(file);
      return files.find((f) => f.toLowerCase() === wanted) ?? wanted;
    }
    if (files.length === 0) return DEFAULT_DESIGN;
    if (files.length === 1) return files[0]!;
    throw new DesignError(
      `There are ${files.length} design files: ${files.join(', ')}. Say which with file.`,
    );
  }

  /** A design and the tokens as they are on disk. The design is empty when there's none yet. */
  load(dir: string, file: string): { state: Studio; exists: boolean; problems: string[] } {
    const { tokens, problems } = readTokens(dir);
    try {
      const design = readDesign(dir, file);
      return {
        state: { design: design ?? emptyDesign(titleOf(file)), tokens },
        exists: design !== null,
        problems,
      };
    } catch (error) {
      if (error instanceof DesignFileError) {
        throw new DesignError(`${file} can't be read: ${error.message}`);
      }
      throw error;
    }
  }

  /** What Studio shows for a folder. */
  snapshot(dir: string, file?: string): DesignSnapshot {
    const files = listDesigns(dir);
    const { tokens, problems } = readTokens(dir);
    const wanted = file ? designPath(file) : undefined;
    const shown = (wanted && files.includes(wanted) ? wanted : files[0]) ?? DEFAULT_DESIGN;
    let design: Design | null = null;
    try {
      design = readDesign(dir, shown);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    const rev = createHash('sha1')
      .update(JSON.stringify([shown, design, tokens]))
      .digest('hex')
      .slice(0, 16);
    return {
      files,
      file: shown,
      design,
      tokens,
      rev,
      problems,
      language: readLanguage(dir) !== null,
      assets: listAssets(dir),
    };
  }

  /**
   * Applies changes to a design and saves it. Reading, changing and writing happen in one go, so
   * a person's edit and a clank's never interleave.
   */
  commit(dir: string, file: string, ops: Op[]): { before: Studio; state: Studio; inverse: Op[] } {
    const { state: before } = this.load(dir, file);
    let result: { state: Studio; inverse: Op[] };
    try {
      result = applyOps(before, ops);
    } catch (error) {
      if (error instanceof OpError) throw new DesignError(error.message);
      throw error;
    }
    if (result.state.tokens !== before.tokens) writeTokens(dir, result.state.tokens);
    writeDesign(dir, file, result.state.design);
    this.emit('change', dir);
    return { before, ...result };
  }

  /** The user's own edit from Studio. In a run, its clank is told what they changed. */
  applyUser(input: {
    dir: string;
    file?: string | undefined;
    ops: Op[];
    conversationId: string | null;
  }): DesignSnapshot {
    const file = this.resolveFile(input.dir, input.file);
    const { before, state } = this.commit(input.dir, file, input.ops);
    if (input.conversationId) {
      const lines = this.untold.get(input.conversationId) ?? new Map<string, string>();
      for (const [key, line] of editLines(input.ops, before, state)) lines.set(key, line);
      this.untold.set(input.conversationId, lines);
      this.options.userEdited?.(input.conversationId, file, Object.fromEntries(lines));
    }
    return this.snapshot(input.dir, file);
  }

  /** What the user changed in a run's design since its clank last heard, by what was changed. */
  untoldEdits(conversationId: string): Map<string, string> {
    return this.untold.get(conversationId) ?? new Map<string, string>();
  }

  /** The clank has been told about these edits, or about all of them. */
  told(conversationId: string, keys?: string[]): void {
    if (!keys) {
      this.untold.delete(conversationId);
      return;
    }
    const lines = this.untold.get(conversationId);
    for (const key of keys) lines?.delete(key);
  }

  /** A run ended for good: nothing more to tell its clank. */
  forget(conversationId: string): void {
    this.untold.delete(conversationId);
  }

  userName(): string {
    return this.options.userName();
  }

  /** An image a design names, as a data URL. */
  asset(dir: string, src: string): string | null {
    return assetUrl(dir, src);
  }

  hasAsset(dir: string, src: string): boolean {
    return hasAsset(dir, src);
  }

  addAsset(dir: string, name: string, data: Uint8Array): AssetInfo {
    try {
      const asset = writeAsset(dir, name, data);
      this.emit('change', dir);
      return asset;
    } catch (error) {
      if (error instanceof DesignFileError) throw new DesignError(error.message);
      throw error;
    }
  }

  /** The tokens as CSS, a Tailwind theme or JSON. With `save`, also written beside the tokens. */
  exportTokens(dir: string, format: TokenExport, save: boolean): { text: string; path: string } {
    const { tokens } = readTokens(dir);
    const text = exportTokens(tokens, format);
    const path = `design/${EXPORT_FILES[format]}`;
    if (save) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
      this.emit('change', dir);
    }
    return { text, path };
  }

  /**
   * Draws one frame: its picture, and where each of its layers ended up. Null without the app to
   * draw it. The frame is drawn at its own width, or 1440 when that's left to its content.
   */
  async draw(
    dir: string,
    state: Studio,
    frame: Node,
    options: { mode: string; capture: boolean },
  ): Promise<Drawing | null> {
    const host = this.options.host;
    if (!host) return null;
    const html = frameHtml(frame, {
      design: state.design,
      tokens: state.tokens,
      mode: options.mode,
      asset: (src) => assetUrl(dir, src),
    });
    const width = typeof frame.w === 'number' ? Math.max(1, Math.ceil(frame.w)) : 1440;
    return host.draw({
      html,
      width,
      capture: options.capture ? PICTURE : null,
    });
  }

  /**
   * Checks a design. Frames are measured in a browser when the app is there, so overflow and tap
   * targets are checked against what would really be drawn.
   */
  async lint(
    dir: string,
    state: Studio,
    frames?: string[],
  ): Promise<{ issues: Issue[]; frames: number; measured: boolean }> {
    const targets = state.design.pages
      .flatMap((page) => page.children)
      .filter((node) => !frames || frames.includes(node.id));
    const geometry: Record<string, Geometry> = {};
    let measured = this.canDraw && targets.length > 0;
    for (const frame of targets.slice(0, MAX_MEASURED)) {
      try {
        const drawing = await this.draw(dir, state, frame, {
          mode: state.tokens.modes[0] ?? 'light',
          capture: false,
        });
        if (drawing) geometry[frame.id] = drawing.boxes;
        else measured = false;
      } catch (error) {
        console.error('Measuring a frame failed', error);
        measured = false;
      }
    }
    const issues = lint(state.design, state.tokens, {
      ...(frames ? { frames } : {}),
      geometry,
      hasAsset: (src) => hasAsset(dir, src),
    });
    return { issues, frames: targets.length, measured };
  }

  /** A picture of a frame, capped so a long page doesn't become an enormous image. */
  async picture(
    dir: string,
    state: Studio,
    frame: Node,
    mode: string,
  ): Promise<{ png: Uint8Array; width: number; height: number; cut: boolean } | null> {
    const drawing = await this.draw(dir, state, frame, { mode, capture: true });
    if (!drawing?.png) return null;
    return {
      png: drawing.png,
      width: drawing.width,
      height: drawing.height,
      cut: drawing.picture?.cut ?? false,
    };
  }

  /**
   * What a clank building from a design is told: the design language, the tokens and the frames it
   * builds, within a budget of tokens. Null when the folder has no design.
   */
  handoff(dir: string, options: { frames: string[]; budget: number }): string | null {
    const files = listDesigns(dir);
    const language = readLanguage(dir);
    const { tokens } = readTokens(dir);
    if (files.length === 0 && !language && tokens.tokens.length === 0) return null;
    const chars = Math.max(800, options.budget * 4);
    const lines = [
      '## Design',
      '',
      `The project's design is in \`design/\`: ${files.length > 0 ? files.map((f) => `\`${f}\``).join(', ') : 'no design file yet'}${language ? `, its language in \`${LANGUAGE_FILE}\`` : ''} and ${tokens.tokens.length} tokens. It is the design ${this.options.userName()} approved; what you build matches it.`,
    ];
    if (language) {
      lines.push('', `### ${LANGUAGE_FILE}`, '', cut(language.trim(), Math.floor(chars * 0.3)));
    }
    if (tokens.tokens.length > 0) {
      const list = tokenLines(tokens);
      lines.push(
        '',
        `### Tokens (${tokens.modes.join(', ')})`,
        '',
        cut(list.join('\n'), Math.floor(chars * 0.25)),
        '',
        'In code a token is a CSS custom property: `{color.brand}` is `var(--color-brand)`. Get them all as CSS, a Tailwind theme or JSON with design_read and `tokens: "css"`, and put that in the build rather than copying values.',
      );
    }
    const wanted = options.frames.map((name) => name.trim().toLowerCase());
    for (const file of files) {
      let design: Design | null = null;
      try {
        design = readDesign(dir, file);
      } catch {
        continue;
      }
      if (!design) continue;
      const all = topFrames(design).map((t) => t.frame);
      const named = all.filter((f) => wanted.includes(f.name.toLowerCase()));
      const shown = named.length > 0 ? named : all;
      if (shown.length === 0) continue;
      const tree = [
        ...treeText(shown, design, 12),
        ...componentsUsed(shown, design).flatMap((c) => ['', ...componentText(c, design, 12)]),
      ];
      lines.push(
        '',
        `### Frames in ${file}`,
        '',
        'Each layer is `[id] Type "name"` and its properties: layout is flexbox (row or col), w and h are pixels, fill (take the room left) or hug (fit the content).',
        '',
        cut(tree.join('\n'), Math.floor(chars * 0.45)),
      );
    }
    lines.push(
      '',
      'Read a frame in full with design_read and its id. With design_render you get a frame as a picture, to compare with a browser_screenshot of what you built.',
    );
    return lines.join('\n');
  }

  /**
   * Whether a design is fit to hand in: there's a design with a frame in it, and nothing in it is
   * broken. Returns what the hand-in records, or throws saying what to fix.
   */
  async check(
    dir: string,
    file?: string,
  ): Promise<{ file: string; frames: string[]; lint: string }> {
    const files = listDesigns(dir);
    if (files.length === 0) {
      throw new DesignError(
        "There's no design to hand in yet. Build it with design_tokens_set and design_create first.",
      );
    }
    const wanted = file ? designPath(file) : null;
    const shown = (wanted && files.includes(wanted) ? wanted : null) ?? files[0]!;
    const { state } = this.load(dir, shown);
    const frames = topFrames(state.design).map((t) => t.frame);
    if (frames.length === 0) {
      throw new DesignError(`${shown} has no frames yet. Add the screens with design_create.`);
    }
    const { issues } = await this.lint(dir, state);
    const broken = issues.filter((i) =>
      ['missing-token', 'wrong-token', 'detached-instance', 'icon', 'image', 'no-layout'].includes(
        i.rule,
      ),
    );
    if (broken.length > 0) {
      throw new DesignError(
        `The design isn't ready to hand in. Fix these first, then check with design_lint:\n${broken
          .slice(0, 20)
          .map((i) => `- [${i.id}] "${i.name}" ${i.message}`)
          .join('\n')}`,
      );
    }
    const errors = issues.filter((i) => i.level === 'error').length;
    const warnings = issues.length - errors;
    return {
      file: shown,
      frames: frames.map((f) => f.name),
      lint:
        issues.length === 0
          ? 'no problems'
          : `${errors} ${errors === 1 ? 'error' : 'errors'} and ${warnings} ${warnings === 1 ? 'warning' : 'warnings'} left`,
    };
  }
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const at = text.lastIndexOf('\n', max);
  return `${text.slice(0, at > max / 2 ? at : max).trimEnd()}\n… (cut to fit: read the rest with fs_read or design_read)`;
}

/** A design's name from its file: `Site` for `design/site.design`. */
function titleOf(file: string): string {
  const name = file
    .split('/')
    .at(-1)!
    .replace(/\.design$/, '')
    .replace(/-/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function value(raw: unknown): string {
  if (raw === null || raw === undefined) return 'removed';
  if (typeof raw === 'string') return raw.length > 80 ? `"${raw.slice(0, 79)}…"` : raw;
  return JSON.stringify(raw);
}

/**
 * The user's edits as lines for their clank, by what each changed, so a later change to the same
 * thing replaces the line rather than adding one.
 */
export function editLines(ops: Op[], before: Studio, after: Studio): [key: string, line: string][] {
  const lines: [string, string][] = [];
  const named = (id: string) => {
    const node = findNode(after.design, id) ?? findNode(before.design, id);
    return node ? `[${id}] "${node.name}"` : `[${id}]`;
  };
  for (const op of ops) {
    switch (op.op) {
      case 'update':
        for (const [prop, raw] of Object.entries(op.set)) {
          lines.push([`${op.id}.${prop}`, `${named(op.id)} ${prop} → ${value(raw)}`]);
        }
        break;
      case 'insert':
        lines.push([`${op.node.id}.+`, `added ${nodeLine(op.node, after.design, 60)}`]);
        break;
      case 'remove':
        lines.push([`${op.id}.-`, `deleted ${named(op.id)}`]);
        break;
      case 'move': {
        const located = locate(after.design, op.id);
        lines.push([
          `${op.id}.>`,
          `moved ${named(op.id)}${located ? ` to ${nodePath(located)}` : ''}`,
        ]);
        break;
      }
      case 'link':
        lines.push([
          `${op.from}.link`,
          op.to ? `linked ${named(op.from)} to ${named(op.to)}` : `unlinked ${named(op.from)}`,
        ]);
        break;
      case 'token.set':
        lines.push([
          `token:${op.token.path}`,
          `token {${op.token.path}} → ${valueText(op.token.type, op.token.value)}${Object.entries(
            op.token.modes ?? {},
          )
            .map(([mode, v]) => `, ${mode} ${valueText(op.token.type, v)}`)
            .join('')}`,
        ]);
        break;
      case 'token.remove':
        lines.push([`token:${op.path}`, `deleted the token {${op.path}}`]);
        break;
      case 'token.rename':
        lines.push([`token:${op.to}`, `renamed the token {${op.path}} to {${op.to}}`]);
        break;
      case 'component.add':
        lines.push([`component:${op.component.id}`, `added the component ${op.component.name}`]);
        break;
      case 'component.remove':
        lines.push([`component:${op.id}`, `deleted a component (${op.id})`]);
        break;
      case 'component.update':
        lines.push([`component:${op.id}`, `changed the component ${op.set.name ?? op.id}`]);
        break;
      case 'variant.add':
      case 'variant.remove':
      case 'variant.rename':
        lines.push([`component:${op.component}`, `changed the variants of ${op.component}`]);
        break;
      case 'page.add':
        lines.push([`page:${op.page.id}`, `added the page "${op.page.name}"`]);
        break;
      case 'page.remove':
        lines.push([`page:${op.id}`, `deleted a page (${op.id})`]);
        break;
      case 'page.update':
        lines.push([`page:${op.id}`, `renamed a page to "${op.name}"`]);
        break;
      default:
        break;
    }
  }
  return lines;
}
