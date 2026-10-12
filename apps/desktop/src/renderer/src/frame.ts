import type { Geometry, Painted, PaintedBorder, PaintedLine } from '@clanks/design';
import './fonts.css';

/** What the main process gets back: every layer's box in the frame, and the frame's size. */
interface Measured {
  boxes: Geometry;
  width: number;
  height: number;
}

declare global {
  interface Window {
    clanksDraw: (html: string) => Promise<Measured>;
    /** Lays a frame out and reads back what was painted, for drawing it again as SVG. */
    clanksPaint: (html: string) => Promise<Painted>;
    /** Puts a piece of HTML on the page to be printed, on pages of a size when one is given. */
    clanksPage: (html: string, page: { width: number; height: number } | null) => Promise<void>;
  }
}

const style = document.createElement('style');
style.textContent =
  'html, body { margin: 0; background: transparent; } *, *::before, *::after { box-sizing: border-box; }';
document.head.append(style);

const frames = (count: number) =>
  new Promise<void>((resolve) => {
    // A hidden page may not be given frames, so don't wait on them for long.
    const timer = setTimeout(resolve, 150);
    const step = (left: number) => {
      if (left === 0) {
        clearTimeout(timer);
        resolve();
      } else requestAnimationFrame(() => step(left - 1));
    };
    step(count);
  });

/** Puts HTML on the page and waits for its fonts and images, so it's laid out as it will stay. */
async function layOut(html: string): Promise<HTMLElement> {
  const root = document.getElementById('root')!;
  document.getElementById('page-size')?.remove();
  root.innerHTML = html;
  // Fonts load when text first needs them, which is after a first layout with stand-ins. Ask for
  // each one the frame's text uses, so it's measured and pictured in its own type.
  const wanted = new Map<string, string>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-key]')) {
    if (el.childElementCount > 0 || !el.textContent) continue;
    const font = getComputedStyle(el).font;
    wanted.set(font, `${wanted.get(font) ?? ''}${el.textContent}`.slice(0, 2000));
  }
  await Promise.all(
    [...wanted].map(([font, text]) => document.fonts.load(font, text).catch(() => [])),
  );
  await document.fonts.ready;
  await Promise.all(
    [...root.querySelectorAll('img')].map((img) => img.decode().catch(() => undefined)),
  );
  await frames(2);
  return root;
}

/**
 * Lays a frame's HTML out and measures it once its fonts and images are in. The HTML is made by
 * the design engine, which escapes everything a design holds.
 */
window.clanksDraw = async (html) => {
  const root = await layOut(html);
  const frame = root.querySelector<HTMLElement>('[data-design-root] > *');
  const origin = (frame ?? root).getBoundingClientRect();
  const boxes: Geometry = {};
  for (const el of root.querySelectorAll<HTMLElement>('[data-key]')) {
    const rect = el.getBoundingClientRect();
    // Tall letters reach past a tight line without anything being cut off, so text only counts as
    // overflowing when at least half a line doesn't fit.
    const line = el.childElementCount === 0 ? parseFloat(getComputedStyle(el).lineHeight) || 0 : 0;
    const over = (scroll: number, client: number) => scroll - client > Math.max(1, line / 2);
    boxes[el.dataset.key!] = {
      x: rect.left - origin.left,
      y: rect.top - origin.top,
      w: rect.width,
      h: rect.height,
      sw: el.scrollWidth - el.clientWidth > 1 ? Math.max(rect.width, el.scrollWidth) : rect.width,
      sh: over(el.scrollHeight, el.clientHeight)
        ? Math.max(rect.height, el.scrollHeight)
        : rect.height,
    };
  }
  return { boxes, width: origin.width, height: origin.height };
};

const measurer = document.createElement('canvas').getContext('2d');

/** How far above and below the baseline a font's letters are set, in pixels. */
function fontMetrics(font: string): { ascent: number; descent: number } | null {
  if (!measurer) return null;
  measurer.font = font;
  const metrics = measurer.measureText('Hg');
  return { ascent: metrics.fontBoundingBoxAscent, descent: metrics.fontBoundingBoxDescent };
}

