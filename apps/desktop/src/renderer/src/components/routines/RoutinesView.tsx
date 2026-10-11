import type { BoardSnapshot, RoutineInfo, RoutinesSnapshot } from '@clanks/core';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNav } from '../../lib/nav';
import { ROUTINE_STATUS, RUN_STATUS, fromNow, useNow, useRoutines, when } from '../../lib/routines';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, ErrorText, Switch, inputClass } from '../ui';
import { RoutineSummary } from './RoutineCard';
import { RoutineEditor } from './RoutineEditor';
import { ActionControls, RunCard } from './RunCard';
import { ScheduleView } from './ScheduleView';
import { ActionPreview, Dialog, Field, Heading } from './shared';

type View = 'routines' | 'schedule' | 'history';

/**
 * A project's routines: what needs the user first, then every routine with its trigger, its next
 * run, its last result and its switch; the week ahead; and what has run.
 */
export function RoutinesView(props: {
  snapshot: BoardSnapshot;
  /** A run, an action or a routine to show, such as the one a notification was about. */
  focus: string | null;
}) {
  const projectId = props.snapshot.project.id;
  const trpc = useTRPC();
  const { go } = useNav();
  const now = useNow();
  const routines = useRoutines(projectId);
  const [view, setView] = useState<View>('routines');
  const [editing, setEditing] = useState<RoutineInfo | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = {
    onError: (e: { message: string }) => setError(e.message),
    onSuccess: () => setError(null),
  };
  const setPaused = useMutation(trpc.routines.setPaused.mutationOptions(options));
  const fromTemplate = useMutation(trpc.routines.fromTemplate.mutationOptions(options));
  const focus = props.focus;

  // What a notification was about is brought into view once it's on the page.
  useEffect(() => {
    if (!focus || !routines) return;
    const element =
      document.getElementById(`action-${focus}`) ?? document.getElementById(`run-${focus}`);
    element?.scrollIntoView({ block: 'center' });
  }, [focus, routines]);

  if (!routines) return null;
  const { zone } = routines;
  const needing = routines.runs.filter((r) => r.status === 'awaiting_approval' || r.asks);
  // Actions that wait on the user outside a run that's shown above: a campaign's, or a past run's.
  const loose = routines.actions.filter(
    (a) =>
      ['unknown', 'missed', 'failed'].includes(a.status) ||
      (a.status === 'pending_approval' && !a.runId),
  );
  const drafts = routines.routines.filter((r) => r.status === 'draft' && r.createdBy !== 'user');
  const openRun = (runId: string) => {
    setView('history');
    go({ page: 'project', id: projectId, tab: 'routines', focus: runId });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
        {routines.paused && (
          <p
            role="status"
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] px-4 py-3 text-[13px] text-amber-100"
          >
            <span className="flex-1">
              Every routine is paused. Nothing starts and nothing goes out until you let them go on;
              what would have run in between isn't made up afterwards.
            </span>
            <Button size="sm" variant="primary" onClick={() => setPaused.mutate(false)}>
              Let routines go on
            </Button>
          </p>
        )}

        {(needing.length > 0 || loose.length > 0 || drafts.length > 0) && (
          <section className="flex flex-col gap-3" aria-label="Needs you">
            <Heading>Needs you</Heading>
            <ul className="flex flex-col gap-3">
              {needing.map((run) => (
                <RunCard key={run.id} run={run} zone={zone} now={now} open />
              ))}
            </ul>
            {loose.map((action) => (
              <div key={action.id} className="flex flex-col gap-1.5">
                <span className="text-[12px] text-dim">{action.source}</span>
                <ActionPreview action={action} zone={zone} now={now}>
                  <ActionControls action={action} zone={zone} now={now} />
                </ActionPreview>
              </div>
            ))}
            {drafts.map((routine) => (
              <RoutineSummary key={routine.id} routine={routine} projectId={projectId} />
            ))}
          </section>
        )}

        <header className="flex flex-wrap items-center gap-2">
          <span className="flex gap-1" role="tablist" aria-label="View">
            {(
              [
                ['routines', 'Routines'],
                ['schedule', 'Schedule'],
                ['history', 'Run history'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={`rounded-full px-3 py-1 text-[13px] ${view === id ? 'bg-white/[0.08] text-white' : 'text-dim hover:text-white'}`}
              >
                {label}
              </button>
            ))}
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {routines.templates.length > 0 && (
              <select
                aria-label="Start from a template"
                className={`${inputClass} h-8 text-[13px]`}
                value=""
                onChange={(e) =>
                  e.target.value && fromTemplate.mutate({ projectId, templateId: e.target.value })
                }
              >
                <option value="">From a template…</option>
                {routines.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            )}
            <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>
              Import YAML
            </Button>
            <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
              New routine
            </Button>
          </span>
        </header>
        {error && <ErrorText>{error}</ErrorText>}

        {view === 'routines' &&
          (routines.routines.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line px-5 py-8 text-center text-[14px] text-dim">
              No routines yet. Ask Atlas for one in chat, such as "every Friday afternoon, have
              Prism make a promo banner and post it at 5pm", or make one here. A routine only ever
              sends what you've approved, at the time you approved it for.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {routines.routines.map((routine) => (
                <RoutineRow
                  key={routine.id}
                  routine={routine}
                  snapshot={routines}
                  now={now}
                  open={focus === routine.id}
                  onEdit={() => setEditing(routine)}
                />
              ))}
            </ul>
          ))}
        {view === 'schedule' && <ScheduleView snapshot={routines} now={now} onOpenRun={openRun} />}
        {view === 'history' && (
          <>
            {routines.runs.length === 0 ? (
              <p className="text-[13px] text-dim">Nothing has run yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {routines.runs.map((run) => (
                  <RunCard key={run.id} run={run} zone={zone} now={now} open={focus === run.id} />
                ))}
              </ul>
            )}
            {routines.actions.some((a) => !a.runId) && (
              <section className="flex flex-col gap-3">
                <Heading>Posts from campaigns</Heading>
                {routines.actions
                  .filter((a) => !a.runId)
                  .map((action) => (
                    <div key={action.id} className="flex flex-col gap-1.5">
                      <span className="text-[12px] text-dim">{action.source}</span>
                      <ActionPreview action={action} zone={zone} now={now}>
                        <ActionControls action={action} zone={zone} now={now} />
                      </ActionPreview>
                    </div>
                  ))}
              </section>
            )}
          </>
        )}
      </div>
      {editing && (
        <RoutineEditor
          projectId={projectId}
          routine={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {importing && <ImportRoutine projectId={projectId} onClose={() => setImporting(false)} />}
    </div>
  );
}

/** One routine in the list: its trigger in words, its next run, its last result, and its switch. */
function RoutineRow(props: {
  routine: RoutineInfo;
  snapshot: RoutinesSnapshot;
  now: Date;
  open: boolean;
  onEdit: () => void;
}) {
  const { routine, now } = props;
  const trpc = useTRPC();
  const [open, setOpen] = useState(props.open);
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = {
    onError: (e: { message: string }) => setError(e.message),
    onSuccess: () => setError(null),
  };
  const activate = useMutation(trpc.routines.activate.mutationOptions(options));
  const pause = useMutation(trpc.routines.pause.mutationOptions(options));
  const duplicate = useMutation(trpc.routines.duplicate.mutationOptions(options));
  const remove = useMutation(trpc.routines.remove.mutationOptions(options));
  const runNow = useMutation(trpc.routines.runNow.mutationOptions(options));
  const exportFile = useMutation(
    trpc.routines.export.mutationOptions({
      ...options,
      onSuccess: (path) => setNotice(path ? `Saved to ${path}` : null),
    }),
  );
  const status = ROUTINE_STATUS[routine.status];
  const next = routine.nextRuns[0];
  const last = routine.lastRun;
  const on = routine.status === 'active';
  const hasInputs = Object.keys(routine.definition.inputs).length > 0;

  return (
    <li id={`routine-${routine.id}`} className="rounded-2xl border border-line bg-panel/40">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium">{routine.definition.name}</span>
            <Badge tone={status.tone}>{status.text}</Badge>
            {routine.problems.length > 0 && <Badge tone="rose">Can't run yet</Badge>}
          </span>
          <span className="truncate text-[13px] text-dim">
            {routine.triggerText || 'No schedule'}
            {on && next && !props.snapshot.paused
              ? ` · next ${when(next, routine.zone, now)} (${fromNow(next, now)})`
              : ''}
          </span>
          {last && (
            <span className="truncate text-[12px] text-dim">
              Last run {fromNow(last.at, now)}: {RUN_STATUS[last.status].text.toLowerCase()}
              {last.reason ? `. ${last.reason}` : ''}
            </span>
          )}
        </button>
        <span className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={routine.problems.length > 0 || runNow.isPending}
            onClick={() => (hasInputs ? setRunning(true) : runNow.mutate({ id: routine.id }))}
          >
            Run now
          </Button>
          <Switch
            label={on ? 'Pause this routine' : 'Turn this routine on'}
            checked={on}
            disabled={(!on && routine.problems.length > 0) || routine.status === 'done'}
            onChange={(checked) =>
              checked ? activate.mutate(routine.id) : pause.mutate(routine.id)
            }
          />
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-4 py-4">
          <RoutineSummary routine={routine} projectId={routine.projectId} />
          <span className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={props.onEdit}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => duplicate.mutate(routine.id)}>
              Duplicate
            </Button>
            <Button size="sm" variant="ghost" onClick={() => exportFile.mutate(routine.id)}>
              Export
            </Button>
            {confirming ? (
              <>
                <Button size="sm" variant="danger" onClick={() => remove.mutate(routine.id)}>
                  Delete it, and what it had waiting
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
                Delete
              </Button>
            )}
            {notice && <span className="text-[12px] text-dim">{notice}</span>}
          </span>
        </div>
      )}
      {error && (
        <div className="px-4 pb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {running && (
        <RunNow
          routine={routine}
          onClose={() => setRunning(false)}
          onRun={(inputs) => {
            runNow.mutate({ id: routine.id, inputs });
            setRunning(false);
          }}
        />
      )}
    </li>
  );
}

