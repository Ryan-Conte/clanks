import { TICKET_COLUMNS, outputTypeSchema } from '@clanks/core';
import { z } from 'zod';
import { type BoardAccess, type ToolContext, ToolFailure, defineTool, short } from './spec';

function boardOf(ctx: ToolContext): BoardAccess {
  if (!ctx.board) throw new ToolFailure("This chat isn't in a project, so there's no board.");
  return ctx.board;
}

/** Board tools change the board, not files, so "always allow" covers every call. */
const anyCall = (subject: string) => ({ kind: 'tool' as const, subject, pattern: '*' });

/** The first letter up, for a clank's id in a label: `scribe` reads as Scribe. */
const named = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

const keyArg = z.string().trim().min(1).max(20).describe('The ticket key, such as SURF-12');
const skipArg = z
  .array(
    z.object({
      clank: z.string().trim().min(1).max(40).describe("The checker's id, such as sentinel"),
      reason: z.string().trim().min(1).max(300).describe('Why this ticket needs no such check'),
    }),
  )
  .max(10)
  .describe(
    "Optional checks this ticket doesn't need, each with a reason shown on its card. Required checks and sign-off can't be skipped.",
  );
const listArg = (what: string) =>
  z.array(z.string().trim().min(1).max(2000)).max(50).describe(what);

export const boardList = defineTool({
  name: 'board_list',
  description:
    "Lists the project's tickets: key, type, title, column, who has it and what it waits on. Filter by column, by clank, or by words in the title. Answer status questions from this, not from memory.",
  schema: z.object({
    column: z.enum(TICKET_COLUMNS).optional().describe('backlog, build, review, ready or done'),
    assignee: z.string().trim().max(40).optional().describe("A clank's id, or open"),
    query: z.string().trim().max(200).optional().describe('Words in the title'),
  }),
  needs: ['project'],
  mutates: false,
  label: () => 'Reading the board',
  approval: () => anyCall('Read the board'),
  run: (args, ctx) => Promise.resolve({ content: boardOf(ctx).list(args) }),
});

export const boardGetTicket = defineTool({
  name: 'board_get_ticket',
  description:
    'Reads one ticket in full: description, stories, acceptance criteria, route, dependencies, bounces and what was handed in.',
  schema: z.object({ key: keyArg }),
  needs: ['project'],
  mutates: false,
  label: (args) => `Reading ${args.key.toUpperCase()}`,
  approval: (args) => anyCall(`Read ${args.key}`),
  run: (args, ctx) => Promise.resolve({ content: boardOf(ctx).get(args.key) }),
});

export const boardCreateTicket = defineTool({
  name: 'board_create_ticket',
  description:
    "Creates a ticket on the project's board, in the backlog. Give it one output type and a maker that makes that type, or leave it open. Its checks are added for its type. The maker sees only the ticket, the spec and the outputs of tickets it depends on, so put everything it needs in the description.",
  schema: z.object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('An imperative phrase, such as "Add Stripe checkout"'),
    type: outputTypeSchema.describe('What it makes'),
    description: z
      .string()
      .max(20_000)
      .default('')
      .describe('Why, and the facts, files, links and constraints the maker needs'),
    stories: z
      .array(z.string().trim().min(1).max(200))
      .max(30)
      .default([])
      .describe('Spec story ids it covers, such as ["US-4"]'),
    criteria: listArg(
      'Acceptance criteria, one per item, such as "AC-4.1: Given …". Leave empty to copy the criteria of its stories.',
    ).default([]),
    assignee: z
      .string()
      .trim()
      .max(40)
      .nullable()
      .default(null)
      .describe("A clank's id from the crew list, or null to leave it open"),
    depends_on: z
      .array(z.string().trim().min(1).max(20))
      .max(30)
      .default([])
      .describe('Keys of tickets that must be done first, such as ["SURF-2"]'),
    skip_checks: skipArg.default([]),
  }),
  needs: ['project'],
  mutates: false,
  label: (args) => `Creating a ticket: ${short(args.title, 50)}`,
  approval: (args) => anyCall(`Create a ticket: ${args.title}`),
  run: (args, ctx) =>
    Promise.resolve({
      content: boardOf(ctx).create({
        title: args.title,
        type: args.type,
        description: args.description,
        stories: args.stories,
        criteria: args.criteria,
        assignee: args.assignee,
        dependsOn: args.depends_on,
        skipChecks: args.skip_checks,
      }),
    }),
});

