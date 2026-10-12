import { ACTIVE_RUN_STATUSES, type RoutineRunInfo, type ScheduledActionInfo } from '@clanks/core';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { COLUMN_LABELS, usageText } from '../../lib/board';
import { useNav } from '../../lib/nav';
import { RUN_STATUS, timeIn, toLocalInput, when } from '../../lib/routines';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, ErrorText, inputClass } from '../ui';
import { ActionPreview } from './shared';

/** What can be done with one action, by where it stands. */
export function ActionControls(props: { action: ScheduledActionInfo; zone: string; now: Date }) {
  const { action } = props;
  const trpc = useTRPC();
  const [editing, setEditing] = useState<'text' | 'time' | null>(null);
  const [text, setText] = useState(action.text ?? '');
  const [at, setAt] = useState(() => toLocalInput(action.executeAt));
  const [error, setError] = useState<string | null>(null);
  const options = {
    onError: (e: { message: string }) => setError(e.message),
    onSuccess: () => {
      setError(null);
      setEditing(null);
    },
  };
  const approve = useMutation(trpc.routines.approveAction.mutationOptions(options));
  const edit = useMutation(trpc.routines.editAction.mutationOptions(options));
  const postNow = useMutation(trpc.routines.postNow.mutationOptions(options));
  const reschedule = useMutation(trpc.routines.reschedule.mutationOptions(options));
  const cancel = useMutation(trpc.routines.cancelAction.mutationOptions(options));
  const decide = useMutation(trpc.routines.decideUnknown.mutationOptions(options));
  const busy = [approve, edit, postNow, reschedule, cancel, decide].some((m) => m.isPending);
  const { status } = action;
  const open = status === 'pending_approval' || status === 'approved';
  const stale = status === 'missed' || status === 'failed';
  const ready = action.problems.length === 0 && action.payload !== null;
  const moved = new Date(at);
  const validTime = !Number.isNaN(+moved) && +moved > +props.now;

  if (status === 'executing' || status === 'cancelled') return null;
  if (status === 'done') {
    if (!action.result?.handedOff || +action.executeAt <= +props.now) return null;
    return (
      <footer className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="danger" disabled={busy} onClick={() => cancel.mutate(action.id)}>
          Take it back
        </Button>
        {error && <ErrorText>{error}</ErrorText>}
      </footer>
    );
  }
  if (status === 'unknown') {
    return (
      <footer className="flex flex-col gap-2">
        <p className="text-[13px] text-white/80">
          Check {action.integrationName}, then say what happened. clanks won't send it again on a
          guess.
        </p>
        <span className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => decide.mutate({ id: action.id, decision: 'sent' })}
          >
            It went out
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => decide.mutate({ id: action.id, decision: 'send' })}
          >
            It didn't: send it now
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => decide.mutate({ id: action.id, decision: 'drop' })}
          >
            Drop it
          </Button>
        </span>
        {error && <ErrorText>{error}</ErrorText>}
      </footer>
    );
  }
  return (
    <footer className="flex flex-col gap-2.5">
      {editing === 'text' && (
        <span className="flex flex-col gap-2">
          <textarea
            aria-label="What it says"
            className={`${inputClass} h-28 py-2.5 leading-relaxed`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || text.trim() === '' || text === action.text}
              onClick={() => edit.mutate({ id: action.id, text })}
            >
              Save the change
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Leave it
            </Button>
            {status === 'approved' && (
              <span className="text-[12px] text-dim">
                Changing it asks for your approval again.
              </span>
            )}
          </span>
        </span>
      )}
      {editing === 'time' && (
        <span className="flex flex-wrap items-center gap-2">
          <input
            type="datetime-local"
            aria-label="When it goes out, in this computer's time"
            className={`${inputClass} h-9`}
            value={at}
            onChange={(e) => setAt(e.target.value)}
          />
          {stale ? (
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !validTime || !ready}
              onClick={() => reschedule.mutate({ id: action.id, at: moved })}
            >
              Approve it for then
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !validTime}
              onClick={() => edit.mutate({ id: action.id, executeAt: moved })}
            >
              Move it
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
            Leave it
          </Button>
          {validTime && (
            <span className="text-[12px] text-dim">
              {when(moved, props.zone, props.now)}
              {status === 'approved' ? ' · it asks for your approval again' : ''}
            </span>
          )}
        </span>
      )}
      {editing === null && (
        <span className="flex flex-wrap items-center gap-2">
          {status === 'pending_approval' && !action.runId && (
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !ready}
              onClick={() => approve.mutate(action.id)}
            >
              Approve for {timeIn(action.executeAt, props.zone)}
            </Button>
          )}
          {stale && (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !ready}
                onClick={() => postNow.mutate(action.id)}
              >
                Post now
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setEditing('time')}>
                Reschedule
              </Button>
            </>
          )}
          {open && action.text !== null && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing('text')}>
              Change the words
            </Button>
          )}
          {open && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing('time')}>
              Change the time
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => cancel.mutate(action.id)}
          >
            {stale ? 'Dismiss' : 'Take it off the schedule'}
          </Button>
        </span>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </footer>
  );
}

