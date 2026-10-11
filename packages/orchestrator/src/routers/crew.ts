import {
  type ModelChoice,
  clankIdSchema,
  clankProfilePatchSchema,
  customClankSchema,
  outputTypeSchema,
} from '@clanks/core';
import { BUILTIN_PROVIDER } from '@clanks/providers';
import { z } from 'zod';
import { ChatError } from '../chat/service';
import { draftClankPrompt } from '../crew/draft';
import { removeCustomClank } from '../crew/remove';
import { userProcedure } from '../procedures';
import { type OrchestratorContext, publicProcedure, router } from '../trpc';

/** A model a clank can be given: pulled, or at a provider that's set up. */
function checkModel(ctx: OrchestratorContext, choice: ModelChoice): void {
  if (choice.provider === BUILTIN_PROVIDER) {
    const model = ctx.models.library().find((m) => m.id === choice.model);
    if (!model || model.missing) throw new ChatError(`${choice.model} isn't pulled`);
  } else if (!ctx.providerSettings.isConfigured(choice.provider)) {
    throw new ChatError(`${ctx.providerSettings.name(choice.provider)} isn't set up yet`);
  }
}

export const crewRouter = router({
  list: publicProcedure.query(({ ctx }) => ctx.crew.summaries()),

  /** Custom clanks in the library whose docs can't be read, and why. */
  broken: publicProcedure.query(({ ctx }) => ctx.crew.brokenCustom()),

  /** What the form for a new custom clank starts from, and a worked example. */
  templates: publicProcedure.query(({ ctx }) => ctx.crew.templates()),

  /** About how many tokens a clank's prompt takes, with the rules the whole crew shares. */
  tokens: userProcedure.input(clankIdSchema).query(({ ctx, input }) => ({
    tokens: ctx.crew.promptTokens(input),
    budget: 2500,
  })),

  /** Adds a custom clank to the library: from the form's fields, or from a whole priming doc. */
  create: userProcedure
    .input(z.union([customClankSchema, z.object({ text: z.string().min(1).max(200_000) })]))
    .mutation(({ ctx, input }) => ctx.crew.createCustom(input)),

  /**
   * Takes a custom clank out of the library, with its chats. It must be out of every project's
   * crew first, so no ticket is left waiting on a clank that's gone.
   */
  remove: userProcedure.input(clankIdSchema).mutation(async ({ ctx, input }) => {
    await removeCustomClank(ctx, input);
    // One that came from a marketplace is no longer installed.
    ctx.marketplace.forget('clank', input);
  }),

  /**
   * Atlas drafts a custom clank's prompt from a line about what it's for. Nothing is saved: the
   * draft goes back to the form for the user to read and change.
   */
  draft: userProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(40),
        role: z.string().trim().min(1).max(40),
        description: z.string().trim().min(1).max(2000),
        kind: z.enum(['maker', 'checker']),
        types: z.array(z.union([outputTypeSchema, z.literal('all')])).max(10),
        tools: z.array(z.string().max(64)).max(80),
      }),
    )
    .mutation(({ ctx, input, signal }) =>
      draftClankPrompt(
        ctx.providers,
        ctx.chat.modelFor('atlas'),
        input,
        signal ?? new AbortController().signal,
      ),
    ),

  /** A clank's priming doc as it's stored, and the one that ships with the app. */
  doc: userProcedure.input(clankIdSchema).query(({ ctx, input }) => ctx.crew.docText(input)),

  saveDoc: userProcedure
    .input(z.object({ id: clankIdSchema, text: z.string().min(1).max(200_000) }))
    .mutation(({ ctx, input }) => ctx.crew.saveDoc(input.id, input.text)),

  resetDoc: userProcedure
    .input(clankIdSchema)
    .mutation(({ ctx, input }) => ctx.crew.resetDoc(input)),

  /** Changes a clank's name, colour or model. Null goes back to what its doc says. */
  update: userProcedure
    .input(z.object({ id: clankIdSchema, patch: clankProfilePatchSchema }))
    .mutation(({ ctx, input }) => {
      if (input.patch.model) checkModel(ctx, input.patch.model);
      return ctx.crew.updateProfile(input.id, input.patch);
    }),
});