export const boardUpdateTicket = defineTool({
  name: 'board_update_ticket',
  description:
    "Changes a ticket's title, description, stories or acceptance criteria, or skips optional checks it doesn't need. Lists replace what's there. A done ticket can't change.",
  schema: z.object({
    key: keyArg,
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(20_000).optional(),
    stories: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
    criteria: listArg('The full list of acceptance criteria').optional(),
    skip_checks: skipArg.optional(),
  }),
  needs: ['project'],
  mutates: false,
  label: (args) => `Updating ${args.key.toUpperCase()}`,
  approval: (args) => anyCall(`Update ${args.key}`),
  run: (args, ctx) => {
    const { skip_checks: skipChecks, ...rest } = args;
    return Promise.resolve({
      content: boardOf(ctx).update({ ...rest, ...(skipChecks ? { skipChecks } : {}) }),
    });
  },
});

export const boardLinkDependency = defineTool({
  name: 'board_link_dependency',
  description:
    'Makes a ticket wait until another is done, or with remove, stops it waiting. Link only real dependencies, so work can run in parallel.',
  schema: z.object({
    key: keyArg.describe('The ticket that waits'),
    depends_on: keyArg.describe('The ticket it waits on'),
    remove: z.boolean().default(false),
  }),
  needs: ['project'],
  mutates: false,
  label: (args) =>
    args.remove
      ? `Unlinking ${args.key.toUpperCase()} from ${args.depends_on.toUpperCase()}`
      : `Making ${args.key.toUpperCase()} wait on ${args.depends_on.toUpperCase()}`,
  approval: (args) => anyCall(`Link ${args.key} to ${args.depends_on}`),
  run: (args, ctx) =>
    Promise.resolve({
      content: boardOf(ctx).link({
        key: args.key,
        dependsOn: args.depends_on,
        remove: args.remove,
      }),
    }),
});

export const boardAssign = defineTool({
  name: 'board_assign',
  description:
    "Gives a ticket to a clank that makes its type, or with null leaves it open for the first free one. Only before it's started.",
  schema: z.object({
    key: keyArg,
    clank: z.string().trim().max(40).nullable().describe("A clank's id, or null for open"),
  }),
  needs: ['project'],
  mutates: false,
  label: (args) =>
    args.clank
      ? `Assigning ${args.key.toUpperCase()} to ${named(args.clank)}`
      : `Leaving ${args.key.toUpperCase()} open`,
  approval: (args) => anyCall(`Assign ${args.key}`),
  run: (args, ctx) => Promise.resolve({ content: boardOf(ctx).assign(args) }),
});

export const specRead = defineTool({
  name: 'spec_read',
  description:
    "Reads the project's spec: its user stories, acceptance criteria and edge cases. Without a version it reads the approved spec, or the draft being written when that's your work.",
  schema: z.object({
    version: z
      .union([z.number().int().min(1), z.string().trim().max(10)])
      .optional()
      .describe('A version number, or "draft"'),
  }),
  needs: ['project'],
  mutates: false,
  label: (args) =>
    args.version === undefined
      ? 'Reading the spec'
      : `Reading the spec (${typeof args.version === 'number' ? `v${args.version}` : args.version})`,
  approval: () => anyCall('Read the spec'),
  run: (args, ctx) => {
    const raw = args.version;
    let version: number | 'draft' | null = null;
    if (typeof raw === 'number') version = raw;
    else if (raw !== undefined && raw !== '') {
      const number = /^v?(\d+)$/i.exec(raw);
      if (number) version = Number(number[1]);
      else if (/^draft$/i.test(raw)) version = 'draft';
      else throw new ToolFailure(`Give a version number or "draft", not "${raw}".`);
    }
    return Promise.resolve({ content: boardOf(ctx).readSpec(version) });
  },
});

export const specWrite = defineTool({
  name: 'spec_write',
  description:
    'Saves the whole spec as the draft of its next version, replacing the draft. Write all of it each time, in Markdown, with each story under a heading such as "### US-4 Checkout" and criteria as "- AC-4.1: …". It says what it found and any problems.',
  schema: z.object({ content: z.string().min(1).max(400_000).describe('The whole spec') }),
  needs: ['project', 'ticket'],
  mutates: false,
  label: () => 'Writing the spec',
  approval: () => anyCall('Save a draft of the spec'),
  run: (args, ctx) => Promise.resolve({ content: boardOf(ctx).writeSpec(args.content) }),
});

