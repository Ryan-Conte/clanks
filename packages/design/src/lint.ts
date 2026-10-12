import { type Rgba, contrast, over, parseColor } from './color';
import { bundledFont, firstFamily } from './fonts';
import { iconShapes, iconsLike } from './icons';
import { nodeRefs } from './ops';
import { type RenderNode, renderFrame, renderNode } from './render';
import { DEFAULT_NAMES, type Design, type Node, isRef } from './schema';
import {
  PROP_TOKEN_TYPES,
  type TokenSet,
  findToken,
  resolveColor,
  resolveNumber,
  resolveTypography,
  suggest,
} from './tokens';
import { walk } from './tree';

/** Where a drawn layer is, measured by a browser: its box in its frame, and how big its content is. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Its content's size, which is bigger than the box when it overflows. */
  sw: number;
  sh: number;
}

/** A frame's measured boxes, by each drawn layer's key. */
export type Geometry = Record<string, Box>;

export interface Issue {
  level: 'error' | 'warning';
  rule: string;
  /** The layer it's about. */
  id: string;
  name: string;
  /** The top-level frame or component it's in. */
  where: string;
  message: string;
}

export interface LintOptions {
  /** Check only these top-level frames, by id. */
  frames?: string[] | undefined;
  /** Each frame's measured boxes, by frame id. Without them, the rules that need sizes are skipped. */
  geometry?: Record<string, Geometry> | undefined;
  /** Whether an image's file is there. */
  hasAsset?: ((src: string) => boolean) | undefined;
}

/** Text smaller than this is an error; body copy smaller than `BODY_PX` is a warning. */
const MIN_PX = 11;
const BODY_PX = 16;
/** WCAG AA: 4.5:1, or 3:1 for large text. */
const AA = 4.5;
const AA_LARGE = 3;
/** The smallest thing a finger hits reliably. */
const TAP_PX = 44;
/** Frames this narrow are for phones. */
const MOBILE_PX = 600;
/** The sizes social graphics are made at: square, portrait, story, landscape and link preview. */
const GRAPHIC_SIZES = ['1080x1080', '1080x1350', '1080x1920', '1600x900', '1200x630'];
/** A graphic is seen at a third of its size in a feed, so its headline is at least this big. */
const GRAPHIC_HEADLINE_PX = 56;

const INTERACTIVE =
  /\b(button|btn|link|input|field|checkbox|radio|switch|toggle|tab|chip|select|cta)\b/i;

const RAW_COLOURS = new Set(['transparent', 'none', 'inherit', 'currentcolor']);

/**
 * Checks a design the way a careful reviewer would: values that should be tokens, text that's
 * hard to read, things that don't fit, targets too small to tap, broken instances and layers
 * nobody named. Clanks that can't see pictures design against this.
 */
export function lint(design: Design, tokens: TokenSet, options: LintOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const only = options.frames ? new Set(options.frames) : null;
  const ctx = { design };

  for (const page of design.pages) {
    for (const top of page.children) {
      if (only && !only.has(top.id)) continue;
      const add = (issue: Omit<Issue, 'where'>) => issues.push({ ...issue, where: top.name });
      for (const node of walk(top)) staticRules(node, design, tokens, options, add);
      const drawn = renderFrame(top, ctx);
      if (!drawn) continue;
      contrastRule(drawn, tokens, WHITE, add);
      const geometry = options.geometry?.[top.id];
      if (geometry) geometryRules(drawn, design, geometry, add);
    }
  }
  if (!only) {
    // A frame is found by its name: by the posts that show it and the tickets that build it.
    const named = new Map<string, Node[]>();
    for (const page of design.pages) {
      for (const top of page.children) {
        if (top.type === 'frame') named.set(top.name, [...(named.get(top.name) ?? []), top]);
      }
    }
    for (const [name, frames] of named) {
      if (frames.length < 2) continue;
      issues.push({
        level: 'error',
        rule: 'duplicate-frame',
        id: frames.at(-1)!.id,
        name,
        where: name,
        message: `is the name of ${frames.length} frames (${frames.map((f) => f.id).join(', ')}). A frame is found by its name: delete the ones this one replaced with design_delete, or rename them.`,
      });
    }
    for (const component of design.components) {
      for (const variant of component.variants) {
        const where = `${component.name} (${variant.name})`;
        const add = (issue: Omit<Issue, 'where'>) => issues.push({ ...issue, where });
        for (const node of walk(variant.root)) staticRules(node, design, tokens, options, add);
        const drawn = renderNode({ ...variant.root, x: 0, y: 0 }, 'free', ctx);
        // A component has no background of its own until it's placed, so only text over a fill counts.
        if (drawn) contrastRule(drawn, tokens, null, add);
      }
    }
  }
  return dedupe(issues);
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.where}|${issue.id}|${issue.rule}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type Add = (issue: Omit<Issue, 'where'>) => void;

