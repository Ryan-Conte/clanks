import {
  type ChatEvent,
  type SettingsPatch,
  modelIdSchema,
  modelRefSchema,
  runtimeBackendSchema,
  secretRefSchema,
  settingsPatchSchema,
} from '@clanks/core';
import { ModelsError, parseModelRef } from '@clanks/models';
import { BUILTIN_PROVIDER, ProviderError } from '@clanks/providers';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { userProcedure as modelProcedure } from './procedures';
import { artifactsRouter, emailRouter } from './routers/artifacts';
import { browserRouter } from './routers/browser';
import { chatRouter } from './routers/chat';
import { contextRouter, homeRouter } from './routers/context';
import { crewRouter } from './routers/crew';
import { designRouter } from './routers/design';
import { githubRouter } from './routers/github';
import { gitlabRouter } from './routers/gitlab';
import { boardRouter, projectsRouter } from './routers/projects';
import { providersRouter } from './routers/providers';
import { mcpRouter, toolsRouter } from './routers/tools';
import { workspaceRouter } from './routers/workspace';
import { type OrchestratorContext, createCallerFactory, publicProcedure, router } from './trpc';

/** Everything the Models screen shows that changes as it happens. */
function modelsSnapshot(ctx: OrchestratorContext) {
  const { models } = ctx;
  return {
    hardware: models.hardware(),
    runtime: models.runtime(),
    pulls: models.pulls.list(),
    imports: models.imports(),
    library: models.library(),
    catalog: models.catalog(),
    recommended: models.recommended(),
    crewModel: ctx.settings.get().crewModel,
    move: models.moveStatus(),
  };
}

export type ModelsSnapshot = ReturnType<typeof modelsSnapshot>;

const TRY_MAX_TOKENS = 4096;

/** At most this often, however fast downloads progress. */
const SNAPSHOT_INTERVAL_MS = 250;

const RUNTIME_SETTINGS = ['runtimeBackend', 'gpuBudgetMiB', 'systemBudgetMiB'] as const;
const LOAD_SETTINGS = ['contextPerSlot', 'parallelSlots'] as const;

/** Applies settings the model manager depends on. Loaded models pick up new values on reload. */
function applySettings(ctx: OrchestratorContext, patch: SettingsPatch): void {
  if (RUNTIME_SETTINGS.some((key) => key in patch)) {
    void ctx.models.refreshHardware().catch((error: unknown) => console.error(error));
  } else if (LOAD_SETTINGS.some((key) => key in patch)) {
    void ctx.models.unloadAll();
  }
}

