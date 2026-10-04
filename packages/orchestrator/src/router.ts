import { secretRefSchema, settingsPatchSchema } from '@clanks/core';
import { z } from 'zod';
import { createCallerFactory, publicProcedure, router } from './trpc';

export const appRouter = router({
  app: router({
    info: publicProcedure.query(({ ctx }) => ({
      ...ctx.appInfo,
      dataDir: ctx.paths.root,
      store: ctx.store.status(),
    })),
  }),

  settings: router({
    get: publicProcedure.query(({ ctx }) => ctx.settings.get()),
    update: publicProcedure
      .input(settingsPatchSchema)
      .mutation(({ ctx, input }) => ctx.settings.update(input)),
  }),

  // The window can save, check and delete a secret, but never read one back:
  // keys stay in the orchestrator, which is the only thing that calls providers.
  secrets: router({
    status: publicProcedure.query(({ ctx }) => ctx.secrets.status()),
    has: publicProcedure.input(secretRefSchema).query(({ ctx, input }) => ctx.secrets.has(input)),
    set: publicProcedure
      .input(z.object({ ref: secretRefSchema, value: z.string().min(1).max(65_536) }))
      .mutation(({ ctx, input }) => {
        ctx.secrets.set(input.ref, input.value);
      }),
    delete: publicProcedure
      .input(secretRefSchema)
      .mutation(({ ctx, input }) => ctx.secrets.delete(input)),
  }),
});

export type AppRouter = typeof appRouter;

export const createAppCaller = createCallerFactory(appRouter);
