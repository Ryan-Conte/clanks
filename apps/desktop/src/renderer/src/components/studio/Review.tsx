import type { Checkpoint, ReviewNote } from '@clanks/core';
import {
  type Change,
  type Node,
  type Studio,
  changeText,
  diffDesigns,
  findNode,
  topFrames,
} from '@clanks/design';
import type { DesignSource } from '@clanks/orchestrator';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { formatAgo } from '../../lib/format';
import { useTRPC } from '../../lib/trpc';
import { Button, ErrorText } from '../ui';
import { FrameView } from './Layer';
import { Mini, Section, Segments, Select } from './fields';

/** What a run brings to a review: its checkpoints to compare with, and the notes for its clank. */
export interface ReviewRun {
  conversationId: string;
  checkpoints: Checkpoint[];
  notes: ReviewNote[];
  clankName: string;
}

/**
 * Reviewing a design: what lint finds, what changed since a checkpoint down to the property, the
 * two versions side by side or one over the other, and the comments pinned to the canvas.
 */
export function Review(props: {
  state: Studio;
  source: DesignSource;
  file: string;
  run: ReviewRun | null;
  mode: string;
  asset: (src: string) => string | null;
  /** Selects a layer and brings it into view. */
  onShow: (id: string) => void;
  marked: string[];
  setMarked: (ids: string[]) => void;
}) {
  const { state, run } = props;
  const trpc = useTRPC();
  const [checking, setChecking] = useState(false);
  const lint = useQuery(
    trpc.design.lint.queryOptions(
      { source: props.source, file: props.file },
      { enabled: checking, staleTime: 0, gcTime: 0 },
    ),
  );
  const live = run?.checkpoints.filter((c) => !c.rewound) ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  // The run's start, unless the user picks a later moment.
  const from = live.find((c) => c.id === chosen) ?? live[0] ?? null;
  const before = useQuery(
    trpc.design.at.queryOptions(
      { conversationId: run?.conversationId ?? '', checkpointId: from?.id ?? '', file: props.file },
      { enabled: run !== null && from !== null, staleTime: Infinity },
    ),
  );
  const changes = useMemo(
    () => (before.data ? diffDesigns(before.data, state) : []),
    [before.data, state],
  );
  const [comparing, setComparing] = useState<string | null>(null);
  const remove = useMutation(trpc.workspace.deleteNote.mutationOptions());
  const pins = run?.notes.filter((n) => n.kind === 'pin') ?? [];
  const changedFrames = [...new Set(changes.map((c) => c.frame).filter((f): f is string => !!f))];
  const marking = props.marked.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <Section
        title="Lint"
        actions={
          <Mini
            title="Check the design, with every frame measured"
            onClick={() => {
              setChecking(true);
              void lint.refetch();
            }}
          >
            {lint.isFetching ? 'Checking…' : 'Check'}
          </Mini>
        }
      >
        {lint.error && <ErrorText>{lint.error.message}</ErrorText>}
        {!lint.data && !lint.isFetching && (
          <p className="text-[12px] leading-relaxed text-dim">
            Values that aren't tokens, contrast, overflow, tap targets, broken instances and layers
            nobody named.
          </p>
        )}
        {lint.data && lint.data.issues.length === 0 && (
          <p className="text-[12px] text-accent-2">
            No problems in {lint.data.frames} {lint.data.frames === 1 ? 'frame' : 'frames'}.
          </p>
        )}
        {lint.data && lint.data.issues.length > 0 && (
          <ul className="-mx-1 flex flex-col">
            {lint.data.issues.map((issue, i) => (
              <li key={`${issue.id}-${issue.rule}-${i}`}>
                <button
                  type="button"
                  onClick={() => props.onShow(issue.id)}
                  className="flex w-full flex-col gap-0.5 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-white/[0.05]"
                >
                  <span className="flex items-baseline gap-1.5">
                    <span className={issue.level === 'error' ? 'text-rose-300' : 'text-amber-200'}>
                      {issue.level === 'error' ? '●' : '○'}
                    </span>
                    <span className="truncate text-white/90">{issue.name}</span>
                    <span className="truncate text-[10px] text-dim">{issue.where}</span>
                  </span>
                  <span className="pl-4 leading-snug text-dim">{issue.message}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {run && from && (
        <Section
          title="Changes"
          actions={
            <Mini
              title="Mark what changed on the canvas"
              active={marking}
              disabled={changes.length === 0}
              onClick={() =>
                props.setMarked(
                  marking
                    ? []
                    : [
                        ...new Set(
                          changes
                            .filter(
                              (c) =>
                                c.kind === 'added' || c.kind === 'changed' || c.kind === 'moved',
                            )
                            .map((c) => c.id),
                        ),
                      ],
                )
              }
            >
              Mark
            </Mini>
          }
        >
          <Select
            label="Compare with"
            value={from.id}
            options={live.map((c) => [c.id, `${c.label} · ${formatAgo(c.createdAt)}`] as const)}
            onChange={(id) => {
              setChosen(id);
              props.setMarked([]);
            }}
          />
          {before.error && <ErrorText>{before.error.message}</ErrorText>}
          {before.data && changes.length === 0 && (
            <p className="text-[12px] text-dim">The design is as it was then.</p>
          )}
          {changedFrames.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {changedFrames.map((id) => {
                const frame = findNode(state.design, id);
                return frame ? (
                  <button
                    key={id}
                    type="button"
                    title={`See ${frame.name} as it was and as it is`}
                    onClick={() => setComparing(id)}
                    className="h-6 max-w-full truncate rounded-md border border-line bg-white/[0.04] px-2 text-[11px] text-white/85 hover:bg-white/[0.09]"
                  >
                    Compare {frame.name}
                  </button>
                ) : null;
              })}
            </div>
          )}
          <ul className="-mx-1 flex flex-col">
            {changes.slice(0, 300).map((change, i) => (
              <li key={`${change.id}-${change.prop ?? change.kind}-${i}`}>
                <ChangeRow change={change} onShow={props.onShow} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {run && (
        <Section title="Comments">
          {pins.length === 0 ? (
            <p className="text-[12px] leading-relaxed text-dim">
              Press C and click the canvas to pin a comment for {run.clankName}. Comments go with
              your next message, or with Request changes.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {pins.map((note, i) => (
                <li
                  key={note.id}
                  className="flex items-start gap-2 rounded-md border border-line bg-white/[0.03] p-2 text-[12px]"
                >
                  <span
                    className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${note.status === 'pending' ? 'bg-amber-300 text-black' : 'bg-zinc-700 text-white/70'}`}
                  >
                    {i + 1}
                  </span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      const node = note.anchor?.kind === 'pin' ? note.anchor.node : null;
                      if (node) props.onShow(node);
                    }}
                  >
                    <span className="block truncate text-dim">
                      {note.anchor?.kind === 'pin' ? note.anchor.name : 'Canvas'}
                      {note.status === 'sent' ? ` · sent to ${run.clankName}` : ''}
                    </span>
                    <span className="text-white/90">{note.body}</span>
                  </button>
                  {note.status === 'pending' && (
                    <Mini
                      title="Delete the comment"
                      onClick={() =>
                        remove.mutate({ conversationId: run.conversationId, id: note.id })
                      }
                    >
                      ×
                    </Mini>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {comparing && before.data && (
        <VisualDiff
          before={before.data}
          after={state}
          frameId={comparing}
          frames={changedFrames}
          setFrame={setComparing}
          mode={props.mode}
          asset={props.asset}
          label={from?.label ?? 'Before'}
          onClose={() => setComparing(null)}
        />
      )}
    </div>
  );
}

const KIND_MARK: Record<Change['kind'], [string, string]> = {
  added: ['+', 'text-accent-2'],
  removed: ['−', 'text-rose-300'],
  changed: ['~', 'text-amber-200'],
  moved: ['→', 'text-sky-300'],
  reordered: ['↕', 'text-sky-300'],
  token: ['#', 'text-accent'],
  component: ['◈', 'text-accent'],
  link: ['→', 'text-accent-2'],
  page: ['▤', 'text-dim'],
};

function ChangeRow({ change, onShow }: { change: Change; onShow: (id: string) => void }) {
  const [mark, tone] = KIND_MARK[change.kind];
  const onCanvas = ['added', 'changed', 'moved', 'reordered', 'link'].includes(change.kind);
  return (
    <button
      type="button"
      disabled={!onCanvas}
      onClick={() => onShow(change.id)}
      title={changeText(change)}
      className="flex w-full items-baseline gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] enabled:hover:bg-white/[0.05]"
    >
      <span className={`w-3 shrink-0 text-center font-mono ${tone}`}>{mark}</span>
      <span className="min-w-0 flex-1 leading-snug">
        <span className="text-white/90">{change.where.split(' › ').at(-1)}</span>
        {change.prop && <span className="text-dim"> {change.prop}</span>}
        {change.kind === 'changed' || change.kind === 'token' ? (
          <span className="font-mono text-[11px]">
            {' '}
            <span className="text-rose-300/90 line-through">{change.from}</span>{' '}
            <span className="text-accent-2">{change.to}</span>
          </span>
        ) : (
          <span className="text-dim"> {changeText(change).split(': ').slice(1).join(': ')}</span>
        )}
        {change.where.includes(' › ') && (
          <span className="block truncate text-[10px] text-dim">
            {change.where.split(' › ').slice(0, -1).join(' › ')}
          </span>
        )}
      </span>
    </button>
  );
}

/** One frame as it was and as it is: next to each other, or one laid over the other. */
function VisualDiff(props: {
  before: Studio;
  after: Studio;
  frameId: string;
  frames: string[];
  setFrame: (id: string) => void;
  mode: string;
  asset: (src: string) => string | null;
  label: string;
  onClose: () => void;
}) {
  const [layout, setLayout] = useState<'side' | 'overlay'>('side');
  const [opacity, setOpacity] = useState(0.5);
  const was = findNode(props.before.design, props.frameId);
  const now = findNode(props.after.design, props.frameId);
  const width = (node: Node | null) => (typeof node?.w === 'number' ? node.w : 1440);
  const widest = Math.max(width(was), width(now));
  const room = window.innerWidth - 96;
  const scale = Math.min(1, (layout === 'side' ? room / 2 - 24 : room) / widest);
  const names = topFrames(props.after.design).filter((f) => props.frames.includes(f.frame.id));
  const view = (state: Studio, node: Node | null, empty: string) =>
    node ? (
      <FrameView state={state} frame={node} mode={props.mode} scale={scale} asset={props.asset} />
    ) : (
      <p className="p-6 text-sm text-dim">{empty}</p>
    );

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85"
      role="dialog"
      aria-label="Compare"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2">
        <span className="w-64">
          <Select
            label="Frame"
            value={props.frameId}
            options={names.map((f) => [f.frame.id, f.frame.name] as const)}
            onChange={props.setFrame}
          />
        </span>
        <span className="w-56">
          <Segments
            value={layout}
            options={[
              ['side', 'Side by side'],
              ['overlay', 'Overlay'],
            ]}
            onChange={setLayout}
          />
        </span>
        {layout === 'overlay' && (
          <label className="flex items-center gap-2 text-[12px] text-dim">
            Before
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={opacity}
              aria-label="How much of the new version shows"
              onChange={(event) => setOpacity(Number(event.target.value))}
              className="w-48 accent-[#b9a7ff]"
            />
            Now
          </label>
        )}
        <span className="min-w-0 flex-1" />
        <Button size="sm" onClick={props.onClose}>
          Close
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {layout === 'side' ? (
          <div className="flex items-start gap-6">
            <figure className="flex min-w-0 flex-1 flex-col gap-2">
              <figcaption className="truncate text-[12px] text-dim">{props.label}</figcaption>
              {view(props.before, was, "It wasn't there then.")}
            </figure>
            <figure className="flex min-w-0 flex-1 flex-col gap-2">
              <figcaption className="text-[12px] text-dim">Now</figcaption>
              {view(props.after, now, "It's gone.")}
            </figure>
          </div>
        ) : (
          <div className="relative">
            {/* The old version stays solid underneath, so nothing behind the two shows through. */}
            <div>{view(props.before, was, '')}</div>
            <div className="absolute top-0 left-0" style={{ opacity }}>
              {view(props.after, now, '')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
