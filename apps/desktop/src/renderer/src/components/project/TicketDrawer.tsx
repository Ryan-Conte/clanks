import {
  type BoardSnapshot,
  COLUMN_TITLES,
  type SpecStory,
  type TicketCard,
  criterionText,
  parseSpec,
} from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { TYPE_LABELS, actorName, cardStatus, ciText, namer, usageText } from '../../lib/board';
import { useCrew } from '../../lib/crew';
import { formatAgo } from '../../lib/format';
import { useNav } from '../../lib/nav';
import { useTRPC } from '../../lib/trpc';
import { Avatar } from '../Avatar';
import { Markdown } from '../chat/Markdown';
import { Badge, Button, Dot, ErrorText, IconButton, TrashIcon, XIcon, inputClass } from '../ui';

/** One ticket in full, beside the board: what it is, where it is, and what to do about it. */
export function TicketDrawer(props: {
  snapshot: BoardSnapshot;
  card: TicketCard;
  onClose: () => void;
  onWatch: (card: TicketCard) => void;
}) {
  const { snapshot, card } = props;
  const trpc = useTRPC();
  const { go } = useNav();
  const crew = useCrew();
  const name = namer(crew);
  const status = cardStatus(card, snapshot, name);
  const projectId = snapshot.project.id;
  const approvedVersion = snapshot.specs.filter((s) => s.status === 'approved').at(-1)?.version;
  const specVersion =
    card.type === 'spec' ? (card.specVersion ?? approvedVersion) : approvedVersion;
  const spec = useQuery(
    trpc.board.spec.queryOptions(
      { projectId, version: specVersion ?? 1 },
      { enabled: specVersion !== undefined && card.stories.length > 0 },
    ),
  );
  const stories = spec.data ? parseSpec(spec.data.body).stories : [];
  const events = snapshot.events.filter((e) => e.ticketId === card.id);
  const draft = snapshot.specs.find((s) => s.ticketId === card.id && s.status !== 'approved');
  const watchable = card.runs.length > 0;
  /** A design is reviewed in its maker's copy, which Studio opens. */
  const makerRun = card.runs.find((run) => run.role === 'maker');

  return (
    <aside className="flex w-[30rem] shrink-0 flex-col border-l border-line bg-panel/60">
      <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-center gap-2">
            <span className="font-mono text-[12px] text-dim">{card.key}</span>
            <Badge tone={card.type === 'spec' ? 'lavender' : 'dim'}>{TYPE_LABELS[card.type]}</Badge>
            <span className="text-[12px] text-dim">{COLUMN_TITLES[card.column]}</span>
          </span>
          <h2 className="text-base leading-snug font-medium">{card.title}</h2>
          <span className="flex items-center gap-1.5 text-[12px] text-white/75">
            {status.live ? <Dot tone="mint" live /> : <span>{status.icon}</span>}
            {status.text}
          </span>
          {card.live && (
            <span className="font-mono text-[11px] text-dim">
              <InlineCode text={card.live.label} />
            </span>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-1">
          {card.type === 'design' && makerRun && !card.doneAt && (
            <Button
              size="sm"
              variant="ghost"
              title="See the design, compare it with how it was, and comment on the canvas"
              onClick={() =>
                go({ page: 'project', id: projectId, tab: 'design', run: makerRun.conversationId })
              }
            >
              Studio
            </Button>
          )}
          {watchable && (
            <Button
              size="sm"
              variant="ghost"
              title="Follow its run in the workbench"
              onClick={() => props.onWatch(card)}
            >
              Watch
            </Button>
          )}
          <IconButton label="Close" onClick={props.onClose}>
            <XIcon />
          </IconButton>
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        <Actions
          card={card}
          snapshot={snapshot}
          draftVersion={draft?.version ?? null}
          onClose={props.onClose}
        />

        <Section title="Route">
          <Route card={card} name={name} />
          <Checks card={card} snapshot={snapshot} name={name} />
        </Section>

        {(card.column === 'backlog' || (card.column === 'build' && !card.detour)) &&
          card.type !== 'spec' && <Assignee card={card} snapshot={snapshot} />}

        {card.delivery && <Delivery card={card} hasRepo={snapshot.project.repo !== null} />}

        {card.description && (
          <Section title="Description">
            <Markdown text={card.description} />
          </Section>
        )}

        {card.stories.length > 0 && (
          <Section title="Stories">
            <ul className="flex flex-col gap-1 text-[13px]">
              {card.stories.map((id) => (
                <li key={id}>
                  <span className="font-mono text-[12px] text-accent">{id}</span>{' '}
                  {stories.find((s: SpecStory) => s.id === id)?.title ?? ''}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Acceptance criteria">
          {card.criteria.length === 0 ? (
            <p className="text-[13px] text-dim">None yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[13px] leading-snug text-white/85">
              {card.criteria.map((c, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-dim">–</span>
                  <span>{criterionText(c)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Dependencies card={card} snapshot={snapshot} />

        {card.output && (
          <Section
            title={`Handed in${card.route[0]?.clankId ? ` by ${name(card.route[0].clankId)}` : ''}`}
          >
            <Fields fields={card.output} />
          </Section>
        )}
        {card.reviews.map((review, i) => {
          const { clankId, at, ...rest } = review;
          return (
            <Section key={i} title={`Passed by ${name(clankId)}`}>
              <span className="text-[11px] text-dim">{formatAgo(new Date(at))}</span>
              <Fields fields={rest} />
            </Section>
          );
        })}

        {card.bounceHistory.length > 0 && (
          <Section title="Sent back">
            <ol className="flex flex-col gap-2 text-[13px]">
              {card.bounceHistory.map((b) => (
                <li key={b.id} className="rounded-xl border border-line bg-black/20 px-3 py-2">
                  <p>
                    <span className="text-white">{b.from === 'user' ? 'You' : name(b.from)}</span>{' '}
                    <span className="text-dim">→ {name(b.to)}</span>: {b.reason}
                  </p>
                  {b.issues.length > 0 && (
                    <ol className="mt-1 list-decimal pl-5 text-white/75">
                      {b.issues.map((issue, i) => (
                        <li key={i}>{issue}</li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ol>
          </Section>
        )}

        <Section title="Chats">
          <ul className="flex flex-col gap-1">
            {card.conversationId && (
              <li>
                <ChatLink
                  onClick={() => go({ page: 'chat', id: card.conversationId! })}
                  label={`Where ${card.createdBy === 'user' ? 'it' : name(card.createdBy)} came up`}
                  colour={crew.find((c) => c.id === card.createdBy)?.avatar}
                />
              </li>
            )}
            {card.runs.map((run) => (
              <li key={run.conversationId}>
                <ChatLink
                  onClick={() => go({ page: 'chat', id: run.conversationId })}
                  label={`${name(run.clankId)}'s ${{ maker: 'work', checker: 'check', helper: 'answer', planner: 'planning' }[run.role]}`}
                  colour={crew.find((c) => c.id === run.clankId)?.avatar}
                  live={run.replying}
                />
              </li>
            ))}
            {!card.conversationId && card.runs.length === 0 && (
              <li className="text-[13px] text-dim">Nobody has worked on it yet.</li>
            )}
          </ul>
        </Section>

        {(card.usage.tokens > 0 || card.usage.ms > 0) && (
          <Section title="Spent">
            <p className="text-[13px] text-white/80">{usageText(card.usage)}</p>
          </Section>
        )}

        <Section title="Activity">
          <ol className="flex flex-col gap-1 font-mono text-[12px]">
            {events.map((e) => (
              <li key={e.id} className="flex gap-3">
                <span className="shrink-0 text-dim">
                  {e.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="text-white/80">
                  {actorName(e.actor, crew)} <span className="text-dim">›</span> {e.text}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </aside>
  );
}

/** What approving does with the ticket's work, in words. */
function mergeWords(card: TicketCard): string | null {
  const d = card.delivery;
  if (!d?.changed) return null;
  if (d.pr) return `Approving merges PR #${d.pr.number} on GitHub, as you.`;
  return `Approving merges \`${d.branch}\` into \`${d.base}\` in the project's folder.`;
}

/** What the user can do about the ticket where it is now. */
function Actions(props: {
  card: TicketCard;
  snapshot: BoardSnapshot;
  draftVersion: number | null;
  onClose: () => void;
}) {
  const { card } = props;
  const trpc = useTRPC();
  const { go } = useNav();
  const crew = useCrew();
  const [writing, setWriting] = useState<'changes' | 'retry' | 'reject' | null>(null);
  const [text, setText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const done = () => {
    setWriting(null);
    setText('');
  };
  const approve = useMutation(trpc.board.approve.mutationOptions());
  const changes = useMutation(trpc.board.requestChanges.mutationOptions({ onSuccess: done }));
  const reject = useMutation(trpc.board.reject.mutationOptions({ onSuccess: done }));
  const retry = useMutation(trpc.board.retry.mutationOptions({ onSuccess: done }));
  const accept = useMutation(trpc.board.accept.mutationOptions());
  const pause = useMutation(trpc.board.pause.mutationOptions());
  const move = useMutation(trpc.board.move.mutationOptions());
  const resolve = useMutation(trpc.board.resolveConflicts.mutationOptions());
  const remove = useMutation(trpc.board.remove.mutationOptions({ onSuccess: props.onClose }));
  const error = [approve, changes, reject, retry, accept, pause, move, resolve, remove].find(
    (m) => m.error,
  )?.error;
  const turn = card.detour?.clankId ?? card.route[card.step]?.clankId;
  const run = card.runs.find((r) => r.clankId === turn && r.role !== 'planner');
  const clank = crew.find((c) => c.id === run?.clankId);
  const merge = mergeWords(card);
  const conflict = card.delivery?.error && /conflict/i.test(card.delivery.error);

  let body: ReactNode = null;
  if (card.column === 'ready') {
    body = (
      <>
        <p className="text-[13px] text-white/85">
          {card.state === 'looping'
            ? (card.reason ?? 'It kept bouncing, so it came to you.')
            : card.type === 'spec'
              ? `Atlas signed off spec v${props.draftVersion ?? card.specVersion ?? ''}. Read it on the Spec tab, then approve it, and Atlas plans the board from it.`
              : 'Signed off and ready for you.'}
        </p>
        {merge && !card.delivery?.error && (
          <p className="text-[12px] text-dim">
            <InlineCode text={merge} />
          </p>
        )}
        {card.delivery?.error && (
          <p className="text-[13px] text-amber-100">
            <InlineCode text={card.delivery.error} />
          </p>
        )}
        <span className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={approve.isPending}
            onClick={() => approve.mutate(card.id)}
          >
            {card.type === 'spec'
              ? `Approve spec v${props.draftVersion ?? card.specVersion ?? ''}`
              : approve.isPending
                ? 'Merging…'
                : merge
                  ? card.delivery?.error
                    ? 'Try the merge again'
                    : 'Approve and merge'
                  : 'Approve'}
          </Button>
          {conflict && card.route[0]?.clankId && (
            <Button size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate(card.id)}>
              Send back to resolve the conflicts
            </Button>
          )}
          <Button size="sm" onClick={() => setWriting('changes')}>
            Request changes…
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setWriting('reject')}>
            Reject…
          </Button>
          {card.type === 'spec' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => go({ page: 'project', id: props.snapshot.project.id, tab: 'spec' })}
            >
              Read the spec
            </Button>
          )}
        </span>
      </>
    );
  } else if (card.state === 'question' && run) {
    body = (
      <>
        <p className="text-[13px] whitespace-pre-wrap text-white/85">{card.reason}</p>
        <Button
          size="sm"
          variant="primary"
          onClick={() => go({ page: 'chat', id: run.conversationId })}
        >
          Answer {clank?.name ?? 'it'}
        </Button>
      </>
    );
  } else if (card.state === 'failed' || card.state === 'paused') {
    body = (
      <>
        <p className="text-[13px] text-white/85">
          {card.reason ?? (card.state === 'paused' ? 'Paused.' : 'It failed.')}
        </p>
        <span className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() => retry.mutate({ id: card.id, note: '' })}
          >
            Carry on
          </Button>
          <Button size="sm" onClick={() => setWriting('retry')}>
            Carry on with a note…
          </Button>
          {run && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => go({ page: 'chat', id: run.conversationId })}
            >
              Open the run
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setWriting('reject')}>
            Reject…
          </Button>
        </span>
      </>
    );
  } else if (card.live?.asking) {
    body = (
      <Button
        size="sm"
        variant="primary"
        onClick={() => go({ page: 'chat', id: card.live!.conversationId })}
      >
        {card.live.label}
      </Button>
    );
  } else if (card.proposed) {
    body = (
      <>
        <p className="text-[13px] text-white/85">
          {crew.find((c) => c.id === card.createdBy)?.name ?? 'A clank'} proposed this. Take it on,
          or delete it.
        </p>
        <Button size="sm" variant="primary" onClick={() => accept.mutate(card.id)}>
          Take it on
        </Button>
      </>
    );
  }
  const working = card.state === 'working' || card.state === 'waiting';
  const underway = card.column === 'build' || card.column === 'review';

  return (
    <div className="flex flex-col gap-2.5">
      {body && (
        <div className="flex flex-col items-start gap-2.5 rounded-2xl border border-amber-300/25 bg-amber-300/[0.05] p-3.5">
          {body}
        </div>
      )}
      {writing && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (writing === 'changes') changes.mutate({ id: card.id, comment: text });
            else if (writing === 'reject') reject.mutate({ id: card.id, reason: text });
            else retry.mutate({ id: card.id, note: text });
          }}
        >
          <textarea
            autoFocus
            rows={3}
            aria-label={
              writing === 'changes' ? 'What to change' : writing === 'reject' ? 'Why' : 'A note'
            }
            placeholder={
              writing === 'changes'
                ? `What should change? ${card.route[0]?.clankId ? (crew.find((c) => c.id === card.route[0]!.clankId)?.name ?? 'Its maker') : 'Its maker'} gets this.`
                : writing === 'reject'
                  ? "Why not (optional). It's done without merging, its pull request closes and the crew's notes from it go."
                  : 'A note to go with it'
            }
            className={`${inputClass} h-auto py-2`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <span className="flex gap-2">
            <Button
              size="sm"
              variant={writing === 'reject' ? 'danger' : 'primary'}
              type="submit"
              disabled={
                (writing === 'changes' && !text.trim()) ||
                changes.isPending ||
                retry.isPending ||
                reject.isPending
              }
            >
              {writing === 'reject' ? `Reject ${card.key}` : 'Send'}
            </Button>
            <Button size="sm" variant="ghost" onClick={done}>
              Cancel
            </Button>
          </span>
        </form>
      )}
      {(working && underway) || card.column === 'backlog' ? (
        <span className="flex flex-wrap justify-end gap-2">
          {working && underway && (
            <Button size="sm" variant="ghost" onClick={() => pause.mutate(card.id)}>
              Pause
            </Button>
          )}
          {card.column === 'backlog' && !card.proposed && (
            <Button
              size="sm"
              variant="ghost"
              title="Start it now, if what it waits on is done and there's a free slot"
              onClick={() => move.mutate({ id: card.id, column: 'build' })}
            >
              Start now
            </Button>
          )}
          {card.column === 'backlog' &&
            (confirmDelete ? (
              <span className="flex gap-2">
                <Button size="sm" variant="danger" onClick={() => remove.mutate(card.id)}>
                  Delete {card.key}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                <TrashIcon /> Delete
              </Button>
            ))}
        </span>
      ) : null}
      {error && <ErrorText>{error.message}</ErrorText>}
    </div>
  );
}

/** Text with `code` in mono, as the orchestrator writes it. */
function InlineCode({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((piece, i) =>
        piece.startsWith('`') && piece.endsWith('`') ? (
          <code key={i} className="font-mono text-[12px] text-white">
            {piece.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{piece}</span>
        ),
      )}
    </>
  );
}

/** The route as dots: the clank it's with lit, the user at the end. */
function Route({ card, name }: { card: TicketCard; name: (id: string) => string }) {
  const steps = [
    ...card.route.map((s, i) => ({
      label: s.clankId ? name(s.clankId) : `Any ${TYPE_LABELS[card.type]} maker`,
      at: i === card.step && !card.doneAt && !card.detour,
      past: i < card.step || card.doneAt !== null,
    })),
    {
      label: 'You',
      at: card.step >= card.route.length && !card.doneAt,
      past: card.doneAt !== null,
    },
  ];
  return (
    <>
      <ol className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {steps.map((step, i) => (
          <li key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-dim">→</span>}
            <span
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 ${step.at ? 'border-accent/60 bg-accent/10 text-white' : step.past ? 'border-line text-white/70' : 'border-line text-dim'}`}
            >
              <span
                className={`size-1.5 rounded-full ${step.at ? 'bg-accent' : step.past ? 'bg-accent-2' : 'bg-white/20'}`}
              />
              {step.label}
            </span>
          </li>
        ))}
      </ol>
      {card.detour && (
        <p className="text-[12px] text-accent">
          With {name(card.detour.clankId)} meanwhile, answering {name(card.detour.from)}. It goes
          back to {name(card.detour.from)} after.
        </p>
      )}
    </>
  );
}

/** Checks dropped from the ticket, and dropping an optional one that hasn't happened yet. */
function Checks(props: {
  card: TicketCard;
  snapshot: BoardSnapshot;
  name: (id: string) => string;
}) {
  const { card, snapshot } = props;
  const trpc = useTRPC();
  const crew = useCrew();
  const [skipping, setSkipping] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const skip = useMutation(
    trpc.board.skip.mutationOptions({
      onSuccess: () => {
        setSkipping(null);
        setReason('');
      },
    }),
  );
  const restore = useMutation(trpc.board.restore.mutationOptions());
  if (card.doneAt) return null;
  const optional = card.route
    .map((s, i) => ({ ...s, i }))
    .filter(
      (s) =>
        s.role === 'checker' &&
        s.clankId &&
        s.i > card.step &&
        snapshot.project.optionalChecks.includes(`${s.clankId}:${card.type}`),
    );
  return (
    <div className="flex flex-col gap-1.5">
      {card.skipped.map((s) => (
        <p key={s.clankId} className="flex items-center gap-2 text-[12px] text-dim">
          <span className="flex-1">
            {props.name(s.clankId)}'s check skipped by {s.by === 'user' ? 'you' : props.name(s.by)}:{' '}
            {s.reason}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => restore.mutate({ id: card.id, clankId: s.clankId })}
          >
            Put it back
          </Button>
        </p>
      ))}
      {skipping ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            skip.mutate({ id: card.id, clankId: skipping, reason });
          }}
        >
          <input
            autoFocus
            aria-label="Why it can be skipped"
            placeholder={`Why ${props.name(skipping)}'s check isn't needed, shown on the card`}
            className={`${inputClass} h-8 flex-1 text-[13px]`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={!reason.trim()}>
            Skip it
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSkipping(null)}>
            Cancel
          </Button>
        </form>
      ) : (
        optional.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {optional.map((s) => (
              <Button
                key={s.clankId}
                size="sm"
                variant="ghost"
                onClick={() => setSkipping(s.clankId)}
              >
                Skip {crew.find((c) => c.id === s.clankId)?.name ?? s.clankId}'s check…
              </Button>
            ))}
          </span>
        )
      )}
      {(skip.error ?? restore.error) && (
        <ErrorText>{(skip.error ?? restore.error)!.message}</ErrorText>
      )}
    </div>
  );
}

/** Where the ticket's work is: its branch, its pull request, and pushing it again. */
function Delivery({ card, hasRepo }: { card: TicketCard; hasRepo: boolean }) {
  const trpc = useTRPC();
  const republish = useMutation(trpc.board.republish.mutationOptions());
  const d = card.delivery!;
  return (
    <Section title="Branch">
      <p className="text-[13px] text-white/85">
        <code className="font-mono text-[12px]">{d.branch}</code> into{' '}
        <code className="font-mono text-[12px]">{d.base}</code>
        {!d.changed && <span className="text-dim"> · no changes</span>}
        {d.merged && <span className="text-accent-2"> · merged as {d.merged.slice(0, 7)}</span>}
      </p>
      {d.pr && (
        <p className="flex items-center gap-2 text-[13px]">
          <a
            href={d.pr.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            PR #{d.pr.number}
          </a>
          <span className="text-dim">{d.pr.state}</span>
          {d.pr.ci && (
            <span className="font-mono text-[12px] text-white/70">{ciText(d.pr.ci)}</span>
          )}
        </p>
      )}
      {d.error && !card.doneAt && card.column !== 'ready' && (
        <p className="text-[12px] text-amber-200">
          <InlineCode text={d.error} />
        </p>
      )}
      {hasRepo && d.changed && !d.merged && (d.error || !d.pr) && (
        <Button
          size="sm"
          className="self-start"
          disabled={republish.isPending}
          onClick={() => republish.mutate(card.id)}
        >
          {d.pr ? 'Push again' : 'Push and open the pull request'}
        </Button>
      )}
      {republish.error && <ErrorText>{republish.error.message}</ErrorText>}
    </Section>
  );
}

function Assignee({ card, snapshot }: { card: TicketCard; snapshot: BoardSnapshot }) {
  const trpc = useTRPC();
  const crew = useCrew();
  const assign = useMutation(trpc.board.assign.mutationOptions());
  const makers = crew.filter(
    (c) => c.outputs.includes(card.type) && snapshot.project.crew.some((m) => m.clankId === c.id),
  );
  const started = card.step >= 0;
  const current = started ? card.route[0]?.clankId : card.assignee;
  return (
    <Section title="Who makes it">
      <select
        aria-label="Who makes it"
        className={`${inputClass} h-9 text-[13px]`}
        value={current ?? ''}
        disabled={assign.isPending}
        onChange={(e) => assign.mutate({ id: card.id, clankId: e.target.value || null })}
      >
        {!started && <option value="">Open: the first free {TYPE_LABELS[card.type]} maker</option>}
        {makers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {started && (
        <p className="text-[12px] text-dim">
          Giving it to another maker stops this run; the work so far stays on its branch, and the
          new maker carries on from there.
        </p>
      )}
      {assign.error && <ErrorText>{assign.error.message}</ErrorText>}
    </Section>
  );
}

function Dependencies({ card, snapshot }: { card: TicketCard; snapshot: BoardSnapshot }) {
  const trpc = useTRPC();
  const link = useMutation(trpc.board.link.mutationOptions());
  const editable = card.column === 'backlog';
  const deps = card.dependsOn
    .map((id) => snapshot.tickets.find((t) => t.id === id))
    .filter((t): t is TicketCard => t !== undefined);
  const candidates = snapshot.tickets.filter(
    (t) => t.id !== card.id && !card.dependsOn.includes(t.id),
  );
  if (!editable && deps.length === 0) return null;
  return (
    <Section title="Waits on">
      <ul className="flex flex-col gap-1">
        {deps.length === 0 && (
          <li className="text-[13px] text-dim">Nothing. It can start any time.</li>
        )}
        {deps.map((t) => (
          <li key={t.id} className="flex items-center gap-2 text-[13px]">
            <span className={t.column === 'done' ? 'text-accent-2' : 'text-dim'}>
              {t.column === 'done' ? '✓' : '○'}
            </span>
            <span className="font-mono text-[12px] text-dim">{t.key}</span>
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            {editable && (
              <IconButton
                label={`Stop waiting on ${t.key}`}
                onClick={() => link.mutate({ id: card.id, dependsOn: t.id, remove: true })}
              >
                <XIcon />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {editable && candidates.length > 0 && (
        <select
          aria-label="Wait on another ticket"
          className={`${inputClass} h-9 text-[13px]`}
          value=""
          onChange={(e) =>
            e.target.value && link.mutate({ id: card.id, dependsOn: e.target.value, remove: false })
          }
        >
          <option value="">Wait on another ticket…</option>
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.key} {t.title}
            </option>
          ))}
        </select>
      )}
      {link.error && <ErrorText>{link.error.message}</ErrorText>}
    </Section>
  );
}

/** What a clank handed in, field by field. */
function Fields({ fields }: { fields: Record<string, unknown> }) {
  const entries = Object.entries(fields).filter(
    ([key, value]) => key !== 'type' && value !== undefined && value !== null && value !== '',
  );
  return (
    <dl className="flex flex-col gap-2 text-[13px]">
      {entries.map(([key, value]) => (
        <div key={key} className="flex flex-col gap-0.5">
          <dt className="text-[11px] text-dim">{key.replace(/_/g, ' ')}</dt>
          <dd className="text-white/85">
            {typeof value === 'string' ? (
              <Markdown text={value} />
            ) : Array.isArray(value) ? (
              <ul className="flex list-disc flex-col gap-0.5 pl-4">
                {value.map((item, i) => (
                  <li key={i}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>
                ))}
              </ul>
            ) : (
              <code className="font-mono text-[12px]">{JSON.stringify(value)}</code>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ChatLink(props: {
  onClick: () => void;
  label: string;
  colour: Parameters<typeof Avatar>[0]['colour'] | undefined;
  live?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.04]"
    >
      <Avatar colour={props.colour ?? 'slate'} size="xs" live={props.live ?? false} />
      <span className="flex-1">{props.label}</span>
      <span className="text-dim">›</span>
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-medium tracking-[0.15em] text-dim uppercase">{title}</h3>
      {children}
    </section>
  );
}