/** A text layer's lines as the browser broke them, each where its letters sit. */
function textLines(el: HTMLElement, origin: DOMRect, font: string): PaintedLine[] {
  const node = el.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return [];
  const text = node.textContent ?? '';
  const metrics = fontMetrics(font);
  const range = document.createRange();
  const lines: { text: string; left: number; right: number; top: number; height: number }[] = [];
  let fresh = true;
  // Letter by letter: the box of each says which line it landed on.
  const letters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
  for (const letter of letters) {
    if (letter.segment === '\n') {
      fresh = true;
      continue;
    }
    range.setStart(node, letter.index);
    range.setEnd(node, letter.index + letter.segment.length);
    const rect = range.getClientRects()[0];
    if (!rect) continue;
    const last = lines.at(-1);
    if (fresh || !last || Math.abs(rect.top - last.top) > last.height / 2) {
      // A space the line broke at hangs off its end, and starts nothing.
      if (!letter.segment.trim() && !fresh) continue;
      lines.push({
        text: letter.segment,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        height: rect.height,
      });
      fresh = false;
    } else {
      last.text += letter.segment;
      last.right = Math.max(last.right, rect.right);
    }
  }
  return lines
    .map((line) => ({ ...line, text: line.text.replace(/\s+$/, '') }))
    .filter((line) => line.text !== '')
    .map((line) => {
      const content = metrics ? metrics.ascent + metrics.descent : line.height;
      const ascent = metrics ? metrics.ascent : line.height * 0.8;
      return {
        text: line.text,
        x: line.left - origin.left,
        baseline: line.top - origin.top + (line.height - content) / 2 + ascent,
        w: line.right - line.left,
      };
    });
}

/** One corner's radius across and down, in pixels: `8px`, `50%` or `8px 4px` as computed. */
function cornerRadius(value: string, w: number, h: number): [number, number] {
  const [across = '0', down = across] = value.split(' ');
  const px = (part: string, of: number) =>
    part.endsWith('%') ? (parseFloat(part) / 100) * of : parseFloat(part) || 0;
  return [Math.min(px(across, w), w / 2), Math.min(px(down, h), h / 2)];
}

function painted(el: HTMLElement | SVGElement, origin: DOMRect): Painted {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const border = (side: 'Top' | 'Right' | 'Bottom' | 'Left'): PaintedBorder => ({
    w: style[`border${side}Style`] === 'none' ? 0 : parseFloat(style[`border${side}Width`]) || 0,
    color: style[`border${side}Color`],
  });
  const node: Painted = {
    key: el.dataset.key ?? '',
    x: rect.left - origin.left,
    y: rect.top - origin.top,
    w: rect.width,
    h: rect.height,
    background: style.backgroundColor,
    borders: [border('Top'), border('Right'), border('Bottom'), border('Left')],
    radius: cornerRadius(style.borderTopLeftRadius, rect.width, rect.height),
    opacity: parseFloat(style.opacity),
    clip: style.overflowX !== 'visible',
    shadow: style.boxShadow === 'none' ? '' : style.boxShadow,
    children: [],
  };
  if (el instanceof HTMLImageElement) {
    const fit = style.objectFit;
    node.image = {
      src: el.currentSrc || el.src,
      fit: fit === 'contain' ? 'contain' : fit === 'fill' ? 'fill' : 'cover',
    };
    return node;
  }
  if (el instanceof SVGElement) {
    node.icon = {
      viewBox: el.getAttribute('viewBox') ?? '0 0 24 24',
      inner: el.innerHTML,
      stroke: style.stroke,
      strokeWidth: String(parseFloat(style.strokeWidth) || 2),
      fill: style.fill,
    };
    return node;
  }
  // The stripes of an image that isn't there yet.
  if (style.backgroundImage !== 'none') node.placeholder = true;
  if (el.childElementCount === 0 && el.textContent) {
    node.text = {
      lines: textLines(el, origin, style.font),
      color: style.color,
      family: style.fontFamily,
      size: parseFloat(style.fontSize),
      weight: style.fontWeight,
      italic: style.fontStyle === 'italic',
      spacing: parseFloat(style.letterSpacing) || 0,
      underline: style.textDecorationLine.includes('underline'),
    };
    return node;
  }
  for (const child of el.children) {
    if ((child instanceof HTMLElement || child instanceof SVGElement) && child.dataset.key) {
      node.children.push(painted(child, origin));
    }
  }
  return node;
}

window.clanksPaint = async (html) => {
  const root = await layOut(html);
  const frame = root.querySelector<HTMLElement>('[data-design-root] > *');
  if (!frame) throw new Error('There is no frame to draw');
  return painted(frame, frame.getBoundingClientRect());
};

window.clanksPage = async (html, page) => {
  await layOut(html);
  if (!page) return;
  // One page the size of the frame, with nothing around it.
  const size = document.createElement('style');
  size.id = 'page-size';
  size.textContent = `@page { size: ${page.width}px ${page.height}px; margin: 0; }`;
  document.head.append(size);
};
