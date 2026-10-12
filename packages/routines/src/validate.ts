import { ROUTINE_EVENT_INFO, type RoutineDefinition } from '@clanks/core';
import { cronProblem } from './cron';
import { outputFieldProblem, refProblem, templateRefs } from './template';
import { dependencyCycle, resolveAt, timingWarning } from './timing';
import { onceInstant } from './words';
import { isTimeZone } from './zone';

/** What a routine is checked against: the project it's in, as it is now. */
export interface RoutineEnvironment {
  /** The project's crew, with what each clank makes. */
  crew: { id: string; name: string; outputs: string[] }[];
  /** The integrations there are, with the account the project uses for each. */
  integrations: {
    id: string;
    name: string;
    /** The label of the account turned on in the project. Null when there's none. */
    connection: string | null;
    operations: {
      id: string;
      /** The arguments it takes, and which it can't go without. */
      parameters: string[];
      required: string[];
      /** The argument that has the service send it at a time, when it can be handed over. */
      schedule: string | null;
    }[];
  }[];
  /** The zone the routine's times are in: its own, or the user's. */
  zone: string;
  now: number | Date;
  /** When its next run starts, to work its steps' times out from. Without one, now. */
  start?: number | Date | null;
  /** How long each ticket step took in earlier runs, in minutes. */
  minutes?: (stepId: string) => number | null;
}

/**
 * What stops a routine being activated, and what's worth a look besides. A routine with problems
 * can be saved as a draft, never turned on.
 */
export function checkDefinition(
  definition: RoutineDefinition,
  env: RoutineEnvironment,
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const { trigger, steps } = definition;

  if (!isTimeZone(env.zone)) problems.push(`"${env.zone}" isn't a time zone`);
  const zone = isTimeZone(env.zone) ? env.zone : 'UTC';

  if (trigger.kind === 'cron') {
    const problem = cronProblem(trigger.cron);
    if (problem) problems.push(`The schedule can't be read. ${problem}`);
  } else if (trigger.kind === 'once') {
    const at = onceInstant(trigger.at, zone);
    if (!at) problems.push(`"${trigger.at}" isn't a date and time`);
    else if (+at <= +env.now) warnings.push('Its time has passed, so it runs only from Run now.');
  } else if (trigger.kind === 'event') {
    const known = ROUTINE_EVENT_INFO[trigger.event].filters.map((f) => f.id);
    for (const name of Object.keys(trigger.filters)) {
      if (!known.includes(name)) {
        problems.push(
          `${trigger.event} has no "${name}" filter${known.length > 0 ? `. It takes: ${known.join(', ')}` : ''}`,
        );
      }
    }
  }

  const ids = steps.map((s) => s.id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    problems.push(`Two steps are called "${id}"`);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id) problems.push(`"${step.id}" depends on itself`);
      else if (!ids.includes(dep))
        problems.push(`"${step.id}" depends on "${dep}", which isn't a step`);
    }
  }
  const cycle = dependencyCycle(steps);
  if (cycle && problems.every((p) => !p.includes('depends on itself'))) {
    problems.push(`"${cycle[0]}" ends up waiting on itself. Check the steps' depends_on.`);
  }

  const inputs = Object.keys(definition.inputs);
  const event = trigger.kind === 'event';
  // The start of some run, to work the times out for: the check is the same for every run.
  const start = env.start ?? env.now;

  for (const step of steps) {
    if (step.ticket) {
      const { ticket } = step;
      const clank = env.crew.find((c) => c.id === ticket.clank);
      if (!clank) {
        problems.push(
          `"${step.id}" is for ${ticket.clank}, who isn't in this project's crew${env.crew.length > 0 ? `: ${env.crew.map((c) => c.id).join(', ')}` : ''}`,
        );
      } else if (!clank.outputs.includes(ticket.type)) {
        const makers = env.crew.filter((c) => c.outputs.includes(ticket.type)).map((c) => c.name);
        problems.push(
          `"${step.id}": ${clank.name} doesn't make ${ticket.type} tickets${makers.length > 0 ? `. ${makers.join(', ')} ${makers.length === 1 ? 'does' : 'do'}` : ''}`,
        );
      }
      for (const ref of templateRefs([ticket.title, ticket.description, ticket.criteria])) {
        const problem = refProblem(ref, { inputs, dependsOn: step.dependsOn, steps: false, event });
        if (problem) problems.push(`"${step.id}": ${problem}`);
      }
      if (ticket.due && !resolveAt(ticket.due, start, zone)) {
        problems.push(`"${step.id}": "${ticket.due}" isn't a time`);
      }
    }
    if (step.action) {
      const { action } = step;
      const integration = env.integrations.find((i) => i.id === action.integration);
      if (!integration) {
        problems.push(`"${step.id}" uses ${action.integration}, which isn't installed`);
      } else {
        const operation = integration.operations.find((o) => o.id === action.operation);
        if (!operation) {
          problems.push(
            `"${step.id}": ${integration.name} has no "${action.operation}". It has: ${integration.operations.map((o) => o.id).join(', ')}`,
          );
        } else {
          const given = Object.keys(action.payload);
          const unknown = given.filter((name) => !operation.parameters.includes(name));
          if (unknown.length > 0) {
            problems.push(
              `"${step.id}": ${action.operation} takes no ${unknown.map((u) => `"${u}"`).join(', ')}. It takes: ${operation.parameters.join(', ') || 'nothing'}`,
            );
          }
          // Handed over, its time is the app's to fill in.
          const filled = action.deliver === 'hand_off' ? operation.schedule : null;
          const missing = operation.required.filter(
            (name) => !given.includes(name) && name !== filled,
          );
          if (missing.length > 0) {
            problems.push(
              `"${step.id}": ${action.operation} needs ${missing.map((m) => `"${m}"`).join(', ')} in its payload`,
            );
          }
          if (action.deliver === 'hand_off' && !operation.schedule) {
            problems.push(
              `"${step.id}": ${integration.name} can't hold ${action.operation} to send later, so it can't be handed off. Leave deliver as at_time.`,
            );
          }
        }
        if (!integration.connection) {
          // What is connected, so whoever wrote it can pick the one that's there.
          const connected = env.integrations
            .filter((i) => i.connection)
            .map((i) => `\`${i.id}\` (${i.name}, account "${i.connection}")`);
          problems.push(
            `"${step.id}": no account is turned on in this project for \`${integration.id}\` (${integration.name}). ${connected.length > 0 ? `The services with an account here: ${connected.join(', ')}.` : 'No service has an account here yet.'} To use ${integration.name}, connect an account in Settings, then turn it on in the project's settings.`,
          );
        } else if (
          action.connection &&
          action.connection.toLowerCase() !== integration.connection.toLowerCase()
        ) {
          problems.push(
            `"${step.id}" names the account "${action.connection}", but this project's ${integration.name} account is "${integration.connection}"`,
          );
        }
      }
      if (!resolveAt(action.at, start, zone)) {
        problems.push(`"${step.id}": "${action.at}" isn't a time`);
      }
      for (const ref of templateRefs(action.payload)) {
        const problem =
          refProblem(ref, { inputs, dependsOn: step.dependsOn, steps: true, event }) ??
          // What the step it reads from hands in, by what that step makes.
          outputFieldProblem(ref, steps.find((s) => s.id === ref.path[0])?.ticket?.type ?? '');
        if (problem) problems.push(`"${step.id}": ${problem}`);
      }
    }
  }

  if (problems.length === 0) {
    const warning = timingWarning(definition, start, zone, env.minutes);
    if (warning) warnings.push(warning);
  }
  return { problems: [...new Set(problems)], warnings };
}
