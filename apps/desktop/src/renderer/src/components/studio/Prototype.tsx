import { type Studio, findNode, topFrames } from '@clanks/design';
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { Button } from '../ui';
import { FrameView } from './Layer';

/**
 * The prototype: one frame at a time, as it would be drawn, where clicking a linked layer goes to
 * the frame it links to. A click that hits nothing shows what can be clicked.
 */
export function Prototype(props: {
  state: Studio;
  /** The frame to start on. */
  start: string | null;
  mode: string;
  asset: (src: string) => string | null;
  onClose: () => void;
}) {
  const { state } = props;
  const frames = topFrames(state.design).map((t) => t.frame);
  const links = new Map(state.design.links.map((l) => [l.from, l.to]));
  const first =
    frames.find((f) => f.id === props.start) ??
    // The frame the first link leaves from is where a flow begins.
    frames.find((f) => state.design.links.some((l) => inside(state, f.id, l.from))) ??
    frames[0];
  const [history, setHistory] = useState<string[]>(first ? [first.id] : []);
  const [hint, setHint] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 1200, height: 700 });
  const current = findNode(state.design, history.at(-1) ?? '');

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRoom({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keys go to the player from the start: Escape closes it, the left arrow goes back.
  useEffect(() => root.current?.focus(), []);

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(false), 700);
    return () => clearTimeout(timer);
  }, [hint]);

  if (!current) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/85">
        <div className="flex flex-col items-center gap-3 text-sm text-dim">
          There are no frames to play yet.
          <Button size="sm" onClick={props.onClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  const width = typeof current.w === 'number' ? current.w : 1440;
  // A frame wider than the window is scaled down to fit; a tall one scrolls, as a page does.
  const scale = Math.min(1, (room.width - 48) / width);
  const hotspots = [...links.keys()];

  const onClick = (event: MouseEvent) => {
    let el = event.target as HTMLElement | null;
    while (el && el !== stage.current) {
      const to = el.dataset.id ? links.get(el.dataset.id) : undefined;
      if (to && findNode(state.design, to)) {
        setHistory((h) => [...h, to]);
        stage.current?.scrollTo({ top: 0 });
        return;
      }
      el = el.parentElement;
    }
    setHint(true);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[#0b0b0d]"
      role="dialog"
      aria-label="Prototype"
      tabIndex={-1}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') props.onClose();
        if (event.key === 'ArrowLeft') setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
      }}
      ref={root}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2">
        <Button
          size="sm"
          disabled={history.length < 2}
          onClick={() => setHistory((h) => h.slice(0, -1))}
        >
          Back
        </Button>
        <select
          value={current.id}
          aria-label="Frame"
          onChange={(event) => setHistory((h) => [...h, event.target.value])}
          className="h-8 max-w-72 rounded-full border border-line bg-black/30 px-3 text-[13px] text-white"
        >
          {frames.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-dim">
          {hotspots.length === 0
            ? 'Nothing is linked yet. Link a layer to a frame under Prototype.'
            : 'Click a linked layer to follow it.'}
        </span>
        <span className="min-w-0 flex-1" />
        <Button size="sm" onClick={props.onClose}>
          Close
        </Button>
      </header>
      {hint && (
        <style>{`${hotspots.map((id) => `[data-proto] [data-id="${CSS.escape(id)}"]`).join(',')} { outline: 2px solid #7ce7d2; outline-offset: 2px; }`}</style>
      )}
      <div
        ref={stage}
        data-proto
        className="flex min-h-0 flex-1 justify-center overflow-auto p-6"
        onClick={onClick}
      >
        <style>{`${hotspots.map((id) => `[data-proto] [data-id="${CSS.escape(id)}"]`).join(',')} { cursor: pointer; }`}</style>
        <div className="h-max shadow-2xl">
          <FrameView
            state={state}
            frame={current}
            mode={props.mode}
            scale={scale}
            asset={props.asset}
          />
        </div>
      </div>
    </div>
  );
}

/** Whether a layer is in a frame. */
function inside(state: Studio, frameId: string, id: string): boolean {
  const frame = findNode(state.design, frameId);
  if (!frame) return false;
  const visit = (node: typeof frame): boolean =>
    node.id === id || (node.type === 'frame' && node.children.some(visit));
  return visit(frame);
}
