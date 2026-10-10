import type { Checkpoint, ReviewNote } from '@clanks/core';
import {
  type Design,
  Ids,
  type Node,
  type Op,
  OpError,
  WIRE_TOKENS,
  cloneWithIds,
  findToken,
  holderId,
  locate,
  makeComponent,
  nodeRefs,
  walk,
} from '@clanks/design';
import { useMutation } from '@tanstack/react-query';
import { type KeyboardEvent, type ReactNode, useCallback, useRef, useState } from 'react';
import {
  type DesignSource,
  type Tool,
  type View,
  contentRight,
  modeOf,
  placementOf,
  useAssets,
  useDesign,
  viewRoots,
} from '../../lib/studio';
import { useTRPC } from '../../lib/trpc';
import { Button, ErrorText } from '../ui';
import { ReviewTray } from '../workbench/DiffPane';
import { Canvas, MAX_ZOOM, MIN_ZOOM, type Pin, type PinPlace, type Viewport } from './Canvas';
import { Layers } from './Layers';
import { Library } from './Library';
import { Properties } from './Properties';
import { Prototype } from './Prototype';
import { Review } from './Review';
import { TokensPanel } from './TokensPanel';
import { Mini, Select } from './fields';
import {
  CommentIcon,
  EllipseIcon,
  FrameIcon,
  HandIcon,
  LineIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlayIcon,
  RectIcon,
  RedoIcon,
  SelectIcon,
  TextIcon,
  UndoIcon,
} from './icons';

/** The run whose design this is, when it's a clank's: who to tell, and what to compare with. */
export interface StudioRun {
  conversationId: string;
  clankName: string;
  /** The clank is working now, so the design may change under the user. */
  replying: boolean;
  notes: ReviewNote[];
  checkpoints: Checkpoint[];
}

const TOOLS: [tool: Tool, label: string, key: string, icon: ReactNode][] = [
  ['select', 'Select', 'V', <SelectIcon key="select" />],
  ['frame', 'Frame', 'F', <FrameIcon key="frame" />],
  ['rect', 'Rectangle', 'R', <RectIcon key="rect" />],
  ['ellipse', 'Ellipse', 'O', <EllipseIcon key="ellipse" />],
  ['line', 'Line', 'L', <LineIcon key="line" />],
  ['text', 'Text', 'T', <TextIcon key="text" />],
  ['hand', 'Hand', 'H', <HandIcon key="hand" />],
];

/** Whether keys typed at an element are text for it rather than shortcuts. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Studio, the design tool: a canvas with its layers and the things to put on it on the left, and
 * what's selected, the tokens and the review on the right. It shows a project's own design or a
 * run's, where a clank's changes arrive as it makes them and the user can edit alongside.
 */
