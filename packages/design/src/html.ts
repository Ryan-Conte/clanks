import { type RenderContext, type RenderNode, renderFrame, rootStyle, styleText } from './render';
import type { Design, Node } from './schema';
import type { TokenSet } from './tokens';

const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (text: string) => escapeText(text).replace(/"/g, '&quot;');

/** A drawn layer as HTML. Everything a design holds is escaped; only built-in icons go in as markup. */
export function toHtml(render: RenderNode): string {
  const attrs = Object.entries({
    ...render.attrs,
    'data-key': render.key,
    'data-id': render.id,
    style: styleText(render.style),
  })
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join('');
  if (render.tag === 'img') return `<img${attrs}>`;
  if (render.tag === 'svg')
    return `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${render.inner ?? ''}</svg>`;
  const inner =
    render.text !== undefined ? escapeText(render.text) : render.children.map(toHtml).join('');
  return `<div${attrs}>${inner}</div>`;
}

export interface FrameHtmlOptions extends RenderContext {
  design: Design;
  tokens: TokenSet;
  mode: string;
}

/**
 * One frame as a piece of HTML: an element carrying the tokens as custom properties, with the
 * frame inside it. What a browser draws from this is what Studio shows.
 */
export function frameHtml(frame: Node, options: FrameHtmlOptions): string {
  const drawn = renderFrame(frame, options);
  const style = styleText({
    ...rootStyle(options.tokens, options.mode),
    position: 'relative',
    display: 'inline-block',
    verticalAlign: 'top',
  });
  return `<div data-design-root style="${escapeAttr(style)}">${drawn ? toHtml(drawn) : ''}</div>`;
}

/** A frame as a page of its own, for saving or opening in a browser. */
export function framePage(frame: Node, options: FrameHtmlOptions): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeText(frame.name)}</title>`,
    '<style>html, body { margin: 0; } *, *::before, *::after { box-sizing: border-box; }</style>',
    '</head>',
    `<body>${frameHtml(frame, options)}</body>`,
    '</html>',
  ].join('\n');
}
