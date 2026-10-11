import type { ComingUp, RoutineInfo, RoutinesSnapshot } from '@clanks/core';
import { instantOf, parseCron, runsBetween, wallAt } from '@clanks/routines';
import { useMutation } from '@tanstack/react-query';
import { type DragEvent, useState } from 'react';
import { ACTION_STATUS, dateIn, timeIn, when } from '../../lib/routines';
import { useTRPC } from '../../lib/trpc';
import { Button, Dot, ErrorText, inputClass } from '../ui';
import { Dialog, Field } from './shared';

const DRAG_TYPE = 'application/x-clanks-action';
const DAY = 86_400_000;

/** A day as its date in a zone, and as a number to step by. */
function days(now: Date, zone: string, week: number): { key: string; date: Date }[] {
  const today = wallAt(now, zone);
  const start = Date.UTC(today.year, today.month - 1, today.day) + week * 7 * DAY;
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(start + i * DAY);
    return { key: date.toISOString().slice(0, 10), date };
  });
}

/**
 * A week of what's coming: runs that start, and actions that go out, each on its day in the
 * project's time. An action can be dragged to another day, which keeps its time of day. Moving
 * one that's approved asks for approval again.
 */
export function ScheduleView(props: {
  snapshot: RoutinesSnapshot;
  now: Date;
  onOpenRun: (runId: string) => void;
}) {
  const { snapshot, now } = props;
  const trpc = useTRPC();
  const zone = snapshot.zone;
  const [week, setWeek] = useState(0);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState<{ routine: RoutineInfo; at: Date } | null>(null);
  const edit = useMutation(
    trpc.routines.editAction.mutationOptions({
      onError: (e) => setError(e.message),
      onSuccess: () => setError(null),
    }),
  );
  const shown = days(now, zone, week);
  const today = dateIn(now, zone);
  // Every run in the week shown, however far ahead: the snapshot only lists each routine's next few.
  const first = shown[0]!.date;
  const from = Math.max(
    +now,
    instantOf(
      {
        year: first.getUTCFullYear(),
        month: first.getUTCMonth() + 1,
        day: first.getUTCDate(),
        hour: 0,
        minute: 0,
      },
      zone,
    ) - 1,
  );
  const until = from + 8 * DAY;
  const items: ComingUp[] = snapshot.coming.filter((item) => item.kind === 'action');
  for (const routine of snapshot.paused ? [] : snapshot.routines) {
    if (routine.status !== 'active') continue;
    const { trigger } = routine.definition;
    let runs = routine.nextRuns.filter((run) => +run > from && +run <= until);
    if (trigger.kind === 'cron') {
      try {
        runs = runsBetween(parseCron(trigger.cron), from, until, routine.zone, 80).runs;
      } catch {
        // A schedule that can't be read has no runs to show; its routine says why.
      }
    }
    for (const at of runs) {
      items.push({
        kind: 'run',
        projectId: routine.projectId,
        routineId: routine.id,
        runId: null,
        actionId: null,
        at,
        title: routine.definition.name,
        status: null,
      });
    }
  }
  const byDay = new Map<string, ComingUp[]>();
  for (const item of items) {
    const key = dateIn(item.at, zone);
    byDay.set(key, [...(byDay.get(key) ?? []), item]);
  }

  const drop = (day: string) => (event: DragEvent) => {
    setOver(null);
    const id = event.dataTransfer.getData(DRAG_TYPE);
    const action = snapshot.actions.find((a) => a.id === id);
    if (!action) return;
    event.preventDefault();
    if (dateIn(action.executeAt, zone) === day) return;
    const wall = wallAt(action.executeAt, zone);
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    const at = new Date(instantOf({ ...wall, year, month, day: date }, zone));
    if (+at <= +now) {
      setError('That time has passed.');
      return;
    }
    edit.mutate({ id, executeAt: at });
  };

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={week === 0}
          onClick={() => setWeek((w) => w - 1)}
        >
          ‹ Earlier
        </Button>
        <Button size="sm" variant="ghost" disabled={week === 0} onClick={() => setWeek(0)}>
          This week
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setWeek((w) => w + 1)}>
          Later ›
        </Button>
        <span className="text-[12px] text-dim">Times are {zone}'s.</span>
        {snapshot.paused && (
          <span className="text-[12px] text-amber-200">
            Routines are paused, so nothing starts and nothing goes out.
          </span>
        )}
      </header>
      {error && <ErrorText>{error}</ErrorText>}
      <ol className="grid min-h-64 grid-cols-7 gap-2">
        {shown.map(({ key, date }) => {
          const items = (byDay.get(key) ?? []).sort((a, b) => +a.at - +b.at);
          return (
            <li
              key={key}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
                event.preventDefault();
                setOver(key);
              }}
              onDragLeave={() => setOver((o) => (o === key ? null : o))}
              onDrop={drop(key)}
              className={`flex min-w-0 flex-col gap-1.5 rounded-2xl border p-2 transition-colors ${over === key ? 'border-accent/60 bg-accent/[0.06]' : key === today ? 'border-white/20 bg-panel/60' : 'border-line bg-panel/30'}`}
            >
              <span className="flex items-baseline justify-between px-1 text-[12px]">
                <span className={key === today ? 'font-medium text-white' : 'text-dim'}>
                  {date.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}
                </span>
                <span className="font-mono text-[11px] text-dim">
                  {date.toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    timeZone: 'UTC',
                  })}
                </span>
              </span>
              {items.map((item) => {
                const action = item.actionId
                  ? snapshot.actions.find((a) => a.id === item.actionId)
                  : undefined;
                const routine = snapshot.routines.find((r) => r.id === item.routineId);
                if (item.kind === 'run') {
                  return (
                    <button
                      key={`${item.routineId}-${+item.at}`}
                      type="button"
                      title={`${item.title} starts ${when(item.at, zone, now)}`}
                      onClick={() => routine && setPlanning({ routine, at: item.at })}
                      className="flex flex-col gap-0.5 rounded-lg border border-line bg-black/20 px-2 py-1.5 text-left hover:bg-white/[0.05]"
                    >
                      <span className="font-mono text-[11px] text-dim">
                        {timeIn(item.at, zone)} · starts
                      </span>
                      <span className="truncate text-[12px] text-white/90">{item.title}</span>
                    </button>
                  );
                }
                const status = action ? ACTION_STATUS[action.status] : null;
                return (
                  <button
                    key={item.actionId}
                    type="button"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DRAG_TYPE, item.actionId ?? '');
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    title={
                      action?.status === 'approved'
                        ? 'Approved. Moving it asks for your approval again.'
                        : 'Drag it to another day to move it'
                    }
                    onClick={() => item.runId && props.onOpenRun(item.runId)}
                    className={`flex cursor-grab flex-col gap-0.5 rounded-lg border px-2 py-1.5 text-left hover:bg-white/[0.05] ${action?.status === 'pending_approval' ? 'border-amber-300/30 bg-amber-300/[0.06]' : 'border-accent/30 bg-accent/[0.06]'}`}
                  >
                    <span className="flex items-center gap-1.5 font-mono text-[11px] text-dim">
                      <Dot tone={status?.tone ?? 'dim'} />
                      {timeIn(item.at, zone)} · {status?.text.toLowerCase() ?? 'goes out'}
                    </span>
                    <span className="truncate text-[12px] text-white/90">
                      {action?.text ?? item.title}
                    </span>
                    {action && (
                      <span className="truncate text-[11px] text-dim">{action.source}</span>
                    )}
                  </button>
                );
              })}
            </li>
          );
        })}
      </ol>
      {items.length === 0 && (
        <p className="text-[13px] text-dim">
          Nothing is coming up. A routine that's on shows its next runs here, and so does every post
          waiting for its time.
        </p>
      )}
      {planning && (
        <PlanRun
          routine={planning.routine}
          at={planning.at}
          zone={zone}
          now={now}
          onClose={() => setPlanning(null)}
        />
      )}
    </div>
  );
}

