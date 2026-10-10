import {
  Ids,
  type Located,
  type Node,
  type Op,
  type Studio,
  findToken,
  holderId,
  locate,
  rootStyle,
  walk,
} from '@clanks/design';
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type DesignStore, type Tool, type View, placementOf, viewRoots } from '../../lib/studio';
import { Layer } from './Layer';

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** A comment pinned to the canvas. */
export interface Pin {
  id: string;
  x: number;
  y: number;
  body: string;
  sent: boolean;
}

/** Where a new comment would go. */
export interface PinPlace {
  node: string | null;
  name: string;
  frame: string | null;
  frameName: string | null;
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** How far the pointer goes before a press becomes a drag, in screen pixels. */
const DRAG_PX = 3;
/** How close an edge comes to another before it snaps to it, in screen pixels. */
const SNAP_PX = 6;
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 16;

function keyed(container: Element, key: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
}

/** The layer under a pointer event: its id, and whether it's itself or part of an instance. */
function hit(target: EventTarget | null): { id: string; key: string } | null {
  if (!(target instanceof Element)) return null;
  const label = target.closest<HTMLElement>('[data-label]');
  if (label) return { id: label.dataset.label!, key: label.dataset.label! };
  const el = target.closest<HTMLElement>('[data-id]');
  return el ? { id: el.dataset.id!, key: el.dataset.key! } : null;
}

/** Snaps a moving box's edges and centre to other boxes'. Returns how far to nudge it, and where. */
function snap(
  moving: Rect,
  others: Rect[],
  threshold: number,
): { dx: number; dy: number; lines: { x: number[]; y: number[] } } {
  const axis = (start: number, size: number, starts: [number, number][]) => {
    let best: { delta: number; line: number } | null = null;
    for (const mine of [start, start + size / 2, start + size]) {
      for (const [other, otherSize] of starts) {
        for (const theirs of [other, other + otherSize / 2, other + otherSize]) {
          const delta = theirs - mine;
          if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
            best = { delta, line: theirs };
          }
        }
      }
    }
    return best;
  };
  const x = axis(
    moving.x,
    moving.w,
    others.map((o) => [o.x, o.w]),
  );
  const y = axis(
    moving.y,
    moving.h,
    others.map((o) => [o.y, o.h]),
  );
  return {
    dx: x?.delta ?? 0,
    dy: y?.delta ?? 0,
    lines: { x: x ? [x.line] : [], y: y ? [y.line] : [] },
  };
}

const round = (value: number) => Math.round(value);

/** Something drawn over the canvas while the pointer is down: guides, a box being drawn, a drop line. */
interface Feedback {
  lines?: { x: number[]; y: number[] };
  /** In world coordinates. */
  box?: Rect & { kind: 'draw' | 'marquee' };
  /** Where a dragged layer would land, in screen coordinates. */
  drop?: Rect;
}

/**
 * The canvas: every layer of a page drawn as real DOM under a pan and zoom, with selection,
 * moving, resizing, snapping, drawing and text editing on top. A clank's changes show here as
 * they're made, since they arrive as the same state the user's own edits change.
 */
