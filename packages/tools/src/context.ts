import { z } from 'zod';
import { type ContextAccess, type ToolContext, ToolFailure, defineTool, short } from './spec';

function contextOf(ctx: ToolContext): ContextAccess {
  if (!ctx.context) {
    throw new ToolFailure("This chat isn't in a project, so there's no project context or memory.");
  }
  return ctx.context;
}

/** Notes and memory change no files, so "always allow" covers every call. */
const anyCall = (subject: string) => ({ kind: 'tool' as const, subject, pattern: '*' });

const queryArg = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe('What you want to know, in a few words, such as "cart state library"');

export const contextSearch = defineTool({
  name: 'context_search',
  description:
    "Searches the project's context, which the whole crew shares: notes on facts, decisions, conventions, names and links. Search before deciding something that may have come up already.",
  schema: z.object({ query: queryArg }),
  needs: ['project'],
  mutates: false,
  label: (args) => `Searching the project notes for "${short(args.query, 40)}"`,
  approval: (args) => anyCall(`Search the project notes: ${args.query}`),
  run: (args, ctx) => Promise.resolve({ content: contextOf(ctx).search(args.query) }),
});

export const contextWrite = defineTool({
  name: 'context_write',
  description:
    "Adds a note to the project's context, which every clank on the project reads: a fact, a decision, a convention, a name or a link others will need. Give the reason in `why`. To replace a note, name it in `supersedes`; to take one back, name it in `drop`. Never put secrets in a note.",
  schema: z.object({
    kind: z
      .enum(['fact', 'decision', 'convention', 'glossary', 'link'])
      .default('fact')
      .describe('fact, decision, convention, glossary or link'),
    title: z
      .string()
      .trim()
      .max(200)
      .default('')
      .describe('The note in one line, such as "Cart state lives in Zustand"'),
    body: z.string().trim().max(4000).default('').describe('More detail, if it needs it'),
    why: z.string().trim().max(2000).default('').describe("Why it's true, or why it was decided"),
    supersedes: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe('The reference, such as 3f2a9c, or title of a note this replaces'),
    drop: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe('The reference or title of a note to take back, instead of adding one'),
  }),
  needs: ['project'],
  mutates: false,
  label: (args) =>
    args.drop ? `Dropping a project note` : `Noting for the crew: ${short(args.title, 50)}`,
  approval: (args) =>
    anyCall(args.drop ? `Drop a note: ${args.drop}` : `Add a note: ${args.title}`),
  run: (args, ctx) => {
    if (!args.drop && !args.title) {
      throw new ToolFailure('Give the note a title, or name a note to drop.');
    }
    return Promise.resolve({
      content: contextOf(ctx).write({
        kind: args.kind,
        title: args.title,
        body: args.body,
        why: args.why,
        supersedes: args.supersedes ?? null,
        drop: args.drop ?? null,
      }),
    });
  },
});

export const memorySearch = defineTool({
  name: 'memory_search',
  description:
    'Searches your own memory of this project: your past runs, chats and the decisions you recorded, with their reasons. Use it when asked why you did something.',
  schema: z.object({
    query: queryArg,
    clank: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe(
        'Atlas only, when signing off a ticket: the id of the clank that made it, to search its memory instead',
      ),
  }),
  needs: ['project'],
  mutates: false,
  label: (args) =>
    `Searching ${args.clank ? `${args.clank}'s` : 'its'} memory for "${short(args.query, 40)}"`,
  approval: (args) => anyCall(`Search memory: ${args.query}`),
  run: (args, ctx) =>
    Promise.resolve({ content: contextOf(ctx).searchMemory(args.query, args.clank ?? null) }),
});

export const memoryWrite = defineTool({
  name: 'memory_write',
  description:
    'Records a decision you made and why, or a note for yourself, in your own memory of this project, in two or three sentences. Only you read it. Never put secrets in it.',
  schema: z.object({
    body: z.string().trim().min(1).max(2000).describe('What you decided and why'),
    kind: z.enum(['decision', 'note']).default('decision'),
  }),
  needs: ['project'],
  mutates: false,
  label: (args) => `Remembering: ${short(args.body, 50)}`,
  approval: () => anyCall('Write to its memory'),
  run: (args, ctx) => Promise.resolve({ content: contextOf(ctx).remember(args) }),
});

/** Every clank has these in a project. */
export const CONTEXT_TOOLS = [contextSearch, contextWrite, memorySearch, memoryWrite];
