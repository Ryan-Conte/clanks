import { CLOUD_PROVIDERS, providerIdSchema, serverInputSchema } from '@clanks/core';
import { z } from 'zod';
import { userProcedure } from '../procedures';
import { publicProcedure, router } from '../trpc';

const cloudIdSchema = z.enum(CLOUD_PROVIDERS);

// Like secrets, keys go in and never come back out: the window only learns whether there is one.
export const providersRouter = router({
  list: publicProcedure.query(({ ctx }) => ctx.providerSettings.list()),

  /** The models a provider offers, fetched with its key. Fails with the provider's reason. */
  models: userProcedure
    .input(providerIdSchema)
    .query(({ ctx, input, signal }) => ctx.providerSettings.models(input, signal)),

  setKey: userProcedure
    .input(z.object({ id: cloudIdSchema, key: z.string().trim().min(1).max(4096) }))
    .mutation(({ ctx, input }) => ctx.providerSettings.setKey(input.id, input.key)),

  removeKey: userProcedure
    .input(cloudIdSchema)
    .mutation(({ ctx, input }) => ctx.providerSettings.removeKey(input)),

  /** Adds a model server, once it answers like one. */
  addServer: userProcedure
    .input(serverInputSchema)
    .mutation(({ ctx, input, signal }) => ctx.providerSettings.addServer(input, signal)),

  /** Removes a model server. Clanks that ran on it go back to the crew's model. */
  removeServer: userProcedure.input(providerIdSchema).mutation(({ ctx, input }) => {
    ctx.providerSettings.removeServer(input);
    ctx.crew.clearModel(input);
  }),
});
