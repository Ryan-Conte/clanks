import { fontStack } from './fonts';
import { iconShapes } from './icons';
import {
  type Component,
  type Design,
  type FrameNode,
  type Length,
  type Node,
  type Size,
  isRef,
  refPath,
} from './schema';
import { TYPOGRAPHY_PARTS, type TokenSet, cssVar, cssVariables } from './tokens';
import { findVariant } from './tree';

/** What drawing a design needs besides the design itself. */
export interface RenderContext {
  design: Pick<Design, 'components'>;
  /**
   * Turns an image's path into an address an `<img>` can load, such as a data URL. Null, or no
   * function at all, draws the image's placeholder.
   */
  asset?: ((src: string) => string | null) | undefined;
}

/**
 * A layer as the browser draws it: one element with inline styles. Studio's canvas makes React
 * elements from these and the frame renderer makes HTML, so both draw exactly the same thing.
 */
export interface RenderNode {
  /** Unique in one drawing: the layer's id, after the ids of the instances it's inside. */
  key: string;
  /** The layer a click on it selects: itself, or the instance it's part of. */
  id: string;
  node: Node;
  tag: 'div' | 'img' | 'svg';
  /** CSS, with property names as React writes them: `flexDirection`. */
  style: Record<string, string>;
  attrs?: Record<string, string>;
  text?: string;
  /** An icon's shapes, from the built-in set. */
  inner?: string;
  /**
   * The fill drawn behind what's inside it. An instance has its component's, which the instance
   * layer itself doesn't say.
   */
  fill?: string;
  children: RenderNode[];
}

/** How a layer's parent places it: freely on a page or in a frame without layout, or in a row or column. */
export type Flow = 'free' | 'row' | 'col';

interface Scope {
  prefix: string;
  /** The outermost instance being drawn, which a click selects. */
  instance: string | null;
  props: Record<string, string | boolean>;
  depth: number;
}

const TOP: Scope = { prefix: '', instance: null, props: {}, depth: 0 };

const px = (value: Length | Size): string =>
  typeof value === 'number' ? `${value}px` : isRef(value) ? `var(${cssVar(refPath(value))})` : '';

/** A colour, a shadow or a font as CSS: a token becomes its custom property. */
const css = (value: string): string => (isRef(value) ? `var(${cssVar(refPath(value))})` : value);

function placement(node: Node, flow: Flow, style: Record<string, string>): void {
  const free = flow === 'free' || node.absolute === true;
  if (free) {
    style.position = 'absolute';
    style.left = `${node.x ?? 0}px`;
    style.top = `${node.y ?? 0}px`;
  } else {
    style.position = 'relative';
  }
  const { w, h } = node;
  if (w === 'fill') {
    if (free) style.width = '100%';
    else if (flow === 'row') {
      style.flex = '1 1 0';
      style.minWidth = '0';
    } else style.alignSelf = 'stretch';
  } else if (w !== undefined && w !== 'hug') {
    style.width = px(w);
    style.flexShrink = '0';
  }
  if (h === 'fill') {
    if (free) style.height = '100%';
    else if (flow === 'col') {
      style.flex = '1 1 0';
      style.minHeight = '0';
    } else style.alignSelf = 'stretch';
  } else if (h !== undefined && h !== 'hug') {
    style.height = px(h);
    style.flexShrink = '0';
  }
  if (node.opacity !== undefined) {
    style.opacity = typeof node.opacity === 'number' ? String(node.opacity) : css(node.opacity);
  }
}

function box(
  node: {
    fill?: string | undefined;
    stroke?: string | undefined;
    strokeWidth?: Length | undefined;
    radius?: Length | undefined;
    shadow?: string | undefined;
  },
  style: Record<string, string>,
): void {
  if (node.fill) style.background = css(node.fill);
  if (node.stroke) style.border = `${px(node.strokeWidth ?? 1)} solid ${css(node.stroke)}`;
  if (node.radius !== undefined) style.borderRadius = px(node.radius);
  if (node.shadow) style.boxShadow = css(node.shadow);
}

const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
const JUSTIFY = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
};