export function Studio(props: {
  source: DesignSource;
  /** Whether the user may change it. A checker's copy is only to look at. */
  editable: boolean;
  run: StudioRun | null;
  /** Narrow, as beside a chat: the side panels start closed. */
  compact?: boolean;
  /** Something for the start of the toolbar, such as which design is shown. */
  header?: ReactNode;
}) {
  const { source, run } = props;
  const trpc = useTRPC();
  const [file, setFile] = useState<string | undefined>(undefined);
  const store = useDesign(source, file);
  const { snapshot, state } = store;
  const asset = useAssets(source, state?.design ?? null);
  const [chosenView, setView] = useState<View | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 80, zoom: 0.5 });
  const [wantedMode, setMode] = useState('light');
  const [fit, setFit] = useState(0);
  const [reveal, setReveal] = useState<{ id: string; nonce: number } | null>(null);
  const [left, setLeft] = useState<'layers' | 'insert' | null>(props.compact ? null : 'layers');
  const [right, setRight] = useState<'design' | 'tokens' | 'review' | null>(
    props.compact ? null : 'design',
  );
  const [playing, setPlaying] = useState(false);
  const [panning, setPanning] = useState(false);
  const [marked, setMarked] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const [naming, setNaming] = useState<string | null>(null);
  const [pinDraft, setPinDraft] = useState<PinPlace | null>(null);
  const [clipboard, setClipboard] = useState<Node[]>([]);
  const container = useRef<HTMLDivElement>(null);
  const pin = useMutation(trpc.design.pin.mutationOptions());

  const editable = props.editable;
  const design = state?.design ?? null;
  const view: View | null = design
    ? chosenView &&
      (chosenView.kind === 'page'
        ? design.pages.some((p) => p.id === chosenView.id)
        : design.components.some((c) => c.id === chosenView.id))
      ? chosenView
      : design.pages[0]
        ? { kind: 'page', id: design.pages[0].id }
        : null
    : null;
  const mode = state ? modeOf(state.tokens, wantedMode) : 'light';
  // Layers a clank or an undo took away are no longer selected.
  const selected = design ? selection.filter((id) => locate(design, id) !== null) : [];

  // While a clank works, the canvas goes to what it just changed.
  const [seen, setSeen] = useState<{ rev: string; design: Design | null }>({
    rev: '',
    design: null,
  });
  if (snapshot && snapshot.rev !== seen.rev) {
    setSeen({ rev: snapshot.rev, design: snapshot.design });
    if (seen.rev === '' && snapshot.design) setFit((n) => n + 1);
    if (follow && run?.replying && snapshot.design && seen.design) {
      const before = new Map(
        seen.design.pages.flatMap((p) => p.children.map((n) => [n.id, n] as const)),
      );
      for (const page of snapshot.design.pages) {
        const changed = page.children.find((n) => before.get(n.id) !== n);
        if (!changed) continue;
        // Structural sharing ends at the saved file, so compare what the layers say.
        if (JSON.stringify(before.get(changed.id)) === JSON.stringify(changed)) continue;
        setView({ kind: 'page', id: page.id });
        setReveal((r) => ({ id: changed.id, nonce: (r?.nonce ?? 0) + 1 }));
        break;
      }
    }
  }

  const show = useCallback(
    (id: string) => {
      if (!design) return;
      const located = locate(design, id);
      if (!located) return;
      if (located.page) setView({ kind: 'page', id: located.page.id });
      else if (located.component) setView({ kind: 'component', id: located.component.id });
      setSelection([id]);
      setReveal((r) => ({ id, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [design],
  );

  /** A drawn layer's box in the design's coordinates, read from the canvas. */
  const measure = (id: string) => {
    const host = container.current;
    const el = host?.querySelector<HTMLElement>(`[data-key="${CSS.escape(id)}"]`);
    if (!host || !el) return null;
    const origin = host.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return {
      x: (rect.left - origin.left - viewport.x) / viewport.zoom,
      y: (rect.top - origin.top - viewport.y) / viewport.zoom,
      w: rect.width / viewport.zoom,
      h: rect.height / viewport.zoom,
    };
  };

  if (!snapshot || !state || !design || !view) {
    return <p className="p-6 text-sm text-dim">Opening the design…</p>;
  }

  /** Puts new layers on the canvas: in the selected frame, after the selected layer, or on the page. */
  const insert = (nodes: Node[], options: { page?: boolean } = {}) => {
    if (!editable || nodes.length === 0) return;
    const ops: Op[] = [];
    // Wireframe blocks bring their greys with them the first time.
    for (const node of nodes) {
      for (const inner of walk(node)) {
        for (const { path } of nodeRefs(inner)) {
          const wire = WIRE_TOKENS.find((t) => t.path === path);
          if (
            wire &&
            !findToken(state.tokens, path) &&
            !ops.some((o) => o.op === 'token.set' && o.token.path === path)
          ) {
            ops.push({ op: 'token.set', token: wire });
          }
        }
      }
    }
    const target = !options.page && selected.length === 1 ? locate(design, selected[0]!) : null;
    let parent: string | null = null;
    let index: number | undefined;
    if (target?.node.type === 'frame') parent = target.node.id;
    else if (target) {
      parent = holderId(target);
      index = target.index + 1;
    }
    if (!parent) {
      if (view.kind !== 'page') {
        store.report('Select a layer of the component to add to it.');
        return;
      }
      parent = view.id;
      let x = contentRight(design, view);
      for (const node of nodes) {
        node.x = x;
        node.y = 0;
        x += (typeof node.w === 'number' ? node.w : 400) + 80;
      }
    }
    nodes.forEach((node, i) =>
      ops.push({
        op: 'insert',
        parent,
        ...(index === undefined ? {} : { index: index + i }),
        node,
      }),
    );
    if (store.apply(ops)) {
      setSelection(nodes.map((n) => n.id));
      setReveal((r) => ({ id: nodes[0]!.id, nonce: (r?.nonce ?? 0) + 1 }));
    }
  };

  const remove = () => {
    const ops: Op[] = [];
    for (const id of selected) {
      const located = locate(design, id);
      if (!located) continue;
      // A layer inside another that's going goes with it.
      if (located.ancestors.some((a) => selected.includes(a.id))) continue;
      if (located.holder.kind === 'variant') {
        const { component, variant } = located.holder;
        ops.push(
          component.variants.length === 1
            ? { op: 'component.remove', id: component.id }
            : { op: 'variant.remove', component: component.id, name: variant.name },
        );
      } else ops.push({ op: 'remove', id });
    }
    if (store.apply(ops)) setSelection([]);
  };

  const duplicate = () => {
    const ids = new Ids(design);
    const ops: Op[] = [];
    const made: string[] = [];
    for (const id of selected) {
      const located = locate(design, id);
      const parent = located ? holderId(located) : null;
      if (!located || !parent) continue;
      const copy = cloneWithIds(located.node, ids);
      if (placementOf(located) === 'free') {
        copy.x = (located.node.x ?? 0) + 24;
        copy.y = (located.node.y ?? 0) + 24;
      }
      ops.push({ op: 'insert', parent, index: located.index + 1, node: copy });
      made.push(copy.id);
    }
    if (store.apply(ops)) setSelection(made);
  };

  const copy = () => {
    const nodes = selected
      .map((id) => locate(design, id))
      .filter((l) => l !== null && l.holder.kind !== 'variant')
      .map((l) => l!.node);
    if (nodes.length > 0) setClipboard(nodes);
    return nodes.length > 0;
  };

  const paste = () => {
    if (clipboard.length === 0) return;
    const ids = new Ids(design);
    insert(
      clipboard.map((node) => {
        const { x: _x, y: _y, ...rest } = cloneWithIds(node, ids);
        return rest;
      }),
    );
  };

  /** Wraps the selected layers in a frame: a plain one, or one with auto layout. */
  const group = (auto: boolean) => {
    const located = selected.map((id) => locate(design, id)).filter((l) => l !== null);
    const first = located[0];
    const parent = first ? holderId(first) : null;
    if (!first || !parent || located.some((l) => holderId(l) !== parent)) {
      store.report('Select layers that are in the same frame to group them.');
      return;
    }
    if (
      auto &&
      located.length === 1 &&
      first.node.type === 'frame' &&
      (first.node.layout ?? 'none') === 'none'
    ) {
      // A frame without layout gets it, rather than a frame around it.
      store.apply([
        { op: 'update', id: first.node.id, set: { layout: 'col' } },
        ...first.node.children.map((child): Op => ({
          op: 'update',
          id: child.id,
          set: { x: null, y: null },
        })),
      ]);
      return;
    }
    const boxes = located.map((l) => measure(l.node.id));
    const holder = locate(design, parent) ? measure(parent) : { x: 0, y: 0, w: 0, h: 0 };
    if (boxes.some((b) => b === null) || !holder) return;
    const minX = Math.min(...boxes.map((b) => b!.x));
    const minY = Math.min(...boxes.map((b) => b!.y));
    const maxX = Math.max(...boxes.map((b) => b!.x + b!.w));
    const maxY = Math.max(...boxes.map((b) => b!.y + b!.h));
    const free = placementOf(first) === 'free';
    const across = maxX - minX > maxY - minY && located.length > 1;
    const ordered = [...located].sort((a, b) => a.index - b.index);
    const frame: Node = {
      id: new Ids(design).node(),
      type: 'frame',
      name: 'Group',
      ...(free ? { x: Math.round(minX - holder.x), y: Math.round(minY - holder.y) } : {}),
      ...(auto
        ? { layout: across ? 'row' : 'col' }
        : { layout: 'none', w: Math.round(maxX - minX), h: Math.round(maxY - minY) }),
      children: ordered.map((l) => {
        const { x: _x, y: _y, absolute: _absolute, ...rest } = l.node;
        const box = boxes[located.indexOf(l)]!;
        // In a plain group each layer keeps its place; in auto layout the frame places them.
        return auto ? rest : { ...rest, x: Math.round(box.x - minX), y: Math.round(box.y - minY) };
      }),
    };
    const ops: Op[] = [
      ...ordered.map((l): Op => ({ op: 'remove', id: l.node.id })),
      { op: 'insert', parent, index: ordered[0]!.index, node: frame },
    ];
    if (store.apply(ops)) setSelection([frame.id]);
  };

  const component = (id: string, name: string) => {
    try {
      const made = makeComponent(design, id, name);
      if (store.apply(made.ops)) setSelection([made.instance]);
    } catch (error) {
      if (!(error instanceof OpError)) throw error;
      store.report(error.message);
    }
  };

  const zoomTo = (zoom: number) => {
    const host = container.current?.getBoundingClientRect();
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const cx = (host?.width ?? 800) / 2;
    const cy = (host?.height ?? 600) / 2;
    const scale = next / viewport.zoom;
    setViewport({
      zoom: next,
      x: cx - (cx - viewport.x) * scale,
      y: cy - (cy - viewport.y) * scale,
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (typing(event.target) || playing) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const done = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (key === ' ') {
      setPanning(true);
      return done();
    }
    if (mod && key === 'z') {
      if (event.shiftKey) store.redo();
      else store.undo();
      return done();
    }
    if (mod && key === 'y') {
      store.redo();
      return done();
    }
    if (mod && (key === '0' || key === '=' || key === '+' || key === '-')) {
      zoomTo(key === '0' ? 1 : viewport.zoom * (key === '-' ? 1 / 1.25 : 1.25));
      return done();
    }
    if (event.shiftKey && (event.code === 'Digit1' || event.code === 'Digit0')) {
      if (event.code === 'Digit1') setFit((n) => n + 1);
      else zoomTo(1);
      return done();
    }
    if (mod && key === 'a') {
      setSelection(viewRoots(design, view).map((r) => r.node.id));
      return done();
    }
    if (mod && key === 'c') {
      if (copy()) done();
      return;
    }
    if (key === 'escape') {
      setTool('select');
      setSelection([]);
      setPinDraft(null);
      return done();
    }
    if (!mod && !event.altKey && key === 'c' && run) {
      setTool('comment');
      return done();
    }
    const single = selected.length === 1 ? locate(design, selected[0]!) : null;
    if (key === 'enter' && single) {
      if (event.shiftKey) {
        const parent = single.ancestors.at(-1);
        if (parent) setSelection([parent.id]);
      } else if (single.node.type === 'text' && editable && !single.node.bind) {
        setEditing(single.node.id);
      } else if (single.node.type === 'frame' && single.node.children[0]) {
        setSelection([single.node.children[0].id]);
      }
      return done();
    }
    if (key === 'tab' && single) {
      const parent = holderId(single);
      const siblings =
        single.holder.kind === 'page'
          ? single.holder.page.children
          : single.holder.kind === 'frame'
            ? single.holder.node.children
            : [];
      if (parent && siblings.length > 1) {
        const step = event.shiftKey ? siblings.length - 1 : 1;
        setSelection([siblings[(single.index + step) % siblings.length]!.id]);
      }
      return done();
    }
    if (!editable) return;
    if (!mod && !event.altKey) {
      const picked = TOOLS.find(([, , shortcut]) => shortcut.toLowerCase() === key);
      if (picked && !(key === 'a' && event.shiftKey)) {
        setTool(picked[0]);
        return done();
      }
    }
    if (key === 'delete' || key === 'backspace') {
      remove();
      return done();
    }
    if (mod && key === 'd') {
      duplicate();
      return done();
    }
    if (mod && key === 'x') {
      if (copy()) remove();
      return done();
    }
    if (mod && key === 'v') {
      paste();
      return done();
    }
    if (mod && event.altKey && key === 'k' && single) {
      setNaming(single.node.id);
      return done();
    }
    if (mod && key === 'g') {
      group(false);
      return done();
    }
    if (event.shiftKey && key === 'a') {
      group(true);
      return done();
    }
    if (mod && (key === ']' || key === '[') && single) {
      const parent = holderId(single);
      if (parent) {
        store.apply([
          {
            op: 'move',
            id: single.node.id,
            parent,
            index: Math.max(0, single.index + (key === ']' ? 1 : -1)),
          },
        ]);
      }
      return done();
    }
    if (key.startsWith('arrow') && selected.length > 0) {
      const amount = event.shiftKey ? 10 : 1;
      const dx = key === 'arrowleft' ? -amount : key === 'arrowright' ? amount : 0;
      const dy = key === 'arrowup' ? -amount : key === 'arrowdown' ? amount : 0;
      const ops = selected
        .map((id) => locate(design, id))
        .filter((l) => l !== null && placementOf(l) === 'free')
        .map((l): Op => ({
          op: 'update',
          id: l!.node.id,
          set: { x: (l!.node.x ?? 0) + dx, y: (l!.node.y ?? 0) + dy },
        }));
      store.apply(ops);
      return done();
    }
  };

  const pins: Pin[] = (run?.notes ?? []).flatMap((note) => {
    const anchor = note.anchor?.kind === 'pin' ? note.anchor : null;
    if (!anchor || note.path !== snapshot.file) return [];
    if (view.kind !== 'page' || (anchor.page && anchor.page !== view.id)) return [];
    return [
      { id: note.id, x: anchor.x, y: anchor.y, body: note.body, sent: note.status === 'sent' },
    ];
  });
  const pending = run?.notes.filter((n) => n.status === 'pending') ?? [];
  const empty = snapshot.design === null;

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-ink text-white outline-none"
      data-testid="studio"
      // Clicking anywhere in Studio brings the keyboard to it, so shortcuts follow the mouse.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (event.key === ' ') setPanning(false);
      }}
    >
      <header className="flex h-10 shrink-0 items-center gap-0.5 overflow-hidden border-b border-line px-2">
        {props.header}
        <Mini
          title={left ? 'Hide the layers' : 'Layers, and things to add'}
          active={left !== null}
          onClick={() => setLeft(left ? null : 'layers')}
        >
          <PanelLeftIcon />
        </Mini>
        <span className="mx-1 h-4 w-px shrink-0 bg-white/10" />
        {TOOLS.filter(
          ([id]) =>
            (editable || id === 'select' || id === 'hand') && !(props.compact && id === 'hand'),
        ).map(([id, label, shortcut, icon]) => (
          <Mini
            key={id}
            title={`${label} (${shortcut})`}
            active={tool === id}
            onClick={() => setTool(id)}
          >
            {icon}
          </Mini>
        ))}
        {run && (
          <Mini title="Comment (C)" active={tool === 'comment'} onClick={() => setTool('comment')}>
            <CommentIcon />
          </Mini>
        )}
        {editable && (
          <>
            <span className="mx-1 h-4 w-px shrink-0 bg-white/10" />
            <Mini title="Undo (Ctrl+Z)" disabled={!store.canUndo} onClick={store.undo}>
              <UndoIcon />
            </Mini>
            <Mini title="Redo (Ctrl+Shift+Z)" disabled={!store.canRedo} onClick={store.redo}>
              <RedoIcon />
            </Mini>
          </>
        )}
        <span className="min-w-0 flex-1" />
        {snapshot.files.length > 1 && (
          <span className="w-36 shrink-0">
            <Select
              label="Design file"
              value={snapshot.file}
              options={snapshot.files.map((f) => [f, f.replace(/^design\//, '')] as const)}
              onChange={(next) => {
                setFile(next);
                setSelection([]);
                setView(null);
              }}
            />
          </span>
        )}
        {run?.replying && (
          <Mini
            title={`Keep the canvas on what ${run.clankName} is changing`}
            active={follow}
            onClick={() => setFollow((f) => !f)}
          >
            Follow
          </Mini>
        )}
        {state.tokens.modes.length > 1 && (
          <Mini
            title="Switch between light and dark"
            onClick={() => {
              const at = state.tokens.modes.indexOf(mode);
              setMode(state.tokens.modes[(at + 1) % state.tokens.modes.length]!);
            }}
          >
            {mode}
          </Mini>
        )}
        {!props.compact && (
          <Mini title="Zoom out (Ctrl+-)" onClick={() => zoomTo(viewport.zoom / 1.25)}>
            −
          </Mini>
        )}
        <Mini title="Zoom to 100% (Shift+0)" onClick={() => zoomTo(1)}>
          <span className="w-8 text-center font-mono text-[11px]">
            {Math.round(viewport.zoom * 100)}%
          </span>
        </Mini>
        {!props.compact && (
          <Mini title="Zoom in (Ctrl+=)" onClick={() => zoomTo(viewport.zoom * 1.25)}>
            +
          </Mini>
        )}
        <Mini title="Fit everything (Shift+1)" onClick={() => setFit((n) => n + 1)}>
          Fit
        </Mini>
        <Mini title="Play the prototype" onClick={() => setPlaying(true)}>
          <PlayIcon />
        </Mini>
        <span className="mx-1 h-4 w-px shrink-0 bg-white/10" />
        <Mini
          title={right ? 'Hide the panel' : 'Design, tokens and review'}
          active={right !== null}
          onClick={() => setRight(right ? null : 'design')}
        >
          <PanelRightIcon />
        </Mini>
      </header>

      {/* Beside a chat the panels lie over the canvas rather than squeezing it. */}
      <div className="relative flex min-h-0 flex-1">
        {left && (
          <aside
            className={`flex w-60 shrink-0 flex-col border-r border-line ${props.compact ? 'absolute top-0 bottom-0 left-0 z-20 bg-panel shadow-2xl' : 'bg-panel/60'}`}
          >
            <PanelTabs
              value={left}
              onChange={setLeft}
              options={[['layers', 'Layers'], ...(editable ? [['insert', 'Insert'] as const] : [])]}
            />
            <div className="min-h-0 flex-1">
              {left === 'layers' ? (
                <Layers
                  design={design}
                  view={view}
                  setView={(next) => {
                    setView(next);
                    setSelection([]);
                    setFit((n) => n + 1);
                  }}
                  selection={selected}
                  setSelection={setSelection}
                  store={store}
                  editable={editable}
                />
              ) : (
                <Library
                  state={state}
                  snapshot={snapshot}
                  source={source}
                  mode={mode}
                  asset={asset}
                  insert={insert}
                  report={store.report}
                />
              )}
            </div>
          </aside>
        )}

        <div className="relative min-w-0 flex-1">
          <Canvas
            state={state}
            view={view}
            mode={mode}
            tool={tool}
            setTool={setTool}
            selection={selected}
            setSelection={setSelection}
            editing={editing}
            setEditing={setEditing}
            editable={editable}
            store={store}
            asset={asset}
            viewport={viewport}
            setViewport={setViewport}
            fit={fit}
            reveal={reveal}
            panning={panning}
            pins={pins}
            onPin={(place) => {
              setPinDraft(place);
              setTool('select');
            }}
            onOpenComponent={(id) => {
              setView({ kind: 'component', id });
              setSelection([]);
              setFit((n) => n + 1);
            }}
            marked={marked}
            container={container}
          />
          {view.kind === 'component' && (
            <div className="absolute top-3 left-3 flex items-center gap-2 rounded-full border border-accent/40 bg-panel/90 py-1 pr-1 pl-3 text-[12px] text-accent">
              Editing a component: every instance follows.
              <Button
                size="sm"
                className="h-6 px-2.5 text-[11px]"
                onClick={() => {
                  setView({ kind: 'page', id: design.pages[0]!.id });
                  setSelection([]);
                  setFit((n) => n + 1);
                }}
              >
                Back to the page
              </Button>
            </div>
          )}
          {empty && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <p className="max-w-sm text-center text-sm leading-relaxed text-dim">
                There's no design here yet.{' '}
                {editable
                  ? 'Press F and drag to draw a frame, pick a size under Insert, or give Prism a design ticket and watch it build here.'
                  : 'It shows here as soon as it is made.'}
              </p>
            </div>
          )}
          {snapshot.problems.length > 0 && (
            <div className="absolute top-3 right-3 max-w-md rounded-xl border border-rose-400/30 bg-panel/95 p-3">
              {snapshot.problems.map((problem) => (
                <ErrorText key={problem}>{problem}</ErrorText>
              ))}
            </div>
          )}
          {store.error && (
            <div className="absolute bottom-3 left-1/2 flex max-w-xl -translate-x-1/2 items-center gap-3 rounded-xl border border-rose-400/30 bg-panel/95 px-3 py-2 shadow-2xl">
              <ErrorText>{store.error}</ErrorText>
              <Mini title="Dismiss" onClick={store.clearError}>
                ×
              </Mini>
            </div>
          )}
          {pinDraft && run && (
            <PinForm
              place={pinDraft}
              style={{
                left: `min(${pinDraft.x * viewport.zoom + viewport.x}px, calc(100% - 17rem))`,
                top: pinDraft.y * viewport.zoom + viewport.y + 8,
              }}
              clankName={run.clankName}
              error={pin.error?.message ?? null}
              onCancel={() => setPinDraft(null)}
              onSave={(body) =>
                pin.mutate(
                  {
                    conversationId: run.conversationId,
                    path: snapshot.file,
                    node: pinDraft.node,
                    name: pinDraft.name,
                    frame: pinDraft.frame,
                    frameName: pinDraft.frameName,
                    page: view.kind === 'page' ? view.id : null,
                    x: pinDraft.x,
                    y: pinDraft.y,
                    body,
                  },
                  { onSuccess: () => setPinDraft(null) },
                )
              }
            />
          )}
          {naming && (
            <NameForm
              title="Name the component"
              placeholder="Button"
              onCancel={() => setNaming(null)}
              onSave={(name) => {
                component(naming, name);
                setNaming(null);
              }}
            />
          )}
        </div>

        {right && (
          <aside
            className={`flex w-72 shrink-0 flex-col border-l border-line ${props.compact ? 'absolute top-0 right-0 bottom-0 z-20 bg-panel shadow-2xl' : 'bg-panel/60'}`}
          >
            <PanelTabs
              value={right}
              onChange={setRight}
              options={[
                ['design', 'Design'],
                ['tokens', 'Tokens'],
                ['review', 'Review'],
              ]}
            />
            <div className="min-h-0 flex-1 overflow-y-auto">
              {right === 'design' && (
                <Properties
                  state={state}
                  snapshot={snapshot}
                  selection={selected}
                  store={store}
                  editable={editable}
                  mode={mode}
                  measure={measure}
                  onOpenComponent={(id) => {
                    setView({ kind: 'component', id });
                    setSelection([]);
                    setFit((n) => n + 1);
                  }}
                  onMakeComponent={setNaming}
                />
              )}
              {right === 'tokens' && (
                <TokensPanel
                  state={state}
                  store={store}
                  source={source}
                  editable={editable}
                  mode={mode}
                  setMode={setMode}
                />
              )}
              {right === 'review' && (
                <Review
                  state={state}
                  source={source}
                  file={snapshot.file}
                  run={run}
                  mode={mode}
                  asset={asset}
                  onShow={show}
                  marked={marked}
                  setMarked={setMarked}
                />
              )}
            </div>
          </aside>
        )}
      </div>

      {run && pending.length > 0 && <ReviewTray notes={pending} name={run.clankName} />}

      {playing && (
        <Prototype
          state={state}
          start={
            selected[0]
              ? (() => {
                  const located = locate(design, selected[0]);
                  return located?.page ? (located.ancestors[0] ?? located.node).id : null;
                })()
              : null
          }
          mode={mode}
          asset={asset}
          onClose={() => setPlaying(false)}
        />
      )}
    </div>
  );
}

/** A comment being written, where it will be pinned. */
function PinForm(props: {
  place: PinPlace;
  style: { left: string; top: number };
  clankName: string;
  error: string | null;
  onCancel: () => void;
  onSave: (body: string) => void;
}) {
  const [body, setBody] = useState('');
  return (
    <form
      className="absolute z-20 flex w-64 flex-col gap-2 rounded-xl border border-amber-300/40 bg-panel p-2.5 shadow-2xl"
      style={props.style}
      onSubmit={(event) => {
        event.preventDefault();
        if (body.trim()) props.onSave(body.trim());
      }}
    >
      <span className="truncate text-[11px] text-dim">On {props.place.name}</span>
      <textarea
        autoFocus
        value={body}
        rows={3}
        placeholder={`What should ${props.clankName} change here?`}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') props.onCancel();
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && body.trim()) {
            props.onSave(body.trim());
          }
        }}
        className="resize-none rounded-md border border-line bg-black/40 p-2 text-[12px] text-white placeholder:text-white/30 focus:border-accent/60 focus:outline-none"
      />
      {props.error && <ErrorText>{props.error}</ErrorText>}
      <span className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" className="h-7" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" className="h-7" type="submit" disabled={!body.trim()}>
          Comment
        </Button>
      </span>
    </form>
  );
}

function NameForm(props: {
  title: string;
  placeholder: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState('');
  return (
    <div
      className="absolute inset-0 z-30 grid place-items-center bg-black/40"
      onClick={props.onCancel}
    >
      <form
        className="flex w-72 flex-col gap-3 rounded-2xl border border-line bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) props.onSave(name.trim());
        }}
      >
        <label className="flex flex-col gap-2 text-sm font-medium">
          {props.title}
          <input
            autoFocus
            value={name}
            placeholder={props.placeholder}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') props.onCancel();
            }}
            className="h-9 rounded-lg border border-line bg-black/40 px-3 text-sm font-normal text-white placeholder:text-white/30 focus:border-accent/60 focus:outline-none"
          />
        </label>
        <p className="text-[12px] leading-relaxed text-dim">
          Its text layers become properties each instance can set. Use the name of a component that
          exists to add this as another variant of it.
        </p>
        <span className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={!name.trim()}>
            Make it
          </Button>
        </span>
      </form>
    </div>
  );
}

/** The tabs at the top of a side panel. */
function PanelTabs<T extends string>(props: {
  value: T;
  options: readonly (readonly [value: T, label: string])[];
  onChange: (value: T) => void;
}) {
  return (
    <nav className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line px-2">
      {props.options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-current={props.value === value ? 'page' : undefined}
          onClick={() => props.onChange(value)}
          className={`h-6 rounded-md px-2 text-[12px] transition-colors ${props.value === value ? 'bg-white/[0.09] text-white' : 'text-dim hover:text-white'}`}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
