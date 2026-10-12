import {
  type BoardState,
  INITIAL,
  STEPS,
  advance,
  columnsHtml,
  feedHtml,
  needsYouHtml,
  workingText,
} from '../lib/board';

const BEAT = 2600;
/** How long the finished board stays up before the story starts again. */
const REST = 5000;

/** Plays the hero board's story while it's on screen, unless the reader prefers no motion. */
export function playBoard(root: HTMLElement) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const part = (name: string) => root.querySelector<HTMLElement>(`[data-board="${name}"]`);
  const columns = part('columns');
  const feed = part('feed');
  const working = part('working');
  const needs = part('needs');
  if (!columns || !feed || !working || !needs) return;

  let state: BoardState = INITIAL;
  let step = 0;
  let timer: number | undefined;
  let visible = false;

  const draw = (next: BoardState, fresh: Set<string>) => {
    columns.innerHTML = columnsHtml(next, fresh);
    if (next.feed !== state.feed) feed.innerHTML = feedHtml(next);
    working.textContent = workingText(next);
    needs.innerHTML = needsYouHtml(next);
    state = next;
  };

  const tick = () => {
    const current = STEPS[step];
    if (!current) {
      // From the top, fading the board out and back in.
      columns.style.opacity = '0';
      timer = window.setTimeout(() => {
        step = 0;
        draw(INITIAL, new Set());
        columns.style.opacity = '1';
        schedule(BEAT);
      }, 400);
      return;
    }
    const next = advance(state, current);
    const moved = new Set(
      next.cards
        .filter((c) => state.cards.find((p) => p.key === c.key)?.column !== c.column)
        .map((c) => c.key),
    );
    draw(next, moved);
    step += 1;
    schedule(STEPS[step] ? BEAT : REST);
  };

  const schedule = (delay: number) => {
    window.clearTimeout(timer);
    if (visible && !document.hidden) timer = window.setTimeout(tick, delay);
  };

  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    schedule(BEAT);
  }).observe(root);
  document.addEventListener('visibilitychange', () => schedule(BEAT));
}
