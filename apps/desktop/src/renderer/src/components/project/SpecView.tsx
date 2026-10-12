import { type BoardSnapshot, type SpecVersionInfo, parseSpec } from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNav } from '../../lib/nav';
import { useTRPC } from '../../lib/trpc';
import { Markdown } from '../chat/Markdown';
import { Badge, Button, Dot, ErrorText, inputClass } from '../ui';
import { type DiffHandle, MonacoDiff } from '../workbench/MonacoDiff';

const STATUS: Record<
  SpecVersionInfo['status'],
  { label: string; tone: 'dim' | 'lavender' | 'amber' | 'mint' }
> = {
  draft: { label: 'Draft, being written', tone: 'lavender' },
  review: { label: 'Draft, being checked by Atlas', tone: 'lavender' },
  signed_off: { label: 'Checked, waiting for you', tone: 'amber' },
  approved: { label: 'Approved', tone: 'mint' },
};

/** The project's spec: each version, the one being written, and approving it. */
export function SpecView({ snapshot }: { snapshot: BoardSnapshot }) {
  const { go } = useNav();
  const versions = [...snapshot.specs].reverse();
  const [picked, setPicked] = useState<number | null>(null);
  const shown = versions.find((v) => v.version === picked) ?? versions[0];

  if (!shown) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-8 py-20 text-center">
        <h2 className="text-xl font-semibold tracking-tight">No spec yet</h2>
        <p className="text-sm text-dim">
          The spec is the plan in writing: what will be made, as short stories with a checklist for
          each. Tell Atlas what you want. Scribe writes it up, Atlas checks it, and you approve it
          before anything is built.
        </p>
        <Button
          variant="primary"
          onClick={() => go({ page: 'project', id: snapshot.project.id, tab: 'overview' })}
        >
          Talk to Atlas
        </Button>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1">
      <nav
        className="flex w-56 shrink-0 flex-col gap-1 border-r border-line p-3"
        aria-label="Versions"
      >
        {versions.map((v) => (
          <button
            key={v.version}
            type="button"
            aria-current={v.version === shown.version}
            onClick={() => setPicked(v.version)}
            className={`flex flex-col gap-0.5 rounded-xl px-3 py-2 text-left transition-colors ${v.version === shown.version ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'}`}
          >
            <span className="flex items-center gap-2 text-sm">
              v{v.version}
              {v.status === 'signed_off' && <Dot tone="amber" live />}
            </span>
            <span className="text-[11px] text-dim">
              {v.status === 'approved' && v.approvedAt
                ? `Approved ${v.approvedAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
                : STATUS[v.status].label}
              {` · ${v.stories} ${v.stories === 1 ? 'story' : 'stories'}`}
            </span>
          </button>
        ))}
      </nav>
      <Version
        key={shown.version}
        snapshot={snapshot}
        info={shown}
        previous={
          versions.find((v) => v.version < shown.version && v.status === 'approved') ?? null
        }
      />
    </div>
  );
}

function Version(props: {
  snapshot: BoardSnapshot;
  info: SpecVersionInfo;
  previous: SpecVersionInfo | null;
}) {
  const { info, snapshot } = props;
  const trpc = useTRPC();
  const projectId = snapshot.project.id;
  const spec = useQuery(trpc.board.spec.queryOptions({ projectId, version: info.version }));
  const before = useQuery(
    trpc.board.spec.queryOptions(
      { projectId, version: props.previous?.version ?? 1 },
      { enabled: props.previous !== null },
    ),
  );
  const [compare, setCompare] = useState(false);
  const [changing, setChanging] = useState(false);
  const [comment, setComment] = useState('');
  const approve = useMutation(trpc.board.approve.mutationOptions());
  const changes = useMutation(
    trpc.board.requestChanges.mutationOptions({
      onSuccess: () => {
        setChanging(false);
        setComment('');
      },
    }),
  );
  const handle = useRef<DiffHandle | null>(null);
  // The draft changes as Scribe writes it.
  const { refetch } = spec;
  const stamp = info.updatedAt.getTime();
  useEffect(() => {
    void refetch();
  }, [stamp, refetch]);

  const ticket = snapshot.tickets.find((t) => t.id === info.ticketId);
  const parsed = spec.data ? parseSpec(spec.data.body) : null;
  const status = STATUS[info.status];
  const error = approve.error ?? changes.error ?? spec.error;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-3">
        <span className="flex items-center gap-3">
          <span className="text-base font-medium">Spec v{info.version}</span>
          <Badge tone={status.tone}>{status.label}</Badge>
          {ticket && <span className="font-mono text-[12px] text-dim">{ticket.key}</span>}
        </span>
        <span className="flex items-center gap-2">
          {props.previous && (
            <Button size="sm" variant="ghost" onClick={() => setCompare((c) => !c)}>
              {compare ? 'Show it' : `Compare with v${props.previous.version}`}
            </Button>
          )}
          {info.status === 'signed_off' && ticket && (
            <>
              <Button size="sm" onClick={() => setChanging((c) => !c)}>
                Request changes…
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={approve.isPending}
                onClick={() => approve.mutate(ticket.id)}
              >
                Approve v{info.version}
              </Button>
            </>
          )}
        </span>
      </header>
      {changing && ticket && (
        <form
          className="flex gap-2 border-b border-line px-6 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            changes.mutate({ id: ticket.id, comment });
          }}
        >
          <textarea
            autoFocus
            rows={2}
            aria-label="What to change"
            placeholder="What should change? Scribe gets this, and Atlas signs it off again."
            className={`${inputClass} h-auto flex-1 py-2`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!comment.trim() || changes.isPending}>
            Send
          </Button>
        </form>
      )}
      {error && (
        <div className="px-6 pt-3">
          <ErrorText>{error.message}</ErrorText>
        </div>
      )}
      {parsed && info.status !== 'approved' && parsed.problems.length > 0 && (
        <ul className="mx-6 mt-3 flex flex-col gap-0.5 rounded-xl border border-amber-300/20 bg-amber-300/[0.05] px-3 py-2 text-[12px] text-amber-100/90">
          {parsed.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {compare && props.previous ? (
        <div className="min-h-0 flex-1">
          {spec.data && before.data && (
            <MonacoDiff
              path="spec.md"
              original={before.data.body}
              modified={spec.data.body}
              sideBySide={false}
              editable={false}
              hunks={[]}
              activeHunk={null}
              onSelectHunk={() => {}}
              onDirty={() => {}}
              onSave={() => {}}
              handle={handle}
            />
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <article className="mx-auto max-w-3xl px-8 py-6">
            {spec.data ? (
              spec.data.body.trim() ? (
                <Markdown text={spec.data.body} />
              ) : (
                <p className="text-sm text-dim">Nothing written yet.</p>
              )
            ) : (
              <p className="text-sm text-dim">Loading…</p>
            )}
          </article>
        </div>
      )}
    </div>
  );
}
