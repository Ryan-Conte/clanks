import { type ModelChoice, clankIdSchema, clankProfilePatchSchema } from '@clanks/core';
import { BUILTIN_PROVIDER } from '@clanks/providers';
import { z } from 'zod';
import { ChatError } from '../chat/service';
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