function frameStyle(node: FrameNode, style: Record<string, string>): void {
  box(node, style);
  if (node.clip) style.overflow = 'hidden';
  const layout = node.layout ?? 'none';
  if (layout === 'none') return;
  style.display = 'flex';
  style.flexDirection = layout === 'row' ? 'row' : 'column';
  style.alignItems = ALIGN[node.align ?? 'start'];
  style.justifyContent = JUSTIFY[node.justify ?? 'start'];
  if (node.gap !== undefined) style.gap = px(node.gap);
  if (node.wrap) style.flexWrap = 'wrap';
  if (node.pad !== undefined) {
    style.padding = Array.isArray(node.pad) ? node.pad.map(px).join(' ') : px(node.pad);
  }
}

function textStyle(node: Extract<Node, { type: 'text' }>, style: Record<string, string>): void {
  style.whiteSpace = 'pre-wrap';
  style.overflowWrap = 'break-word';
  if (node.style) {
    const name = cssVar(refPath(node.style));
    for (const [part, property] of TYPOGRAPHY_PARTS) style[part] = `var(${name}-${property})`;
  }
  if (node.font) style.fontFamily = isRef(node.font) ? css(node.font) : fontStack(node.font);
  if (node.size !== undefined) style.fontSize = px(node.size);
  if (node.weight !== undefined) {
    style.fontWeight = typeof node.weight === 'number' ? String(node.weight) : css(node.weight);
  }
  if (node.lineHeight !== undefined) {
    style.lineHeight =
      typeof node.lineHeight === 'number' ? String(node.lineHeight) : css(node.lineHeight);
  }
  if (node.letterSpacing !== undefined) style.letterSpacing = px(node.letterSpacing);
  if (node.color) style.color = css(node.color);
  if (node.textAlign) style.textAlign = node.textAlign;
}

/** Something that couldn't be drawn, shown where it would have been. */
function missing(node: Node, key: string, id: string, flow: Flow, label: string): RenderNode {
  const style: Record<string, string> = {
    boxSizing: 'border-box',
    padding: '6px 10px',
    border: '1px dashed #e5484d',
    borderRadius: '6px',
    color: '#e5484d',
    font: '12px/1.3 system-ui, sans-serif',
    background: 'rgba(229, 72, 77, 0.08)',
  };
  placement(node, flow, style);
  return { key, id, node, tag: 'div', style, text: label, children: [] };
}

const STRIPES =
  'repeating-linear-gradient(135deg, rgba(128,128,128,0.16) 0 10px, rgba(128,128,128,0.08) 10px 20px)';

/**
 * Draws a layer and everything in it. Null for a hidden layer, or one a component property
 * switches off.
 */