export const postProgress = defineTool({
  name: 'post_progress',
  description:
    'Tells the user how the ticket is going, in one or two sentences, with your plan as steps if you have one. Its card shows the steps done.',
  schema: z.object({
    message: z.string().trim().min(1).max(1000),
    steps: z
      .array(
        z.object({ title: z.string().trim().min(1).max(200), done: z.boolean().default(false) }),
      )
      .max(30)
      .default([]),
  }),
  needs: ['ticket'],
  mutates: false,
  label: (args) => short(args.message, 70),
  approval: () => anyCall('Post progress'),
  run: (args, ctx) => Promise.resolve({ content: boardOf(ctx).progress(args) }),
});

const criteriaField = z
  .array(z.unknown())
  .optional()
  .describe('Each acceptance criterion with met or not met, and the evidence');

export const submitOutput = defineTool({
  name: 'submit_output',
  description:
    'Hands in your finished work on the ticket. It goes on to the next clank on its route. This ends your run, so call it last, once, with the fields your instructions list.',
  schema: z.looseObject({
    type: outputTypeSchema.describe("The ticket's output type"),
    title: z.string().optional(),
    summary: z.unknown().optional(),
    body: z.string().optional(),
    criteria: criteriaField,
    notes: z.unknown().optional(),
  }),
  needs: ['ticket', 'maker'],
  mutates: false,
  label: (args) => `Submitting the ${args.type}`,
  approval: (args) => anyCall(`Submit the ${args.type}`),
  run: async (args, ctx) => ({ content: await boardOf(ctx).submit(args), finish: true }),
});

export const reviewPass = defineTool({
  name: 'review_pass',
  description:
    'Passes the ticket you are checking, so it goes on along its route. This ends your run, so call it last, once.',
  schema: z.looseObject({
    summary: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe('What you checked and found, for the user'),
    criteria: criteriaField,
    notes: z.unknown().optional(),
  }),
  needs: ['ticket', 'checker'],
  mutates: false,
  label: () => 'Passing the ticket',
  approval: () => anyCall('Pass the ticket'),
  run: async (args, ctx) => ({ content: await boardOf(ctx).pass(args), finish: true }),
});

export const ticketBounce = defineTool({
  name: 'ticket_bounce',
  description:
    'Sends the ticket to the clank that can fix it, with the reason and a numbered list of specific issues: back along its route, which then runs again from there, or to another clank you may send work to, who answers and hands it back to you. This ends your run.',
  schema: z.object({
    to: z.string().trim().min(1).max(40).describe("The clank's id"),
    reason: z.string().trim().min(1).max(1000).describe('One line on why'),
    issues: z
      .array(z.string().trim().min(1).max(4000))
      .min(1)
      .max(30)
      .describe('Each specific thing to fix'),
  }),
  needs: ['ticket'],
  mutates: false,
  label: (args) => `Sending it back to ${named(args.to)}`,
  approval: (args) => anyCall(`Send it back to ${args.to}`),
  run: async (args, ctx) => ({ content: await boardOf(ctx).bounce(args), finish: true }),
});

export const fail = defineTool({
  name: 'fail',
  description:
    "Stops work on the ticket because you can't finish it, saying what you tried and what happened. It goes to the user. This ends your run.",
  schema: z.object({
    reason: z.string().trim().min(1).max(4000),
    tried: z.string().trim().max(4000).default(''),
  }),
  needs: ['ticket'],
  mutates: false,
  label: () => 'Stopping: it failed',
  approval: () => anyCall('Fail the ticket'),
  run: (args, ctx) => Promise.resolve({ content: boardOf(ctx).fail(args), finish: true }),
});

export const askUser = defineTool({
  name: 'ask_user',
  description:
    'Asks the user one question only they can answer, with the options you see and the one you recommend. Your run pauses until they answer, and their answer comes as their next message.',
  schema: z.object({
    question: z.string().trim().min(1).max(4000),
    options: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
    recommendation: z.string().trim().max(1000).default(''),
  }),
  needs: ['ticket'],
  mutates: false,
  label: () => 'Asking you a question',
  approval: () => anyCall('Ask a question'),
  run: (args, ctx) => Promise.resolve({ content: boardOf(ctx).ask(args), finish: true }),
});

export const BOARD_TOOLS = [
  boardList,
  boardGetTicket,
  boardCreateTicket,
  boardUpdateTicket,
  boardLinkDependency,
  boardAssign,
  specRead,
  specWrite,
];

/** Every clank has these on a ticket. They hand the ticket on, or say how it's going. */
export const CREW_TOOLS = [postProgress, submitOutput, reviewPass, ticketBounce, fail, askUser];
