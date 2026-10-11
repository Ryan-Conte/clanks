import { type RoutineDefinition, type RoutineStep, durationMs } from '@clanks/core';
import { instantOf, parseStamp, timeIn, wallAt } from './zone';

/**
 * The instant an `at` names for a run: a time on the run's date (`17:00`, the next one from its
 * start on), an offset from its start (`+4h`), or a date and time. Null when it isn't one.
 */
export function resolveAt(at: string, start: number | Date, zone: string): Date | null {
  const text = at.trim();
  const offset = /^\+(\d{1,4})\s?(m|h|d)$/.exec(text);
  if (offset) return new Date(+start + durationMs(`${offset[1]}${offset[2]}`));
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const day = wallAt(start, zone);
    const wall = { ...day, hour: Number(clock[1]), minute: Number(clock[2]) };
    let instant = instantOf(wall, zone);
    // A run that starts at 23:00 with an action at 01:00 means the 01:00 that follows.
    if (instant < +start) {
      const next = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
      instant = instantOf(
        {
          ...wall,
          year: next.getUTCFullYear(),
          month: next.getUTCMonth() + 1,
          day: next.getUTCDate(),
        },
        zone,
      );
    }
    return new Date(instant);
  }
  const stamp = parseStamp(text);
  return stamp ? new Date(instantOf(stamp, zone)) : null;
}

/** Every step a step depends on, directly or through others. */
export function dependenciesOf(steps: RoutineStep[], id: string): Set<string> {
  const found = new Set<string>();
  const visit = (stepId: string) => {
    for (const dep of steps.find((s) => s.id === stepId)?.dependsOn ?? []) {
      if (found.has(dep)) continue;
      found.add(dep);
      visit(dep);
    }
  };
  visit(id);
  return found;
}

/** A dependency that leads back to its own step, as the ids on the way round. Null when none does. */
export function dependencyCycle(steps: RoutineStep[]): string[] | null {
  for (const step of steps) {
    if (dependenciesOf(steps, step.id).has(step.id)) return [step.id];
  }
  return null;
}

export interface StepTime {
  stepId: string;
  /** When an action goes out, or a ticket is due. Null for a ticket nothing is waiting on. */
  at: Date | null;
  /** For a ticket: what it's due before. */
  why: string | null;
}

/**
 * When each step of a run happens. An action goes out at its `at`. A ticket is due the review
 * buffer before the earliest action that needs it, so there's room to look it over, unless it
 * names a due time of its own.
 */
export function stepTimes(
  definition: Pick<RoutineDefinition, 'steps' | 'timing'>,
  start: number | Date,
  zone: string,
): StepTime[] {
  const actions = new Map<string, Date>();
  for (const step of definition.steps) {
    if (!step.action) continue;
    const at = resolveAt(step.action.at, start, zone);
    if (at) actions.set(step.id, at);
  }
  const buffer = durationMs(definition.timing.reviewBuffer);
  return definition.steps.map((step): StepTime => {
    if (step.action) return { stepId: step.id, at: actions.get(step.id) ?? null, why: null };
    if (step.ticket?.due) {
      return { stepId: step.id, at: resolveAt(step.ticket.due, start, zone), why: null };
    }
    let first: { at: Date; step: RoutineStep } | null = null;
    for (const other of definition.steps) {
      const at = actions.get(other.id);
      if (!at || !dependenciesOf(definition.steps, other.id).has(step.id)) continue;
      if (!first || +at < +first.at) first = { at, step: other };
    }
    if (!first) return { stepId: step.id, at: null, why: null };
    return {
      stepId: step.id,
      at: new Date(+first.at - buffer),
      why: `so it can be reviewed before the ${timeIn(first.at, zone)} ${actionNoun(first.step)}`,
    };
  });
}

/** What an action is, in a word, for "the 17:00 post". */
export function actionNoun(step: RoutineStep): string {
  const operation = step.action?.operation ?? '';
  if (/post|tweet|publish/.test(operation)) return 'post';
  if (/send|email|message/.test(operation)) return 'send';
  return 'action';
}

/** How long a routine's makers usually need per ticket, when it has no runs to go by. */
export const DEFAULT_TICKET_MINUTES = 20;

/**
 * Whether the gap between a run's start and its first action looks too short for its tickets, as
 * a warning, or null when there's room. `minutes` is what each ticket step took before, if known.
 */
export function timingWarning(
  definition: Pick<RoutineDefinition, 'steps' | 'timing'>,
  start: number | Date,
  zone: string,
  minutes: (stepId: string) => number | null = () => null,
): string | null {
  const times = stepTimes(definition, start, zone);
  for (const step of definition.steps) {
    if (!step.ticket) continue;
    const due = times.find((t) => t.stepId === step.id)?.at;
    if (!due) continue;
    // What it waits on has to be made first.
    const chain = [...dependenciesOf(definition.steps, step.id), step.id].filter(
      (id) => definition.steps.find((s) => s.id === id)?.ticket,
    );
    const needed = chain.reduce((sum, id) => sum + (minutes(id) ?? DEFAULT_TICKET_MINUTES), 0);
    const room = (+due - +start) / 60_000;
    if (room < needed) {
      return room <= 0
        ? `"${step.id}" is due before the run starts. Start earlier, or move what it's for later.`
        : `"${step.id}" has ${Math.round(room)} minutes before it's due, and work like it takes about ${Math.round(needed)}. Start earlier, or move what it's for later.`;
    }
  }
  return null;
}