/**
 * One run of a routine: its tickets, and everything it will send, each as it will appear. When
 * the work is signed off, this is where the user approves it all, together or one by one.
 */
export function RunCard(props: {
  run: RoutineRunInfo;
  zone: string;
  now: Date;
  /** Shown open, with its actions in full. */
  open?: boolean;
}) {
  const { run, zone, now } = props;
  const trpc = useTRPC();
  const { go } = useNav();
  const [open, setOpen] = useState(props.open ?? false);
  const [error, setError] = useState<string | null>(null);
  const options = {
    onError: (e: { message: string }) => setError(e.message),
    onSuccess: () => setError(null),
  };
  const approve = useMutation(trpc.routines.approveRun.mutationOptions(options));
  const answer = useMutation(trpc.routines.answerMissed.mutationOptions(options));
  const cancel = useMutation(trpc.routines.cancelRun.mutationOptions(options));
  const refresh = useMutation(trpc.routines.refreshRun.mutationOptions(options));
  const status = RUN_STATUS[run.status];
  const pending = run.actions.filter((a) => a.status === 'pending_approval');
  const sendable = pending.filter((a) => a.problems.length === 0 && a.payload !== null);
  const awaiting = run.status === 'awaiting_approval';
  const active = (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status);
  const started =
    run.trigger.kind === 'event'
      ? `started by ${run.trigger.event.name}${run.trigger.event.detail.tag ? ` ${run.trigger.event.detail.tag}` : ''}`
      : run.trigger.kind === 'manual'
        ? 'run by hand'
        : run.trigger.kind === 'late'
          ? 'started late'
          : null;

  return (
    <li
      id={`run-${run.id}`}
      className={`flex flex-col rounded-2xl border ${awaiting || run.asks ? 'border-amber-300/30 bg-amber-300/[0.04]' : 'border-line bg-panel/40'}`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left"
      >
        <span className="text-[14px] font-medium">{run.routineName}</span>
        <span className="text-[13px] text-dim">
          {when(run.scheduledFor, zone, now)}
          {started ? ` · ${started}` : ''}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {run.usage.tokens > 0 && (
            <span className="font-mono text-[11px] text-dim">{usageText(run.usage)}</span>
          )}
          <Badge tone={status.tone}>{status.text}</Badge>
          <span className={`text-dim transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        </span>
      </button>
      {(open || awaiting || run.asks) && (
        <div className="flex flex-col gap-4 border-t border-line px-4 py-4">
          {run.reason && <p className="text-[13px] text-white/80">{run.reason}</p>}
          {run.asks && (
            <span className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={answer.isPending}
                onClick={() => answer.mutate({ runId: run.id, answer: 'run' })}
              >
                Run it now
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={answer.isPending}
                onClick={() => answer.mutate({ runId: run.id, answer: 'skip' })}
              >
                Skip it
              </Button>
            </span>
          )}
          {Object.keys(run.inputs).length > 0 && (
            <p className="font-mono text-[12px] text-dim">
              {Object.entries(run.inputs)
                .map(([name, value]) => `${name}: ${value}`)
                .join(' · ')}
            </p>
          )}
          {run.tickets.length > 0 && (
            <ul className="flex flex-col gap-1">
              {run.tickets.map((ticket) => (
                <li key={ticket.ticketId}>
                  <button
                    type="button"
                    onClick={() =>
                      go({
                        page: 'project',
                        id: run.projectId,
                        tab: 'board',
                        ticket: ticket.ticketId,
                      })
                    }
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-white/[0.05]"
                  >
                    <span className="font-mono text-[11px] text-dim">{ticket.key}</span>
                    <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
                    {ticket.dueAt && ticket.column !== 'done' && ticket.column !== 'ready' && (
                      <span
                        className={`font-mono text-[11px] ${+new Date(ticket.dueAt) < +now ? 'text-amber-200' : 'text-dim'}`}
                      >
                        due {timeIn(new Date(ticket.dueAt), zone)}
                      </span>
                    )}
                    <span className="text-[12px] text-dim">{COLUMN_LABELS[ticket.column]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {run.actions.map((action) => (
            <ActionPreview key={action.id} action={action} zone={zone} now={now}>
              <ActionControls action={action} zone={zone} now={now} />
            </ActionPreview>
          ))}
          {awaiting && (
            <span className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                disabled={approve.isPending || sendable.length === 0}
                onClick={() =>
                  approve.mutate({ runId: run.id, actionIds: sendable.map((a) => a.id) })
                }
              >
                {sendable.length === 1
                  ? `Approve it for ${timeIn(sendable[0]!.executeAt, zone)}`
                  : `Approve all ${sendable.length}`}
              </Button>
              {pending.length > sendable.length && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={refresh.isPending}
                  onClick={() => refresh.mutate(run.id)}
                >
                  Build it again
                </Button>
              )}
              <span className="text-[12px] text-dim">
                Approving freezes each one as shown, and approves the work it was made from. Nothing
                goes out before its time, or after it.
              </span>
            </span>
          )}
          {active && (
            <span>
              <Button
                size="sm"
                variant="ghost"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(run.id)}
              >
                Stop this run
              </Button>
            </span>
          )}
          {error && <ErrorText>{error}</ErrorText>}
        </div>
      )}
    </li>
  );
}