export function renderNode(
  node: Node,
  flow: Flow,
  ctx: RenderContext,
  scope: Scope = TOP,
): RenderNode | null {
  if (node.hidden) return null;
  if (node.showIf && scope.props[node.showIf] === false) return null;
  const key = `${scope.prefix}${node.id}`;
  const id = scope.instance ?? node.id;
  const style: Record<string, string> = { boxSizing: 'border-box' };
  placement(node, flow, style);
  const leaf = (extra: Partial<RenderNode> = {}): RenderNode => ({
    key,
    id,
    node,
    tag: 'div',
    style,
    children: [],
    ...extra,
  });

  switch (node.type) {
    case 'frame': {
      frameStyle(node, style);
      const inner: Flow =
        (node.layout ?? 'none') === 'none' ? 'free' : node.layout === 'row' ? 'row' : 'col';
      const children = node.children
        .map((child) => renderNode(child, inner, ctx, scope))
        .filter((child): child is RenderNode => child !== null);
      return leaf({ children, ...(node.fill ? { fill: node.fill } : {}) });
    }
    case 'text': {
      textStyle(node, style);
      const bound = node.bind ? scope.props[node.bind] : undefined;
      return leaf({ text: typeof bound === 'string' ? bound : node.text });
    }
    case 'rect':
    case 'ellipse': {
      box(node, style);
      if (node.w === undefined) style.width = '100px';
      if (node.h === undefined) style.height = '100px';
      if (node.type === 'ellipse') style.borderRadius = '50%';
      style.flexShrink = '0';
      return leaf(node.fill ? { fill: node.fill } : {});
    }
    case 'line': {
      const stroke = `${px(node.strokeWidth ?? 1)} solid ${css(node.stroke ?? '#888888')}`;
      if (node.vertical) {
        style.width = '0';
        style.borderLeft = stroke;
        if (node.h === undefined) style.height = '100px';
      } else {
        style.height = '0';
        style.borderTop = stroke;
        if (node.w === undefined) style.width = '100px';
      }
      style.flexShrink = '0';
      return leaf();
    }
    case 'image': {
      if (node.w === undefined) style.width = '240px';
      if (node.h === undefined) style.height = '160px';
      if (node.radius !== undefined) style.borderRadius = px(node.radius);
      const url = node.src ? (ctx.asset?.(node.src) ?? null) : null;
      if (url) {
        style.objectFit = node.fit ?? 'cover';
        style.display = 'block';
        return leaf({ tag: 'img', attrs: { src: url, alt: node.alt ?? '', draggable: 'false' } });
      }
      Object.assign(style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '12px',
        overflow: 'hidden',
        background: STRIPES,
        color: 'rgba(128,128,128,0.95)',
        font: '12px/1.35 system-ui, sans-serif',
        textAlign: 'center',
      });
      return leaf({
        text: node.alt ? `Image: ${node.alt}` : node.src ? `Missing: ${node.src}` : 'Image',
      });
    }
    case 'vector': {
      style.display = 'block';
      return leaf({
        tag: 'img',
        attrs: {
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(node.svg)}`,
          alt: node.name,
          draggable: 'false',
        },
      });
    }
    case 'icon': {
      const shapes = iconShapes(node.icon);
      if (!shapes) return missing(node, key, id, flow, `No icon "${node.icon}"`);
      const size = px(node.size ?? 24);
      style.width = size;
      style.height = size;
      style.flexShrink = '0';
      style.display = 'block';
      if (node.color) style.color = css(node.color);
      return leaf({
        tag: 'svg',
        attrs: {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': '2',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
        inner: shapes,
      });
    }
    case 'instance': {
      const component = ctx.design.components.find((c) => c.id === node.component);
      if (!component || scope.depth > 8) {
        return missing(
          node,
          key,
          id,
          flow,
          component ? 'Component inside itself' : 'Missing component',
        );
      }
      const variant = findVariant(component, node.variant);
      const root = {
        ...variant.root,
        x: node.x,
        y: node.y,
        w: node.w ?? variant.root.w,
        h: node.h ?? variant.root.h,
        absolute: node.absolute,
        opacity: node.opacity ?? variant.root.opacity,
        hidden: false,
      } as Node;
      const drawn = renderNode(root, flow, ctx, {
        prefix: `${key}/`,
        instance: scope.instance ?? node.id,
        props: { ...defaultProps(component), ...node.props },
        depth: scope.depth + 1,
      });
      // The instance stands where its component's root is drawn.
      return drawn ? { ...drawn, key, node } : null;
    }
  }
}

/** A component's properties at their defaults. */
export function defaultProps(component: Component): Record<string, string | boolean> {
  return Object.fromEntries(component.props.map((p) => [p.name, p.default]));
}

/** A top-level frame drawn at the origin, as it would be on its own page. */
export function renderFrame(frame: Node, ctx: RenderContext): RenderNode | null {
  const drawn = renderNode({ ...frame, x: 0, y: 0, absolute: false }, 'free', ctx);
  if (!drawn) return null;
  return { ...drawn, style: { ...drawn.style, position: 'relative', left: '0px', top: '0px' } };
}

/**
 * The styles of the element a design is drawn in: every token as a custom property in one mode,
 * and the type a layer gets when it sets none.
 */
export function rootStyle(tokens: TokenSet, mode: string): Record<string, string> {
  return {
    ...cssVariables(tokens, mode),
    fontFamily: 'system-ui, sans-serif',
    fontSize: '16px',
    lineHeight: '1.4',
    color: '#111111',
    textAlign: 'left',
  };
}

/** `flex-direction` for `flexDirection`. Custom properties are left as they are. */
export function cssName(property: string): string {
  return property.startsWith('--')
    ? property
    : property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Styles as the text of a `style` attribute or a rule's body. */
export function styleText(style: Record<string, string>, separator = ' '): string {
  return Object.entries(style)
    .map(([property, value]) => `${cssName(property)}: ${value};`)
    .join(separator);
}
