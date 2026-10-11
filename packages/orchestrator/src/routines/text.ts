import type { RoutineInfo, RoutineRunInfo } from '@clanks/core';
import { routineToYaml, timeIn, whenText } from '@clanks/routines';

const STATUS_WORDS: Record<RoutineInfo['status'], string> = {
  draft: 'a draft, not turned on',
  active: 'on',
  paused: 'paused',
  done: 'done',
};

/** One routine as a line of the list a clank reads. */
export function routineLine(routine: RoutineInfo, now: Date): string {
  const next = routine.nextRuns[0];
  const steps = routine.definition.steps
    .map((s) => (s.ticket ? `${s.ticket.clank} makes ${s.id}` : `${s.id} goes out`))
    .join(', ');
  return [
    `- "${routine.definition.name}" (${STATUS_WORDS[routine.status]}): ${routine.triggerText || 'no schedule'}`,
    next && routine.status === 'active' ? `next ${whenText(next, routine.zone, now)}` : '',
    steps,
  ]
    .filter(Boolean)
    .join('; ');
}

/** A routine in full, with its latest runs, as a clank reads it. */
export function routineDetail(
  routine: RoutineInfo,
  runs: RoutineRunInfo[],
  now: Date,
  name: (clankId: string) => string,
): string {
  const lines = [
    `### ${routine.definition.name}`,
    '',
    `- Status: ${STATUS_WORDS[routine.status]}${routine.pausedReason ? ` (${routine.pausedReason})` : ''}`,
    `- Starts: ${routine.triggerText || 'no schedule'}`,
  ];
  if (routine.nextRuns.length > 0 && routine.status === 'active') {
    lines.push(`- Next: ${routine.nextRuns.map((r) => whenText(r, routine.zone, now)).join('; ')}`);
  }
  if (routine.createdBy !== 'user') lines.push(`- Drafted by ${name(routine.createdBy)}`);
  for (const timing of routine.timings) {
    if (!timing.at) continue;
    const step = routine.definition.steps.find((s) => s.id === timing.stepId);
    lines.push(
      step?.action
        ? `- ${timing.stepId} goes out at ${timeIn(timing.at, routine.zone)}`
        : `- ${timing.stepId} is due ${timeIn(timing.at, routine.zone)}${timing.why ? `, ${timing.why}` : ''}`,
    );
  }
  for (const problem of routine.problems) lines.push(`- Can't run: ${problem}`);
  lines.push('', '```yaml', routineToYaml(routine.definition).trim(), '```');
  if (runs.length > 0) {
    lines.push('', 'Latest runs:', '');
    for (const run of runs) {
      const sent = run.actions
        .filter((a) => a.status === 'done')
        .map((a) => a.result?.url ?? `${a.integrationName} ${a.operationId}`);
      lines.push(
        `- ${whenText(run.scheduledFor, routine.zone, now)}: ${run.status.replace('_', ' ')}${run.reason ? ` (${run.reason})` : ''}${run.tickets.length > 0 ? `, tickets ${run.tickets.map((t) => t.key).join(', ')}` : ''}${sent.length > 0 ? `, sent ${sent.join(', ')}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}