export const appRouter = router({
  crew: crewRouter,
  chat: chatRouter,
  providers: providersRouter,
  workspace: workspaceRouter,
  browser: browserRouter,
  tools: toolsRouter,
  mcp: mcpRouter,
  projects: projectsRouter,
  board: boardRouter,
  context: contextRouter,
  home: homeRouter,
  github: githubRouter,
  gitlab: gitlabRouter,
  design: designRouter,
  artifacts: artifactsRouter,
  email: emailRouter,

  app: router({
    info: publicProcedure.query(({ ctx }) => ({
      ...ctx.appInfo,
      dataDir: ctx.paths.root,
      store: ctx.store.status(),
    })),
  }),

  settings: router({
    get: publicProcedure.query(({ ctx }) => ctx.settings.get()),
    update: publicProcedure.input(settingsPatchSchema).mutation(async ({ ctx, input }) => {
      const next = ctx.settings.update(input);
      applySettings(ctx, input);
      if ('localApiEnabled' in input || 'localApiPort' in input) {
        await ctx.localApi.apply(next.localApiEnabled, next.localApiPort);
      }
      return next;
    }),
  }),

  localApi: router({
    /** Whether other apps can reach the models, and where. */
    status: publicProcedure.query(({ ctx }) => ctx.localApi.status()),
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

  models: router({
    /** The Models screen's state, sent again whenever it changes. */
    live: publicProcedure.subscription(async function* ({ ctx, signal }) {
      let dirty = true;
      let wake: (() => void) | undefined;
      const onChange = () => {
        dirty = true;
        wake?.();
      };
      ctx.models.on('change', onChange);
      // The crew's model is a setting.
      ctx.settings.on('change', onChange);
      signal?.addEventListener('abort', onChange, { once: true });
      try {
        while (!signal?.aborted) {
          if (!dirty) {
            await new Promise<void>((resolve) => (wake = resolve));
            wake = undefined;
            if (signal?.aborted) break;
          }
          dirty = false;
          yield modelsSnapshot(ctx);
          await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_INTERVAL_MS));
        }
      } finally {
        ctx.models.off('change', onChange);
        ctx.settings.off('change', onChange);
      }
    }),

    snapshot: publicProcedure.query(({ ctx }) => modelsSnapshot(ctx)),

    storage: modelProcedure.query(({ ctx }) => ctx.models.storage()),

    /** What a ref would pull and whether it would fit. Hugging Face refs need the network. */
    inspect: modelProcedure
      .input(modelRefSchema)
      .query(({ ctx, input, signal }) => ctx.models.inspect(input, signal)),

    pull: modelProcedure.input(modelRefSchema).mutation(({ ctx, input }) => {
      parseModelRef(input);
      return ctx.models.pull(input);
    }),
    pausePull: modelProcedure
      .input(z.string())
      .mutation(({ ctx, input }) => ctx.models.pulls.pause(input)),
    resumePull: modelProcedure
      .input(z.string())
      .mutation(({ ctx, input }) => ctx.models.pulls.resume(input)),
    cancelPull: modelProcedure
      .input(z.string())
      .mutation(({ ctx, input }) => ctx.models.pulls.cancel(input)),
    dismissPull: modelProcedure
      .input(z.string())
      .mutation(({ ctx, input }) => ctx.models.pulls.dismiss(input)),

    /** Models in Ollama's folder that clanks can reuse instead of downloading. */
    ollama: modelProcedure.query(({ ctx }) => ctx.models.ollama()),
    importOllama: modelProcedure
      .input(z.string().min(1).max(300))
      .mutation(async ({ ctx, input }) => {
        await ctx.models.importOllama(input);
      }),
    dismissImport: modelProcedure
      .input(z.string())
      .mutation(({ ctx, input }) => ctx.models.dismissImport(input)),

    remove: modelProcedure.input(modelIdSchema).mutation(async ({ ctx, input }) => {
      await ctx.models.remove(input);
      if (ctx.settings.get().crewModel === input) ctx.settings.update({ crewModel: null });
      // Clanks that ran on it go back to the crew's model.
      ctx.crew.clearModel(BUILTIN_PROVIDER, input);
    }),
    setKeepLoaded: modelProcedure
      .input(z.object({ id: modelIdSchema, keepLoaded: z.boolean() }))
      .mutation(({ ctx, input }) => ctx.models.setKeepLoaded(input.id, input.keepLoaded)),
    load: modelProcedure.input(modelIdSchema).mutation(({ ctx, input }) => ctx.models.load(input)),
    unload: modelProcedure
      .input(modelIdSchema)
      .mutation(({ ctx, input }) => ctx.models.unload(input)),

    /** Gives the whole crew this model. Picking one also finishes first run. */
    useForCrew: modelProcedure.input(modelIdSchema).mutation(({ ctx, input }) => {
      if (!ctx.models.library().some((m) => m.id === input)) {
        throw new ModelsError(`${input} isn't pulled`);
      }
      return ctx.settings.update({ crewModel: input, onboarded: true });
    }),

    /** Asks for a folder, then moves the models there. Resolves false if the user cancels. */
    moveStorage: modelProcedure.mutation(async ({ ctx }) => {
      if (!ctx.host) throw new ModelsError("Moving the models folder needs the app's file dialog");
      const current = (await ctx.models.storage()).dir;
      const to = await ctx.host.pickFolder({ title: 'Move models to', defaultPath: current });
      if (!to) return false;
      await ctx.models.moveStorage(to);
      return true;
    }),
    dismissMoveError: modelProcedure.mutation(({ ctx }) => ctx.models.dismissMoveError()),
    openStorage: modelProcedure.mutation(async ({ ctx }) => {
      await ctx.host?.openFolder((await ctx.models.storage()).dir);
    }),

    refreshHardware: modelProcedure.mutation(({ ctx }) => ctx.models.refreshHardware()),
    installRuntime: modelProcedure
      .input(runtimeBackendSchema)
      .mutation(({ ctx, input }) => ctx.models.installRuntime(input)),
    cancelInstall: modelProcedure.mutation(({ ctx }) => ctx.models.cancelInstall()),

    /** Streams a model's reply to one prompt, for trying it out on the Models screen. */
    try: publicProcedure
      .input(
        z.object({
          model: modelIdSchema,
          prompt: z.string().trim().min(1).max(32_000),
          maxTokens: z.number().int().min(1).max(8192).optional(),
        }),
      )
      .subscription(async function* ({ ctx, input, signal }): AsyncGenerator<ChatEvent> {
        const events = ctx.providers.stream(
          BUILTIN_PROVIDER,
          {
            model: input.model,
            messages: [{ role: 'user', content: input.prompt }],
            // Small models can think in circles until the context fills; a try shouldn't.
            maxTokens: input.maxTokens ?? TRY_MAX_TOKENS,
          },
          signal ?? new AbortController().signal,
        );
        try {
          yield* events;
        } catch (error) {
          if (error instanceof ProviderError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
          }
          throw error;
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;

export const createAppCaller = createCallerFactory(appRouter);