/** Run now asks for the routine's inputs, which this one run may change. */
function RunNow(props: {
  routine: RoutineInfo;
  onClose: () => void;
  onRun: (inputs: Record<string, string>) => void;
}) {
  const [inputs, setInputs] = useState<Record<string, string>>({
    ...props.routine.definition.inputs,
  });
  return (
    <Dialog
      title={`Run ${props.routine.definition.name} now`}
      onClose={props.onClose}
      actions={
        <Button size="sm" variant="primary" onClick={() => props.onRun(inputs)}>
          Run it
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-dim">
          This run uses what's here. Anything it sends still waits for your approval.
        </p>
        {Object.keys(props.routine.definition.inputs).map((name) => (
          <Field key={name} label={name}>
            <input
              className={`${inputClass} h-9 text-[13px]`}
              value={inputs[name] ?? ''}
              onChange={(e) => setInputs({ ...inputs, [name]: e.target.value })}
            />
          </Field>
        ))}
      </div>
    </Dialog>
  );
}

/** Pastes a routine as YAML, which becomes an inactive draft. */
function ImportRoutine({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const trpc = useTRPC();
  const [yaml, setYaml] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation(
    trpc.routines.import.mutationOptions({
      onError: (e) => setError(e.message),
      onSuccess: onClose,
    }),
  );
  return (
    <Dialog
      title="Import a routine"
      onClose={onClose}
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={yaml.trim() === '' || add.isPending}
          onClick={() => add.mutate({ projectId, yaml })}
        >
          Add it as a draft
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-dim">
          Paste a routine as YAML, as Export writes it. It's added as a draft: you pick its clanks,
          accounts and times, then turn it on.
        </p>
        <textarea
          aria-label="The routine, as YAML"
          className={`${inputClass} h-80 py-3 font-mono text-[12px] leading-relaxed`}
          value={yaml}
          spellCheck={false}
          placeholder={
            'name: Weekend promo\ntrigger:\n  kind: cron\n  cron: "0 13 * * 5"\nsteps:\n  - id: copy\n    ticket: { clank: buzz, type: campaign, title: "Post for the weekend" }'
          }
          onChange={(e) => setYaml(e.target.value)}
        />
        {error && <pre className="text-[12px] whitespace-pre-wrap text-rose-300">{error}</pre>}
      </div>
    </Dialog>
  );
}