export function Canvas(props: {
  state: Studio;
  view: View;
  mode: string;
  tool: Tool;
  setTool: (tool: Tool) => void;
  selection: string[];
  setSelection: (ids: string[]) => void;
  editing: string | null;
  setEditing: (key: string | null) => void;
  editable: boolean;
  store: DesignStore;
  asset: (src: string) => string | null;
  viewport: Viewport;
  setViewport: (next: Viewport) => void;
  /** Counts up to ask for everything to be fitted in view. */
  fit: number;
  /** A layer to bring into view, such as the one a clank just changed. */
  reveal: { id: string; nonce: number } | null;
  /** Space is held, so dragging pans. */
  panning: boolean;
  pins: Pin[];
  onPin: (place: PinPlace) => void;
  onOpenComponent: (id: string) => void;
  /** Layers to mark, such as what changed since a checkpoint. */
  marked: string[];
  container: RefObject<HTMLDivElement | null>;
}) {
  const { state, view, viewport, selection, store, tool, editable, container } = props;
  const { design } = state;
  const world = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [feedback, setFeedback] = useState<Feedback>({});
  const [hover, setHover] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const roots = useMemo(() => viewRoots(design, view), [design, view]);
  const vars = useMemo(() => rootStyle(state.tokens, props.mode), [state.tokens, props.mode]);

  /** A point on the screen as a point in the design. */
  const toWorld = (clientX: number, clientY: number) => {
    const rect = container.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - viewport.x) / viewport.zoom,
      y: (clientY - rect.top - viewport.y) / viewport.zoom,
    };
  };

  /** A drawn layer's box in the design's own coordinates. */
  const worldRect = (key: string): Rect | null => {
    const el = container.current ? keyed(container.current, key) : null;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const a = toWorld(rect.left, rect.top);
    return { x: a.x, y: a.y, w: rect.width / viewport.zoom, h: rect.height / viewport.zoom };
  };

  // Selection boxes follow the layers they're on: after every draw, and when fonts or images land.
  useLayoutEffect(() => {
    const host = container.current;
    const layer = overlay.current;
    if (!host || !layer) return;
    const place = () => {
      const origin = host.getBoundingClientRect();
      for (const box of layer.querySelectorAll<HTMLElement>('[data-box]')) {
        const target = keyed(host, box.dataset.box!);
        if (!target) {
          box.style.display = 'none';
          continue;
        }
        const rect = target.getBoundingClientRect();
        box.style.display = 'block';
        box.style.left = `${rect.left - origin.left}px`;
        box.style.top = `${rect.top - origin.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        // A layer this small on screen has no room for handles: zoom in to resize it.
        box.dataset.small = String(rect.width < 26 || rect.height < 26);
      }
    };
    place();
    if (!world.current) return;
    const observer = new ResizeObserver(place);
    observer.observe(world.current);
    return () => observer.disconnect();
  });

  // Fits everything in view when asked: on opening a design, and from the toolbar.
  const { fit, setViewport } = props;
  const latest = useRef({ viewport, roots });
  useEffect(() => {
    latest.current = { viewport, roots };
  });
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const host = container.current;
      if (!host) return;
      const { viewport: now, roots: shown } = latest.current;
      const boxes = shown
        .map(({ node }) => keyed(host, node.id)?.getBoundingClientRect())
        .filter((box): box is DOMRect => box !== undefined);
      if (boxes.length === 0) return;
      const origin = host.getBoundingClientRect();
      // Back to the design's own coordinates, whatever the view is now.
      const x = (value: number) => (value - origin.left - now.x) / now.zoom;
      const y = (value: number) => (value - origin.top - now.y) / now.zoom;
      const left = Math.min(...boxes.map((b) => x(b.left)));
      const top = Math.min(...boxes.map((b) => y(b.top)));
      const right = Math.max(...boxes.map((b) => x(b.right)));
      const bottom = Math.max(...boxes.map((b) => y(b.bottom)));
      const pad = 64;
      const next = Math.min(
        1,
        Math.max(
          MIN_ZOOM,
          Math.min(
            (origin.width - pad * 2) / Math.max(1, right - left),
            (origin.height - pad * 2) / Math.max(1, bottom - top),
          ),
        ),
      );
      setViewport({
        zoom: next,
        x: (origin.width - (right - left) * next) / 2 - left * next,
        y: Math.max(pad, (origin.height - (bottom - top) * next) / 2) - top * next,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [fit, view, setViewport, container]);

  // Brings a layer into view when asked, moving only if it isn't all there already.
  const { reveal } = props;
  useEffect(() => {
    if (!reveal) return;
    const frame = requestAnimationFrame(() => {
      const host = container.current;
      const el = host ? keyed(host, reveal.id) : null;
      if (!host || !el) return;
      const origin = host.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      const margin = 48;
      if (
        rect.left >= origin.left + margin &&
        rect.right <= origin.right - margin &&
        rect.top >= origin.top + margin &&
        rect.bottom <= origin.bottom - margin
      ) {
        return;
      }
      const { viewport: now } = latest.current;
      const w = rect.width / now.zoom;
      const h = rect.height / now.zoom;
      const x = (rect.left - origin.left - now.x) / now.zoom;
      const y = (rect.top - origin.top - now.y) / now.zoom;
      // Zoomed out just enough to hold it, never in.
      const zoom = Math.max(
        MIN_ZOOM,
        Math.min(
          now.zoom,
          (origin.width - margin * 2) / Math.max(1, w),
          (origin.height - margin * 2) / Math.max(1, h),
        ),
      );
      setViewport({
        zoom,
        x: origin.width / 2 - (x + w / 2) * zoom,
        y: origin.height / 2 - (y + h / 2) * zoom,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal, setViewport, container]);

  /** Follows the pointer until it's released, wherever it goes. */
  const track = (
    event: ReactPointerEvent,
    move: (e: PointerEvent, moved: boolean) => void,
    up: (e: PointerEvent, moved: boolean) => void,
  ) => {
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const onMove = (e: PointerEvent) => {
      moved ||= Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_PX;
      if (moved) move(e, moved);
    };
    const onUp = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      up(e, moved);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const pan = (event: ReactPointerEvent) => {
    const start = { x: event.clientX, y: event.clientY, vx: viewport.x, vy: viewport.y };
    track(
      event,
      (e) =>
        props.setViewport({
          ...viewport,
          x: start.vx + e.clientX - start.x,
          y: start.vy + e.clientY - start.y,
        }),
      () => {},
    );
  };

  /** The boxes a free layer can snap to: its siblings', and its holder's. */
  const snapTargets = (located: Located, moving: Set<string>): Rect[] => {
    const siblings =
      located.holder.kind === 'page'
        ? located.holder.page.children
        : located.holder.kind === 'frame'
          ? located.holder.node.children
          : [];
    const rects = siblings
      .filter((s) => !moving.has(s.id))
      .map((s) => worldRect(s.id))
      .filter((r): r is Rect => r !== null);
    if (located.holder.kind === 'frame') {
      const own = worldRect(located.holder.node.id);
      if (own) rects.push(own);
    }
    return rects;
  };

  const moveFree = (event: ReactPointerEvent, ids: string[], lead: string) => {
    const starts = ids
      .map((id) => locate(design, id))
      .filter((l): l is Located => l !== null && placementOf(l) === 'free')
      .map((l) => ({ id: l.node.id, x: l.node.x ?? 0, y: l.node.y ?? 0, located: l }));
    const leader = starts.find((s) => s.id === lead) ?? starts[0];
    if (!leader) return;
    const box = worldRect(leader.id);
    const targets = snapTargets(leader.located, new Set(starts.map((s) => s.id)));
    const from = { x: event.clientX, y: event.clientY };
    const opsFor = (e: PointerEvent): { ops: Op[]; lines: { x: number[]; y: number[] } } => {
      let dx = (e.clientX - from.x) / viewport.zoom;
      let dy = (e.clientY - from.y) / viewport.zoom;
      if (e.shiftKey) {
        // Shift keeps the move to one direction.
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      let lines: { x: number[]; y: number[] } = { x: [], y: [] };
      if (box && !e.altKey) {
        const snapped = snap(
          { ...box, x: box.x + dx, y: box.y + dy },
          targets,
          SNAP_PX / viewport.zoom,
        );
        dx += snapped.dx;
        dy += snapped.dy;
        lines = snapped.lines;
      }
      return {
        lines,
        ops: starts.map((s) => ({
          op: 'update',
          id: s.id,
          set: { x: round(s.x + dx), y: round(s.y + dy) },
        })),
      };
    };
    track(
      event,
      (e) => {
        const { ops, lines } = opsFor(e);
        store.preview(ops);
        setFeedback({ lines });
      },
      (e, moved) => {
        setFeedback({});
        if (moved) store.apply(opsFor(e).ops);
        else store.preview(null);
      },
    );
  };

  /** Where a layer in auto layout would land if dropped at a point. */
  const dropAt = (
    clientX: number,
    clientY: number,
    dragged: Located,
  ): { parent: string; index: number; free: boolean; line: Rect | null } => {
    const host = container.current!;
    const inside = new Set([...walk(dragged.node)].map((n) => n.id));
    const under = document
      .elementsFromPoint(clientX, clientY)
      .filter((el): el is HTMLElement => el instanceof HTMLElement && host.contains(el))
      .find((el) => {
        const { id, key } = el.dataset;
        if (!id || id !== key || inside.has(id)) return false;
        return locate(design, id)?.node.type === 'frame';
      });
    const origin = host.getBoundingClientRect();
    if (!under) {
      const page = view.kind === 'page' ? view.id : null;
      return { parent: page ?? holderId(dragged) ?? '', index: -1, free: true, line: null };
    }
    const frame = locate(design, under.dataset.id!)!.node;
    if (frame.type !== 'frame') return { parent: frame.id, index: -1, free: true, line: null };
    const layout = frame.layout ?? 'none';
    if (layout === 'none') return { parent: frame.id, index: -1, free: true, line: null };
    const row = layout === 'row';
    const children = frame.children.filter((c) => c.id !== dragged.node.id && !c.absolute);
    const rects = children.map((c) => keyed(host, c.id)?.getBoundingClientRect() ?? null);
    let index = children.length;
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      if (!rect) continue;
      const middle = row ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
      if ((row ? clientX : clientY) < middle) {
        index = i;
        break;
      }
    }
    const own = under.getBoundingClientRect();
    const before = rects[index - 1] ?? null;
    const after = rects[index] ?? null;
    const at = after
      ? row
        ? after.left - 3
        : after.top - 3
      : before
        ? row
          ? before.right + 1
          : before.bottom + 1
        : row
          ? own.left + 4
          : own.top + 4;
    const line: Rect = row
      ? { x: at - origin.left, y: own.top - origin.top + 4, w: 2, h: Math.max(8, own.height - 8) }
      : { x: own.left - origin.left + 4, y: at - origin.top, w: Math.max(8, own.width - 8), h: 2 };
    // Its place counts the layers as they'll be once it's taken out of where it was.
    const target = frame.children.filter((c) => c.id !== dragged.node.id);
    const anchor = children[index];
    return {
      parent: frame.id,
      index: anchor ? target.indexOf(anchor) : target.length,
      free: false,
      line,
    };
  };

  const moveFlow = (event: ReactPointerEvent, id: string) => {
    const dragged = locate(design, id);
    if (!dragged) return;
    track(
      event,
      (e) => {
        setDragging(id);
        const drop = dropAt(e.clientX, e.clientY, dragged);
        setFeedback(drop.line ? { drop: drop.line } : {});
      },
      (e, moved) => {
        setDragging(null);
        setFeedback({});
        if (!moved) return;
        const drop = dropAt(e.clientX, e.clientY, dragged);
        if (!drop.parent) return;
        const ops: Op[] = [
          {
            op: 'move',
            id,
            parent: drop.parent,
            ...(drop.index >= 0 ? { index: drop.index } : {}),
          },
        ];
        if (drop.free) {
          // Out of auto layout, it stays where it was dropped.
          const point = toWorld(e.clientX, e.clientY);
          const holder = worldRect(drop.parent);
          const size = worldRect(id);
          ops.push({
            op: 'update',
            id,
            set: {
              x: round(point.x - (holder?.x ?? 0) - (size?.w ?? 0) / 2),
              y: round(point.y - (holder?.y ?? 0) - (size?.h ?? 0) / 2),
            },
          });
        }
        store.apply(ops);
      },
    );
  };

  const resize = (event: ReactPointerEvent, id: string, handle: Handle) => {
    const located = locate(design, id);
    const start = worldRect(id);
    if (!located || !start) return;
    const { node } = located;
    const free = placementOf(located) === 'free';
    const from = { x: event.clientX, y: event.clientY };
    const targets = free ? snapTargets(located, new Set([id])) : [];
    const opsFor = (e: PointerEvent): { ops: Op[]; lines: { x: number[]; y: number[] } } => {
      let dx = (e.clientX - from.x) / viewport.zoom;
      let dy = (e.clientY - from.y) / viewport.zoom;
      const lines: { x: number[]; y: number[] } = { x: [], y: [] };
      if (free && !e.altKey) {
        // The edge being dragged snaps to the edges around it.
        const edgeX = handle.includes('w') ? start.x + dx : start.x + start.w + dx;
        const edgeY = handle.includes('n') ? start.y + dy : start.y + start.h + dy;
        const snapped = snap({ x: edgeX, y: edgeY, w: 0, h: 0 }, targets, SNAP_PX / viewport.zoom);
        if (handle.includes('w') || handle.includes('e')) {
          dx += snapped.dx;
          lines.x = snapped.lines.x;
        }
        if (handle.includes('n') || handle.includes('s')) {
          dy += snapped.dy;
          lines.y = snapped.lines.y;
        }
      }
      const set: Record<string, unknown> = {};
      let w = start.w;
      let h = start.h;
      if (handle.includes('e')) w = start.w + dx;
      if (handle.includes('w')) w = start.w - dx;
      if (handle.includes('s')) h = start.h + dy;
      if (handle.includes('n')) h = start.h - dy;
      w = Math.max(1, round(w));
      h = Math.max(1, round(h));
      if (node.type === 'icon') {
        set.size = Math.max(w, h);
      } else {
        if (handle.includes('e') || handle.includes('w')) set.w = w;
        if (handle.includes('n') || handle.includes('s')) set.h = h;
      }
      if (free) {
        if (handle.includes('w')) set.x = round((node.x ?? 0) + start.w - w);
        if (handle.includes('n')) set.y = round((node.y ?? 0) + start.h - h);
      }
      return { ops: [{ op: 'update', id, set }], lines };
    };
    track(
      event,
      (e) => {
        const { ops, lines } = opsFor(e);
        store.preview(ops);
        setFeedback({ lines });
      },
      (e, moved) => {
        setFeedback({});
        if (moved) store.apply(opsFor(e).ops);
        else store.preview(null);
      },
    );
  };

  /** The frame a new layer goes into, and that frame's box. Null for the page itself. */
  const frameUnder = (target: EventTarget | null): { node: Node; rect: Rect } | null => {
    const found = hit(target);
    if (!found || found.id !== found.key) return null;
    const located = locate(design, found.id);
    if (!located) return null;
    const frame = located.node.type === 'frame' ? located.node : (located.ancestors.at(-1) ?? null);
    const rect = frame ? worldRect(frame.id) : null;
    return frame && rect ? { node: frame, rect } : null;
  };

  const draw = (event: ReactPointerEvent, kind: Exclude<Tool, 'select' | 'hand' | 'comment'>) => {
    const from = toWorld(event.clientX, event.clientY);
    const into = frameUnder(event.target);
    const boxOf = (e: PointerEvent): Rect => {
      const to = toWorld(e.clientX, e.clientY);
      return {
        x: Math.min(from.x, to.x),
        y: Math.min(from.y, to.y),
        w: Math.abs(to.x - from.x),
        h: Math.abs(to.y - from.y),
      };
    };
    track(
      event,
      (e) => setFeedback({ box: { ...boxOf(e), kind: 'draw' } }),
      (e, moved) => {
        setFeedback({});
        // In a component, new layers go inside its variants, never loose beside them.
        if (view.kind === 'component' && !into) return;
        const box = moved
          ? boxOf(e)
          : {
              x: from.x,
              y: from.y,
              w: kind === 'frame' ? 320 : 120,
              h: kind === 'frame' ? 240 : 120,
            };
        const ids = new Ids(design);
        const id = ids.node();
        const flow = into?.node.type === 'frame' && (into.node.layout ?? 'none') !== 'none';
        const at = flow
          ? {}
          : { x: round(box.x - (into?.rect.x ?? 0)), y: round(box.y - (into?.rect.y ?? 0)) };
        const w = Math.max(1, round(box.w));
        const h = Math.max(1, round(box.h));
        const token = (path: string, fallback: string) =>
          findToken(state.tokens, path) ? `{${path}}` : fallback;
        let node: Node;
        if (kind === 'frame') {
          node = {
            id,
            type: 'frame',
            name: 'Frame',
            ...at,
            w,
            h,
            layout: 'none',
            fill: token('color.bg', '#ffffff'),
            children: [],
          };
        } else if (kind === 'text') {
          node = {
            id,
            type: 'text',
            name: 'Text',
            ...at,
            text: 'Text',
            ...(findToken(state.tokens, 'type.body') ? { style: '{type.body}' as const } : {}),
            color: token('color.text', '#111111'),
            ...(moved ? { w } : {}),
          };
        } else if (kind === 'line') {
          const vertical = box.h > box.w;
          node = {
            id,
            type: 'line',
            name: 'Line',
            ...at,
            ...(vertical ? { h, vertical: true } : { w }),
            stroke: token('color.border', '#888888'),
          };
        } else {
          node = {
            id,
            type: kind,
            name: kind === 'rect' ? 'Rectangle' : 'Ellipse',
            ...at,
            w,
            h,
            fill: token('color.surface', '#d9d9d9'),
          };
        }
        const parent = into?.node.id ?? (view.kind === 'page' ? view.id : '');
        if (!parent) return;
        if (store.apply([{ op: 'insert', parent, node }])) {
          props.setSelection([id]);
          props.setTool('select');
          if (kind === 'text') props.setEditing(id);
        }
      },
    );
  };

  const marquee = (event: ReactPointerEvent, keep: string[]) => {
    const from = toWorld(event.clientX, event.clientY);
    const boxOf = (e: PointerEvent): Rect => {
      const to = toWorld(e.clientX, e.clientY);
      return {
        x: Math.min(from.x, to.x),
        y: Math.min(from.y, to.y),
        w: Math.abs(to.x - from.x),
        h: Math.abs(to.y - from.y),
      };
    };
    track(
      event,
      (e) => setFeedback({ box: { ...boxOf(e), kind: 'marquee' } }),
      (e, moved) => {
        setFeedback({});
        if (!moved) return;
        const box = boxOf(e);
        const inside = roots
          .filter(({ node }) => {
            const rect = worldRect(node.id);
            return (
              rect !== null &&
              rect.x < box.x + box.w &&
              rect.x + rect.w > box.x &&
              rect.y < box.y + box.h &&
              rect.y + rect.h > box.y
            );
          })
          .map(({ node }) => node.id);
        props.setSelection([...new Set([...keep, ...inside])]);
      },
    );
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest('[data-editing]') || target.closest('[data-pin]')) return;
    // Presses here start drags, which would otherwise keep the keyboard from coming to the canvas.
    container.current?.focus({ preventScroll: true });
    if (props.editing) {
      // A press elsewhere finishes the text being edited; its blur saves it.
      (document.activeElement as HTMLElement | null)?.blur();
    }
    if (event.button === 1 || tool === 'hand' || props.panning) {
      event.preventDefault();
      pan(event);
      return;
    }
    if (event.button !== 0) return;
    const handle = target.closest<HTMLElement>('[data-handle]');
    if (handle && editable && selection[0]) {
      event.preventDefault();
      resize(event, selection[0], handle.dataset.handle as Handle);
      return;
    }
    const found = hit(target);
    if (tool === 'comment') {
      const located = found ? locate(design, found.id) : null;
      const top = located ? (located.ancestors[0] ?? located.node) : null;
      const point = toWorld(event.clientX, event.clientY);
      props.onPin({
        node: found?.id ?? null,
        name: located?.node.name ?? 'the canvas',
        frame: located?.page ? (top?.id ?? null) : null,
        frameName: located?.page ? (top?.name ?? null) : null,
        x: round(point.x),
        y: round(point.y),
      });
      return;
    }
    if (tool !== 'select') {
      if (!editable) return;
      event.preventDefault();
      draw(event, tool);
      return;
    }
    if (!found) {
      if (!event.shiftKey) props.setSelection([]);
      marquee(event, event.shiftKey ? selection : []);
      return;
    }
    const located = locate(design, found.id);
    let next = selection;
    if (event.shiftKey) {
      next = selection.includes(found.id)
        ? selection.filter((id) => id !== found.id)
        : [...selection, found.id];
    } else if (!selection.includes(found.id)) {
      next = [found.id];
    }
    if (next !== selection) props.setSelection(next);
    if (!editable || !located || located.node.locked || event.shiftKey) return;
    event.preventDefault();
    const placement = placementOf(located);
    if (placement === 'free') moveFree(event, next, found.id);
    else if (placement === 'flow') moveFlow(event, found.id);
  };

  const onDoubleClick = (event: ReactMouseEvent) => {
    const found = hit(event.target);
    if (!found || !editable) return;
    const located = locate(design, found.id);
    if (!located) return;
    if (located.node.type === 'instance') props.onOpenComponent(located.node.component);
    else if (located.node.type === 'text' && found.key === found.id && !located.node.bind) {
      props.setSelection([found.id]);
      props.setEditing(found.key);
    }
  };

  // Typing goes to the text being edited as soon as it's on the canvas.
  const { editing } = props;
  useEffect(() => {
    if (!editing || !container.current) return;
    const el = container.current.querySelector<HTMLElement>('[data-editing]');
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selected = window.getSelection();
    selected?.removeAllRanges();
    selected?.addRange(range);
  }, [editing, container]);

  const finishEditing = (el: HTMLElement) => {
    const id = el.dataset.id!;
    const text = el.innerText.replace(/\n$/, '');
    props.setEditing(null);
    // Shortcuts work again as soon as the text is done.
    container.current?.focus({ preventScroll: true });
    const node = locate(design, id)?.node;
    if (node?.type === 'text' && node.text !== text) {
      store.apply([{ op: 'update', id, set: { text } }]);
    }
  };

  const onWheel = (event: ReactWheelEvent) => {
    if (event.ctrlKey || event.metaKey) {
      const rect = container.current!.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const zoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, viewport.zoom * Math.exp(-event.deltaY * 0.0025)),
      );
      const scale = zoom / viewport.zoom;
      // The point under the pointer stays under it.
      props.setViewport({
        zoom,
        x: px - (px - viewport.x) * scale,
        y: py - (py - viewport.y) * scale,
      });
    } else {
      props.setViewport({
        ...viewport,
        x: viewport.x - (event.shiftKey ? event.deltaY : event.deltaX),
        y: viewport.y - (event.shiftKey ? 0 : event.deltaY),
      });
    }
  };

  const toScreen = (rect: Rect): CSSProperties => ({
    left: rect.x * viewport.zoom + viewport.x,
    top: rect.y * viewport.zoom + viewport.y,
    width: rect.w * viewport.zoom,
    height: rect.h * viewport.zoom,
  });

  const cursor =
    tool === 'hand' || props.panning
      ? 'grab'
      : tool === 'select'
        ? 'default'
        : tool === 'comment'
          ? 'copy'
          : 'crosshair';
  const single = selection.length === 1 ? selection[0]! : null;
  const singleNode = single ? locate(design, single) : null;

  return (
    <div
      ref={container}
      tabIndex={0}
      data-testid="studio-canvas"
      className="relative h-full w-full overflow-hidden bg-[#17171b] outline-none"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
      onPointerMove={(event) => {
        if (event.buttons !== 0) return;
        const found = tool === 'select' ? hit(event.target) : null;
        if ((found?.id ?? null) !== hover) setHover(found?.id ?? null);
      }}
      onPointerLeave={() => setHover(null)}
      onBlurCapture={(event) => {
        const el = event.target as HTMLElement;
        if (el.dataset.editing) finishEditing(el);
      }}
      onKeyDownCapture={(event) => {
        if (!(event.target as HTMLElement).dataset.editing) return;
        // Keys typed into text are text, not shortcuts.
        event.stopPropagation();
        if (event.key === 'Escape') (event.target as HTMLElement).blur();
      }}
    >
      <div
        ref={world}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: '0 0',
          userSelect: 'none',
        }}
      >
        {view.kind === 'page' &&
          roots.map(({ node, label }) => (
            <div
              key={`label-${node.id}`}
              data-label={node.id}
              className={`absolute cursor-default truncate font-sans whitespace-nowrap ${selection.includes(node.id) ? 'text-accent' : 'text-white/50 hover:text-white/80'}`}
              style={{
                left: node.x ?? 0,
                top: node.y ?? 0,
                // No wider than its frame is on screen, so neighbours' names don't run together.
                maxWidth: Math.max(24, (typeof node.w === 'number' ? node.w : 400) * viewport.zoom),
                fontSize: 12,
                lineHeight: '16px',
                transform: `translateY(-100%) scale(${1 / viewport.zoom}) translateY(-4px)`,
                transformOrigin: '0 100%',
              }}
            >
              {label}
            </div>
          ))}
        <div
          style={{
            ...(vars as CSSProperties),
            ...(view.kind === 'component'
              ? { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 72 }
              : {}),
          }}
        >
          {roots.map(({ node, label, free }) =>
            free ? (
              <Layer
                key={node.id}
                node={node}
                free
                components={design.components}
                asset={props.asset}
                editing={props.editing}
              />
            ) : (
              <div key={node.id} className="flex flex-col gap-3">
                <span
                  className="font-sans whitespace-nowrap text-accent"
                  style={{
                    fontSize: 12,
                    lineHeight: '16px',
                    transform: `scale(${1 / viewport.zoom})`,
                    transformOrigin: '0 100%',
                  }}
                >
                  {label}
                </span>
                <Layer
                  node={node}
                  free={false}
                  components={design.components}
                  asset={props.asset}
                  editing={props.editing}
                />
              </div>
            ),
          )}
        </div>
      </div>

      <div ref={overlay} className="pointer-events-none absolute inset-0">
        {props.marked.map((id) => (
          <div
            key={`mark-${id}`}
            data-box={id}
            className="absolute rounded-[2px] border border-amber-300/90 bg-amber-300/10"
          />
        ))}
        {hover && !selection.includes(hover) && (
          <div data-box={hover} className="absolute border border-accent/70" />
        )}
        {dragging && <div data-box={dragging} className="absolute bg-accent/25" />}
        {selection.map((id) => (
          <div key={id} data-box={id} className="group absolute border-[1.5px] border-accent">
            {single === id &&
              editable &&
              !props.editing &&
              singleNode &&
              !singleNode.node.locked && (
                <>
                  {HANDLES.map((handle) => (
                    <span
                      key={handle}
                      data-handle={handle}
                      className="pointer-events-auto absolute size-2 rounded-[1px] border border-accent bg-white group-data-[small=true]:hidden"
                      style={{
                        left: handle.includes('w')
                          ? -4
                          : handle.includes('e')
                            ? 'calc(100% - 4px)'
                            : 'calc(50% - 4px)',
                        top: handle.includes('n')
                          ? -4
                          : handle.includes('s')
                            ? 'calc(100% - 4px)'
                            : 'calc(50% - 4px)',
                        cursor: `${handle}-resize`,
                      }}
                    />
                  ))}
                </>
              )}
          </div>
        ))}
        {feedback.lines?.x.map((x) => (
          <div
            key={`gx-${x}`}
            className="absolute top-0 bottom-0 w-px bg-rose-400"
            style={{ left: x * viewport.zoom + viewport.x }}
          />
        ))}
        {feedback.lines?.y.map((y) => (
          <div
            key={`gy-${y}`}
            className="absolute right-0 left-0 h-px bg-rose-400"
            style={{ top: y * viewport.zoom + viewport.y }}
          />
        ))}
        {feedback.box && (
          <div
            className={`absolute border ${feedback.box.kind === 'draw' ? 'border-accent bg-accent/10' : 'border-white/40 bg-white/5'}`}
            style={toScreen(feedback.box)}
          />
        )}
        {feedback.drop && (
          <div
            className="absolute rounded-full bg-accent-2"
            style={{
              left: feedback.drop.x,
              top: feedback.drop.y,
              width: feedback.drop.w,
              height: feedback.drop.h,
            }}
          />
        )}
        {props.pins.map((pin, i) => (
          <div
            key={pin.id}
            data-pin={pin.id}
            title={pin.body}
            className={`pointer-events-auto absolute grid size-6 -translate-x-1/2 -translate-y-full place-items-center rounded-full rounded-bl-none border text-[11px] font-semibold shadow-lg ${pin.sent ? 'border-white/20 bg-zinc-700 text-white/70' : 'border-amber-200 bg-amber-300 text-black'}`}
            style={{
              left: pin.x * viewport.zoom + viewport.x,
              top: pin.y * viewport.zoom + viewport.y,
            }}
          >
            {i + 1}
          </div>
        ))}
      </div>
    </div>
  );
}
