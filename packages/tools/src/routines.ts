import { ROUTINE_EVENTS } from '@clanks/core';
import { z } from 'zod';
import { LOW_RISK } from './risk';
import { type RoutineAccess, type ToolContext, ToolFailure, defineTool, short } from './spec';

function routinesOf(ctx: ToolContext): RoutineAccess {
  if (!ctx.routines) {
    throw new ToolFailure("This chat isn't in a project, so there are no routines.");
  }
  return ctx.routines;
}

/** Routine tools read, or draft. Nothing they do schedules anything, so every call is alike. */
const anyCall = (subject: string) => ({ kind: 'tool' as const, subject, pattern: '*' });

export const routineList = defineTool({
  name: 'routine_list',
  description:
    "Lists the project's routines: what starts each, when it next runs, and its steps. Check it before proposing one, so you change the routine that's there rather than adding a second.",
  schema: z.object({}),
  needs: ['project'],
  mutates: false,
  label: () => 'Reading the routines',
  approval: () => anyCall('Read the routines'),
  risk: () => LOW_RISK,
  run: (_args, ctx) => Promise.resolve({ content: routinesOf(ctx).list() }),
});

export const routineGet = defineTool({
  name: 'routine_get',
  description:
    'Reads one routine in full: its trigger, its steps as YAML, when each is due or goes out, and how its latest runs went.',
  schema: z.object({
    routine: z.string().trim().min(1).max(100).describe("The routine's name"),
  }),
  needs: ['project'],
  mutates: false,
  label: (args) => `Reading the routine "${short(args.routine, 40)}"`,
  approval: (args) => anyCall(`Read the routine ${args.routine}`),
  risk: () => LOW_RISK,
  run: (args, ctx) => Promise.resolve({ content: routinesOf(ctx).get(args.routine) }),
});

const stepsArg = z
  .unknown()
  .describe(
    [
      'The steps, as a list. Each has an `id`, `depends_on` (ids of steps whose work it needs), and either a `ticket` or an `action`.',
      'A ticket step makes a ticket for a clank: `{ "id": "banner", "ticket": { "clank": "prism", "type": "design", "title": "…", "description": "…", "criteria": ["…"] } }`. Its text can use {{inputs.name}} and {{run.date}}.',
      'An action step calls a connected service at a time: `{ "id": "publish", "depends_on": ["copy"], "action": { "integration": "…", "operation": "…", "at": "17:00", "payload": { "text": "{{steps.copy.output.posts[0].text}}" } } }`. `at` is a time on the run\'s day, or an offset from its start such as "+4h". Use an integration that has an account in this project, by its id. Its payload can use what the steps it depends on handed in: a campaign step\'s post as {{steps.<id>.output.text}}, and a design step\'s picture as {{steps.<id>.output.image}}.',
    ].join(' '),
  );

export const routinePropose = defineTool({
  name: 'routine_propose',
  description:
    "Drafts a routine: work for the crew that starts at a time, on repeat or when something happens, and actions that go out at a set time once the user has approved exactly what they send. The draft shows in the chat as a card the user can edit. It never turns anything on: only the user activates a routine. To change a routine that exists, give its name in `routine`. If it's refused, fix what it says and call it again.",
  schema: z.looseObject({
    name: z.string().trim().min(1).max(80).describe('What to call it, such as "Weekend promo"'),
    description: z.string().trim().max(1000).optional().describe('What it is for, in a line'),
    schedule: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        'When a run starts, in plain words or cron: "every Friday at 1pm", "first Monday of the month", "tomorrow at 9", "0 13 * * 5". Start early enough for the work to be made and reviewed before anything goes out. Leave out for a routine an event starts.',
      ),
    event: z
      .enum(ROUTINE_EVENTS)
      .optional()
      .describe('Instead of a schedule: what starts it. `git.tag` takes a `match` such as "v*".'),
    match: z.string().trim().max(200).optional().describe('For git.tag: the tags that count'),
    time_zone: z
      .string()
      .trim()
      .max(64)
      .optional()
      .describe("An IANA zone such as Australia/Sydney. Leave out to use the user's."),
    inputs: z
      .unknown()
      .optional()
      .describe(
        'Values the steps read as {{inputs.name}}, each with its default: { "offer": "…" }',
      ),
    steps: stepsArg,
    routine: z
      .string()
      .trim()
      .max(100)
      .optional()
      .describe('The name of the routine this changes, instead of adding a new one'),
  }),
  needs: ['project'],
  mutates: false,
  label: (args) => `Drafting the routine "${short(args.name, 40)}"`,
  approval: (args) => anyCall(`Draft the routine ${args.name}`),
  // It drafts and nothing more: what it writes does nothing until the user activates it.
  risk: () => LOW_RISK,
  run: (args, ctx) => {
    const { schedule, event, match, ...rest } = args;
    const draft: Record<string, unknown> = { ...rest };
    if (rest.trigger === undefined) {
      if (event) draft.trigger = { kind: 'event', event, ...(match ? { match } : {}) };
      else if (schedule) draft.schedule = schedule;
      else draft.trigger = { kind: 'manual' };
    }
    return Promise.resolve({ content: routinesOf(ctx).propose(draft) });
  },
});

export const ROUTINE_TOOLS = [routineList, routineGet, routinePropose];