function staticRules(
  node: Node,
  design: Design,
  tokens: TokenSet,
  options: LintOptions,
  add: Add,
): void {
  const about = { id: node.id, name: node.name };
  const record = node as unknown as Record<string, unknown>;

  for (const { prop, path } of nodeRefs(node)) {
    const token = findToken(tokens, path);
    if (!token) {
      add({
        ...about,
        level: 'error',
        rule: 'missing-token',
        message: `${prop} uses {${path}}, which isn't a token${suggest(path, tokens)}.`,
      });
      continue;
    }
    const wanted = PROP_TOKEN_TYPES[prop];
    if (wanted && !wanted.includes(token.type)) {
      add({
        ...about,
        level: 'error',
        rule: 'wrong-token',
        message: `${prop} takes a ${wanted[0]} token, and {${path}} is a ${token.type}.`,
      });
    }
  }

  const raw: string[] = [];
  for (const prop of ['fill', 'stroke', 'color'] as const) {
    const value = record[prop];
    if (typeof value === 'string' && !isRef(value) && !RAW_COLOURS.has(value.toLowerCase())) {
      raw.push(`${prop} ${value}`);
    }
  }
  for (const prop of ['gap', 'radius'] as const) {
    const value = record[prop];
    if (typeof value === 'number' && value !== 0) raw.push(`${prop} ${value}`);
  }
  const pad = record.pad;
  if (
    (Array.isArray(pad) ? (pad as unknown[]) : [pad]).some((p) => typeof p === 'number' && p !== 0)
  ) {
    raw.push(`pad ${Array.isArray(pad) ? pad.join(' ') : String(pad)}`);
  }
  if (typeof record.shadow === 'string' && !isRef(record.shadow) && record.shadow !== 'none') {
    raw.push('a shadow written by hand');
  }
  if (node.type === 'text') {
    const byHand = (['size', 'font', 'weight', 'lineHeight', 'letterSpacing'] as const).filter(
      (prop) => node[prop] !== undefined && !isRef(node[prop]),
    );
    if (byHand.length > 0) {
      raw.push(
        node.style
          ? `${byHand.join(', ')} set by hand over ${node.style}`
          : `type set by hand (${byHand.map((p) => `${p} ${String(node[p])}`).join(', ')}); use a text style such as {type.body}`,
      );
    }
    if (!node.style && byHand.length === 0) {
      add({
        ...about,
        level: 'warning',
        rule: 'no-text-style',
        message:
          'has no text style, so it falls back to the system font at 16px. Set style to a token such as {type.body}.',
      });
    }
    if (
      node.font &&
      !isRef(node.font) &&
      !bundledFont(firstFamily(node.font)) &&
      !/^(system-ui|sans-serif|serif|monospace)$/i.test(firstFamily(node.font))
    ) {
      add({
        ...about,
        level: 'warning',
        rule: 'font',
        message: `uses the font "${node.font}", which doesn't ship with Studio, so it's drawn in a fallback.`,
      });
    }
    if (/lorem ipsum|dolor sit amet/i.test(node.text)) {
      add({
        ...about,
        level: 'warning',
        rule: 'placeholder',
        message: 'is lorem ipsum. Use the real copy, or mark it [TODO: what is needed].',
      });
    }
    if (node.text.trim() === '' && !node.bind) {
      add({ ...about, level: 'warning', rule: 'empty-text', message: 'has no text.' });
    }
  }
  if (raw.length > 0) {
    add({
      ...about,
      level: 'error',
      rule: 'raw-value',
      message: `has values that aren't tokens: ${raw.join('; ')}. Use a token, adding one with design_tokens_set if none fits.`,
    });
  }

  if (
    node.name === DEFAULT_NAMES[node.type] &&
    ['frame', 'rect', 'ellipse', 'image', 'vector'].includes(node.type)
  ) {
    add({
      ...about,
      level: 'warning',
      rule: 'unnamed',
      message: `is still called "${node.name}". Name it for what it is.`,
    });
  }

  if (node.type === 'frame' && (node.layout ?? 'none') === 'none') {
    const loose = node.children.filter((c) => c.x === undefined && c.y === undefined && !c.hidden);
    if (loose.length > 1) {
      add({
        ...about,
        level: 'error',
        rule: 'no-layout',
        message: `has no auto layout and ${loose.length} layers without a position, so they sit on top of each other. Set layout to col or row.`,
      });
    }
  }

  if (node.type === 'instance') {
    const component = design.components.find((c) => c.id === node.component);
    if (!component) {
      add({
        ...about,
        level: 'error',
        rule: 'detached-instance',
        message: "is an instance of a component that's gone. Replace it, or delete it.",
      });
    } else {
      if (node.variant && !component.variants.some((v) => v.name === node.variant)) {
        add({
          ...about,
          level: 'error',
          rule: 'detached-instance',
          message: `uses the variant "${node.variant}", which ${component.name} doesn't have. Its variants: ${component.variants.map((v) => v.name).join(', ')}.`,
        });
      }
      for (const name of Object.keys(node.props ?? {})) {
        if (!component.props.some((p) => p.name === name)) {
          add({
            ...about,
            level: 'warning',
            rule: 'unknown-property',
            message: `sets "${name}", which isn't a property of ${component.name}.`,
          });
        }
      }
    }
  }

  if (node.type === 'icon' && !iconShapes(node.icon)) {
    const close = iconsLike(node.icon);
    add({
      ...about,
      level: 'error',
      rule: 'icon',
      message: `uses the icon "${node.icon}", which isn't in the built-in set.${close.length ? ` Close ones: ${close.join(', ')}.` : ''}`,
    });
  }

  if (node.type === 'image') {
    if (node.src && options.hasAsset && !options.hasAsset(node.src)) {
      add({
        ...about,
        level: 'error',
        rule: 'image',
        message: `points at ${node.src}, which isn't in the project. Use a file that is, or leave src out for a placeholder.`,
      });
    }
    if (!node.alt?.trim()) {
      add({
        ...about,
        level: 'warning',
        rule: 'image-alt',
        message: 'has no alt saying what the image shows, or should show.',
      });
    }
  }
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/** Text against what's behind it, in every mode. `background` null means not known yet. */
function contrastRule(
  drawn: RenderNode,
  tokens: TokenSet,
  background: Rgba | null,
  add: Add,
): void {
  const modes = tokens.modes.length > 0 ? tokens.modes : ['light'];
  // Each failing text is reported once, with the modes it fails in.
  const failures = new Map<string, { node: RenderNode; lines: string[] }>();
  for (const mode of modes) {
    const visit = (node: RenderNode, behind: Rgba | null) => {
      let here = behind;
      // What's drawn, not what the layer says: an instance's fill is its component's.
      if (node.fill !== undefined) {
        const colour = resolveColor(tokens, node.fill, mode);
        const parsed = colour ? parseColor(colour) : null;
        // A fill that can't be read, such as a gradient, leaves what's behind unknown.
        here = parsed ? (behind ? over(parsed, behind) : parsed.a === 1 ? parsed : null) : null;
      }
      if (node.node.type === 'image' || node.node.type === 'vector') return;
      if (node.node.type === 'text' && here) {
        const text = node.node;
        const colour = text.color ? resolveColor(tokens, text.color, mode) : '#111111';
        const parsed = colour ? parseColor(colour) : null;
        if (parsed) {
          const style = text.style ? resolveTypography(tokens, text.style, mode) : null;
          const size = resolveNumber(tokens, text.size, mode) ?? style?.fontSize ?? 16;
          const weight = resolveNumber(tokens, text.weight, mode) ?? style?.fontWeight ?? 400;
          const large = size >= 24 || (size >= 18.66 && weight >= 700);
          const needed = large ? AA_LARGE : AA;
          const ratio = contrast(over(parsed, here), here);
          if (ratio < needed) {
            const entry = failures.get(node.key) ?? { node, lines: [] };
            entry.lines.push(
              `${ratio.toFixed(1)}:1 in ${mode} (${text.color ?? '#111111'} on ${describe(here)}, needs ${needed}:1)`,
            );
            failures.set(node.key, entry);
          }
        }
      }
      for (const child of node.children) visit(child, here);
    };
    visit(drawn, background);
  }
  for (const { node, lines } of failures.values()) {
    const inside = node.id !== node.node.id ? ` (the text "${node.node.name}" inside it)` : '';
    add({
      id: node.id,
      name: node.id !== node.node.id ? `instance ${node.id}` : node.node.name,
      level: 'error',
      rule: 'contrast',
      message: `is hard to read${inside}: contrast ${lines.join('; ')}.`,
    });
  }
  // Sizes don't depend on what's behind.
  const sizes = (node: RenderNode) => {
    if (node.node.type === 'text' && node.id === node.node.id) {
      const text = node.node;
      const mode = modes[0]!;
      const style = text.style ? resolveTypography(tokens, text.style, mode) : null;
      const size = resolveNumber(tokens, text.size, mode) ?? style?.fontSize ?? 16;
      if (size < MIN_PX) {
        add({
          id: text.id,
          name: text.name,
          level: 'error',
          rule: 'text-size',
          message: `is ${size}px, too small to read. Nothing goes below ${MIN_PX}px.`,
        });
      } else if (size < BODY_PX && text.text.length > 80) {
        add({
          id: text.id,
          name: text.name,
          level: 'warning',
          rule: 'text-size',
          message: `is body copy at ${size}px. Body text is at least ${BODY_PX}px.`,
        });
      }
    }
    node.children.forEach(sizes);
  };
  sizes(drawn);
  // A graphic for a feed needs a headline that reads when the graphic is shown small.
  const top = drawn.node;
  if (top.type === 'frame' && GRAPHIC_SIZES.includes(`${String(top.w)}x${String(top.h)}`)) {
    let biggest = 0;
    const measure = (node: RenderNode) => {
      if (node.node.type === 'text') {
        const text = node.node;
        const style = text.style ? resolveTypography(tokens, text.style, modes[0]!) : null;
        const size = resolveNumber(tokens, text.size, modes[0]!) ?? style?.fontSize ?? 16;
        biggest = Math.max(biggest, size);
      }
      node.children.forEach(measure);
    };
    measure(drawn);
    if (biggest > 0 && biggest < GRAPHIC_HEADLINE_PX) {
      add({
        id: top.id,
        name: top.name,
        level: 'warning',
        rule: 'graphic-type',
        message: `is a graphic people see small in a feed, and its biggest text is ${biggest}px. Make the headline at least ${GRAPHIC_HEADLINE_PX}px.`,
      });
    }
  }
}

function describe(colour: Rgba): string {
  const part = (value: number) => Math.round(value).toString(16).padStart(2, '0');
  return `#${part(colour.r)}${part(colour.g)}${part(colour.b)}`;
}

function geometryRules(drawn: RenderNode, design: Design, geometry: Geometry, add: Add): void {
  const frame = geometry[drawn.key];
  const mobile = frame !== undefined && frame.w <= MOBILE_PX;
  const linked = new Set(design.links.map((l) => l.from));
  const round = (value: number) => Math.round(value);

  const visit = (node: RenderNode, parent: RenderNode | null) => {
    const box = geometry[node.key];
    if (!box) return;
    const own = node.id === node.node.id || node.key === node.id;
    const about = { id: node.id, name: own ? node.node.name : `instance ${node.id}` };

    if (own && (box.w < 0.5 || box.h < 0.5) && node.node.type === 'frame') {
      add({
        ...about,
        level: 'warning',
        rule: 'no-size',
        message:
          'has no size, so it draws as nothing. Give it a size, or auto layout so it fits what it holds.',
      });
    }

    const parentBox = parent ? geometry[parent.key] : undefined;
    if (parent && parentBox && node.node.absolute !== true) {
      const right = box.x + box.w - (parentBox.x + parentBox.w);
      const bottom = box.y + box.h - (parentBox.y + parentBox.h);
      const left = parentBox.x - box.x;
      const top = parentBox.y - box.y;
      const worst = Math.max(right, bottom, left, top);
      if (worst > 1.5) {
        const side = worst === right ? 'wider' : worst === bottom ? 'taller' : 'outside';
        add({
          ...about,
          level: 'error',
          rule: 'overflow',
          message:
            side === 'outside'
              ? `sits ${round(worst)}px outside its frame "${parent.node.name}".`
              : `is ${round(worst)}px ${side} than the room in its frame "${parent.node.name}"${parent.node.type === 'frame' && parent.node.clip ? ', which cuts it off' : ''}. Let it fill and wrap, or make the frame hug it.`,
        });
      }
    }
    if (node.node.type === 'text' && (box.sw - box.w > 1.5 || box.sh - box.h > 1.5)) {
      add({
        ...about,
        level: 'error',
        rule: 'overflow',
        message: `has more text than fits its ${round(box.w)}×${round(box.h)} box. Set its height to hug, or shorten it.`,
      });
    }

    const interactive =
      linked.has(node.node.id) ||
      (node.node.type === 'instance' &&
        INTERACTIVE.test(
          design.components.find((c) => c.id === (node.node as { component: string }).component)
            ?.name ?? '',
        )) ||
      (own && node.node.type === 'frame' && INTERACTIVE.test(node.node.name));
    if (mobile && interactive && (box.w < TAP_PX - 0.5 || box.h < TAP_PX - 0.5)) {
      add({
        ...about,
        level: 'error',
        rule: 'tap-target',
        message: `is ${round(box.w)}×${round(box.h)}, smaller than the ${TAP_PX}×${TAP_PX} a finger needs on mobile.`,
      });
    }

    // Free-placed text layers that land on each other can't both be read.
    if (node.node.type === 'frame' && (node.node.layout ?? 'none') === 'none') {
      const texts = node.children.filter((c) => c.node.type === 'text' && geometry[c.key]);
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
          const a = geometry[texts[i]!.key]!;
          const b = geometry[texts[j]!.key]!;
          const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (w > 2 && h > 2) {
            add({
              id: texts[j]!.id,
              name: texts[j]!.node.name,
              level: 'warning',
              rule: 'overlap',
              message: `overlaps the text "${texts[i]!.node.name}".`,
            });
          }
        }
      }
    }
    // What's inside an instance is its component's business.
    if (node.node.type === 'instance') return;
    for (const child of node.children) visit(child, node);
  };
  visit(drawn, null);
}

/** Issues as a clank reads them: grouped by frame, errors first, each saying which layer and why. */
export function issuesText(
  issues: Issue[],
  checked: { frames: number; measured: boolean },
): string {
  const what = `${checked.frames} ${checked.frames === 1 ? 'frame' : 'frames'}`;
  const note = checked.measured
    ? ''
    : " Sizes weren't measured here, so overflow and tap targets weren't checked.";
  if (issues.length === 0) return `No problems in ${what}.${note}`;
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;
  const lines = [
    `${count(errors, 'error')} and ${count(warnings, 'warning')} in ${what}. Fix every error; fix a warning or say in your notes why it stays.${note}`,
  ];
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) groups.set(issue.where, [...(groups.get(issue.where) ?? []), issue]);
  for (const [where, list] of groups) {
    lines.push('', `${where}:`);
    const sorted = [...list].sort((a, b) =>
      a.level === b.level ? 0 : a.level === 'error' ? -1 : 1,
    );
    for (const issue of sorted) {
      lines.push(`- ${issue.level} [${issue.id}] "${issue.name}" ${issue.message}`);
    }
  }
  return lines.join('\n');
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