/** Changes the inputs one upcoming run uses, leaving the routine's own as they are. */
function PlanRun(props: {
  routine: RoutineInfo;
  at: Date;
  zone: string;
  now: Date;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const { routine } = props;
  const [inputs, setInputs] = useState<Record<string, string>>({ ...routine.definition.inputs });
  const [error, setError] = useState<string | null>(null);
  const plan = useMutation(
    trpc.routines.planRun.mutationOptions({
      onError: (e) => setError(e.message),
      onSuccess: props.onClose,
    }),
  );
  const names = Object.keys(routine.definition.inputs);
  return (
    <Dialog
      title={`${routine.definition.name}, ${when(props.at, props.zone, props.now)}`}
      onClose={props.onClose}
      actions={
        names.length > 0 && (
          <Button
            size="sm"
            variant="primary"
            disabled={plan.isPending}
            onClick={() => plan.mutate({ id: routine.id, at: props.at, inputs })}
          >
            Use these for this run
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {names.length === 0 ? (
          <p className="text-[13px] text-dim">
            This routine has no inputs to change for one run. It starts{' '}
            {when(props.at, props.zone, props.now)}.
          </p>
        ) : (
          <>
            <p className="text-[13px] text-dim">
              This run uses what's here. The routine's own inputs, and its other runs, stay as they
              are.
            </p>
            {names.map((name) => (
              <Field key={name} label={name}>
                <input
                  className={`${inputClass} h-9 text-[13px]`}
                  value={inputs[name] ?? ''}
                  onChange={(e) => setInputs({ ...inputs, [name]: e.target.value })}
                />
              </Field>
            ))}
          </>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Dialog>
  );
}
