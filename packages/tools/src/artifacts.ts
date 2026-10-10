import { z } from 'zod';
import { LOW_RISK } from './risk';
import {
  type ArtifactAccess,
  type CrewAccess,
  type ToolContext,
  ToolFailure,
  defineTool,
  short,
} from './spec';

function artifactsOf(ctx: ToolContext): ArtifactAccess {
  if (!ctx.artifacts) throw new ToolFailure("Notes can't be saved in this chat.");
  return ctx.artifacts;
}

function crewOf(ctx: ToolContext): CrewAccess {
  if (!ctx.crew) throw new ToolFailure("There's no crew to ask in this chat.");
  return ctx.crew;
}

/** Artifacts live in the app's own folder, not the project's, so "always allow" covers every call. */
const anyCall = (subject: string) => ({ kind: 'tool' as const, subject, pattern: '*' });

/** The first letter up, for a clank's id in a label: `scout` reads as Scout. */
const named = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

const nameArg = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe('A file name with no folders, such as competitors.md or sources.csv');

export const artifactSave = defineTool({
  name: 'artifact_save',
  description:
    "Saves a note or a file with the ticket, outside the project's files: working notes, a list of sources, a table, a draft. Saving under a name you used before keeps the earlier version too. It is not how you hand work in: that is your finishing call.",
  schema: z.object({
    name: nameArg,
    content: z.string().min(1).max(400_000).describe('The whole file, as text'),
  }),
  needs: [],
  mutates: false,
  label: (args) => `Saving \`${short(args.name, 50)}\``,
  approval: (args) => anyCall(`Save ${args.name}`),
  // It writes only to the app's own folder, under a name that can't leave it.
  risk: () => LOW_RISK,
  // eslint-disable-next-line @typescript-eslint/require-await -- a missing folder rejects, like the rest
  run: async (args, ctx) => ({ content: artifactsOf(ctx).save(args) }),
});

export const artifactRead = defineTool({
  name: 'artifact_read',
  description:
    "Reads what's saved with the ticket: without a name, the list of files and their versions; with one, that file's text. Use it to pick your notes back up.",
  schema: z.object({
    name: nameArg.optional(),
    version: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('An earlier version. Without one, the newest'),
    from_line: z.number().int().min(1).optional().describe('Where to start in a long file'),
  }),
  needs: [],
  mutates: false,
  label: (args) => (args.name ? `Reading \`${short(args.name, 50)}\`` : 'Listing saved files'),
  approval: (args) => anyCall(args.name ? `Read ${args.name}` : 'List saved files'),
  risk: () => LOW_RISK,
  // eslint-disable-next-line @typescript-eslint/require-await -- as above
  run: async (args, ctx) => ({
    content: artifactsOf(ctx).read({
      name: args.name,
      version: args.version,
      fromLine: args.from_line ?? 1,
    }),
  }),
});

export const askClank = defineTool({
  name: 'ask_clank',
  description:
    "Asks another clank in the crew one quick question in its specialty and waits for the answer, which comes back as this call's result: a fact from Scout, a wording check from Quill, what the board says from Atlas. Say everything it needs in the question; it doesn't see your ticket. Don't hand your work off this way.",
  schema: z.object({
    clank: z.string().trim().min(1).max(40).describe("The clank's id from the crew list"),
    question: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe('One question, with the facts needed to answer it'),
  }),
  needs: ['crew'],
  mutates: false,
  label: (args) => `Asking ${named(args.clank)}: ${short(args.question, 50)}`,
  approval: (args) => anyCall(`Ask ${args.clank}: ${args.question}`),
  // The other clank works under its own policy; asking it changes nothing by itself.
  risk: () => LOW_RISK,
  run: async (args, ctx) => ({ content: await crewOf(ctx).ask(args) }),
});

export const ARTIFACT_TOOLS = [artifactSave, artifactRead];

/** Every clank can ask another a quick question. */
export const ASK_TOOLS = [askClank];
