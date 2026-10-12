import { type RoutineInfo, durationWords } from '@clanks/core';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { namer } from '../../lib/board';
import { useCrew } from '../../lib/crew';
import { useIntegrations } from '../../lib/integrations';
import { ROUTINE_STATUS, timeIn, useNow, useRoutines, when } from '../../lib/routines';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, ErrorText } from '../ui';
import { RoutineEditor } from './RoutineEditor';

const MISSED_WORDS = {
  skip: 'skipped and recorded',
  run_late: 'started late, once',
  ask: 'left for you to decide',
};

/**
 * A routine in brief: what starts it, in words and as cron, when it next runs, its steps with when
 * each is due or goes out, and its rules. A draft a clank proposed shows like this in the chat,
 * where the user edits it and turns it on. Nothing is scheduled until they do.
 */
export function RoutineSummary(props: { routine: RoutineInfo; projectId: string }) {
  const { routine } = props;
  const trpc = useTRPC();
  const crew = useCrew();
  const now = useNow();
  const name = namer(crew);
  const integrations = useIntegrations()?.integrations ?? [];
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = {
    onError: (e: { message: string }) => setError(e.message),
    onSuccess: () => setError(null),
  };
  const activate = useMutation(trpc.routines.activate.mutationOptions(options));
  const remove = useMutation(trpc.routines.remove.mutationOptions(options));
  const { definition, zone } = routine;
  const status = ROUTINE_STATUS[routine.status];
  const draft = routine.status === 'draft';
  const cron = definition.trigger.kind === 'cron' ? definition.trigger.cron : null;
  const sends = definition.steps.some((s) => s.action);

  return (
    <div
      className={`flex flex-col gap-3.5 rounded-2xl border p-4 ${draft ? 'border-accent/30 bg-accent/[0.05]' : 'border-line bg-black/20'}`}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-medium">{definition.name}</h3>
        <Badge tone={status.tone}>{status.text}</Badge>
        {routine.createdBy !== 'user' && (
          <span className="text-[12px] text-dim">drafted by {name(routine.createdBy)}</span>
        )}
        {routine.replaces && <Badge tone="amber">A change to one that's on</Badge>}
      </header>
      {definition.description && (
        <p className="text-[13px] text-white/80">{definition.description}</p>
      )}
      <p className="text-[13px]">
        <span className="text-white">{routine.triggerText || 'No schedule yet'}</span>
        {cron && <code className="ml-2 font-mono text-[12px] text-dim">{cron}</code>}
      </p>
      {routine.nextRuns.length > 0 && (
        <p className="text-[12px] text-dim">
          Next: {routine.nextRuns.map((run) => when(run, zone, now)).join(' · ')}
        </p>
      )}
      <ol className="flex flex-col gap-1.5">
        {definition.steps.map((step) => {
          const timing = routine.timings.find((t) => t.stepId === step.id);
          return (
            <li key={step.id} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
              <code className="font-mono text-[12px] text-dim">{step.id}</code>
              {step.ticket ? (
                <span className="min-w-0 flex-1">
                  {name(step.ticket.clank)} makes a {step.ticket.type}:{' '}
                  <span className="text-white/80">{step.ticket.title}</span>
                </span>
              ) : (
                <span className="min-w-0 flex-1">
                  {integrations.find((i) => i.id === step.action!.integration)?.name ??
                    step.action!.integration}
                  : {step.action!.operation.replace(/_/g, ' ')}
                  {step.action!.deliver === 'hand_off' ? ', handed over on approval' : ''}
                </span>
              )}
              {timing?.at && (
                <span
                  className="font-mono text-[12px] text-white/70"
                  title={timing.why ?? undefined}
                >
                  {step.action ? 'goes out' : 'due'} {timeIn(timing.at, zone)}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-[12px] text-dim">
        {sends
          ? `You approve everything it sends, as it will appear. A reminder comes ${durationWords(definition.approval.remindBefore)} before the first one, and nothing unapproved goes out. `
          : ''}
        Runs missed while clanks is off are {MISSED_WORDS[routine.missedPolicy]}
        {sends
          ? `; an action never goes out more than ${durationWords(definition.missed.grace)} late.`
          : '.'}
      </p>
      {routine.problems.map((problem) => (
        <p key={problem} className="text-[13px] text-rose-300">
          {problem}
        </p>
      ))}
      {routine.warnings.map((warning) => (
        <p key={warning} className="text-[13px] text-amber-200">
          {warning}
        </p>
      ))}
      {routine.pausedReason && <p className="text-[13px] text-amber-200">{routine.pausedReason}</p>}
      {draft && (
        <footer className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={routine.problems.length > 0 || activate.isPending}
            onClick={() => activate.mutate(routine.id)}
          >
            Activate
          </Button>
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => remove.mutate(routine.id)}
          >
            Discard
          </Button>
          <span className="text-[12px] text-dim">Nothing is scheduled until you activate it.</span>
        </footer>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      {editing && (
        <RoutineEditor
          projectId={props.projectId}
          routine={routine}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/** The card for a routine a clank drafted, where its tool call was in the chat. */
export function ProposedRoutine({
  projectId,
  routineId,
}: {
  projectId: string;
  routineId: string;
}) {
  const snapshot = useRoutines(projectId);
  if (!snapshot) return null;
  const routine = snapshot.routines.find((r) => r.id === routineId);
  if (!routine) {
    // Activated in place of another, or discarded.
    return (
      <p className="rounded-xl border border-line bg-black/20 px-3 py-2 text-[13px] text-dim">
        This draft was activated or discarded. The project's Routines tab has what's there now.
      </p>
    );
  }
  return <RoutineSummary routine={routine} projectId={projectId} />;
}
