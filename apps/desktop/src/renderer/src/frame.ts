import type { Geometry } from '@clanks/design';
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

/**
 * Lays a frame's HTML out and measures it once its fonts and images are in. The HTML is made by
 * the design engine, which escapes everything a design holds.
 */
window.clanksDraw = async (html) => {
  const root = document.getElementById('root')!;
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
