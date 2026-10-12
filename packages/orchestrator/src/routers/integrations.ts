import {
  type IntegrationsSnapshot,
  type MarketplaceSnapshot,
  clankIdSchema,
  connectInputSchema,
  connectionModeSchema,
  indexUrlSchema,
  integrationIdSchema,
  packageIdSchema,
  packageKindSchema,
  projectIdSchema,
  publishInputSchema,
  versionSchema,
} from '@clanks/core';
import { z } from 'zod';
import { IntegrationError } from '../integrations/service';
import { MarketplaceError } from '../marketplace/service';
import { userProcedure } from '../procedures';
import { publicProcedure, router } from '../trpc';
import { snapshots } from './live';

// The window can connect, check and disconnect an account, but never reads its credential back:
// it stays in the keychain, and only the orchestrator signs requests with it.
export const integrationsRouter = router({
  list: publicProcedure.query(({ ctx }) => ctx.integrations.snapshot()),

  /** Integrations and their accounts, sent again when they change, such as when a sign-in ends. */
  live: publicProcedure.subscription(async function* ({
    ctx,
    signal,
  }): AsyncGenerator<IntegrationsSnapshot & { problems: string[] }> {
    yield* snapshots({
      signal,
      intervalMs: 150,
      subscribe: (onChange) => {
        ctx.integrations.on('change', onChange);
        ctx.mcp.on('change', onChange);
        return () => {
          ctx.integrations.off('change', onChange);
          ctx.mcp.off('change', onChange);
        };
      },
      snapshot: () => ctx.integrations.snapshot(),
    });
  }),

  /** Connects an account with a key or password, once the service has accepted it. */
  connect: userProcedure
    .input(connectInputSchema)
    .mutation(({ ctx, input }) => ctx.integrations.connect(input)),

  /** Opens the service's sign-in page in the user's browser, and waits for it to hand back. */
  startOAuth: userProcedure
    .input(connectInputSchema)
    .mutation(({ ctx, input }) => ctx.integrations.startOAuth(input)),

  cancelOAuth: userProcedure.mutation(({ ctx }) => ctx.integrations.cancelOAuth()),

  check: userProcedure.input(z.uuid()).mutation(({ ctx, input }) => ctx.integrations.check(input)),

  rename: userProcedure
    .input(z.object({ id: z.uuid(), label: z.string().trim().min(1).max(60) }))
    .mutation(({ ctx, input }) => ctx.integrations.rename(input.id, input.label)),

  setMode: userProcedure
    .input(z.object({ id: z.uuid(), mode: connectionModeSchema }))
    .mutation(({ ctx, input }) => ctx.integrations.setMode(input.id, input.mode)),

  /** Lets an account's credential go to hosts a newer version of its integration calls. */
  allowHosts: userProcedure
    .input(z.uuid())
    .mutation(({ ctx, input }) => ctx.integrations.allowHosts(input)),

  disconnect: userProcedure
    .input(z.uuid())
    .mutation(({ ctx, input }) => ctx.integrations.disconnect(input)),

  /** Turns an account on in a project for some clanks, or off with null. */
  setProject: userProcedure
    .input(
      z.object({
        projectId: projectIdSchema,
        connectionId: z.uuid(),
        clanks: z.array(clankIdSchema).max(64).nullable(),
      }),
    )
    .mutation(({ ctx, input }) => {
      ctx.projects.get(input.projectId);
      const crew = ctx.projects.members(input.projectId).map((m) => m.clankId);
      ctx.integrations.setProject(
        input.projectId,
        input.connectionId,
        input.clanks?.filter((id) => crew.includes(id)) ?? null,
      );
    }),

  /** Asks for a folder with an integration of the user's own in it, and adds it. */
  addFromFolder: userProcedure.mutation(async ({ ctx }) => {
    if (!ctx.host) throw new IntegrationError("Adding one needs the app's folder dialog");
    const folder = await ctx.host.pickFolder({ title: 'A folder with a manifest.yaml in it' });
    if (!folder) return null;
    return ctx.integrations.addFromFolder(folder);
  }),

  /** Removes an integration the user added from a folder. */
  remove: userProcedure.input(integrationIdSchema).mutation(async ({ ctx, input }) => {
    if (ctx.integrations.sourceOf(input) !== 'local') {
      throw new IntegrationError('Uninstall it from the Marketplace page instead');
    }
    await ctx.integrations.uninstall(input);
  }),

  /** Sets up the server an MCP integration runs: what it needs, who gets its tools, and where. */
  setUpServer: userProcedure
    .input(
      z.object({
        integrationId: integrationIdSchema,
        /** Null keeps what's in the keychain. */
        env: z.record(z.string(), z.string().max(8192)).nullable(),
        clanks: z.array(clankIdSchema).max(64),
        docker: z.boolean(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.integrations.setUpServer(input)),
});

const packageRef = z.object({ kind: packageKindSchema, id: packageIdSchema });

export const marketplaceRouter = router({
  snapshot: publicProcedure.query(({ ctx }) => ctx.marketplace.snapshot()),

  live: publicProcedure.subscription(async function* ({
    ctx,
    signal,
  }): AsyncGenerator<MarketplaceSnapshot> {
    yield* snapshots({
      signal,
      intervalMs: 150,
      subscribe: (onChange) => {
        ctx.marketplace.on('change', onChange);
        ctx.integrations.on('change', onChange);
        return () => {
          ctx.marketplace.off('change', onChange);
          ctx.integrations.off('change', onChange);
        };
      },
      snapshot: () => ctx.marketplace.snapshot(),
    });
  }),

  /** Reads every marketplace again. Browsing needs the network; what's installed doesn't. */
  refresh: userProcedure.mutation(({ ctx }) => ctx.marketplace.refresh()),

  addIndex: userProcedure
    .input(indexUrlSchema)
    .mutation(({ ctx, input }) => ctx.marketplace.addIndex(input)),

  /** Asks for a folder that holds a marketplace, such as a team's on a shared drive. */
  addIndexFolder: userProcedure.mutation(async ({ ctx }) => {
    if (!ctx.host) throw new MarketplaceError("Adding one needs the app's folder dialog");
    const folder = await ctx.host.pickFolder({ title: 'A folder with an index.json in it' });
    if (!folder) return false;
    await ctx.marketplace.addIndex(folder);
    return true;
  }),

  removeIndex: userProcedure
    .input(z.string().max(1000))
    .mutation(({ ctx, input }) => ctx.marketplace.removeIndex(input)),

  /** A package version in full, fetched and verified, before anything is installed. */
  preview: userProcedure
    .input(packageRef.extend({ index: z.string().max(1000), version: versionSchema.optional() }))
    .query(({ ctx, input }) => ctx.marketplace.preview(input)),

  install: userProcedure
    .input(
      packageRef.extend({
        index: z.string().max(1000),
        version: versionSchema,
        /** The digest the preview showed: what's installed must be exactly that. */
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .mutation(({ ctx, input }) => ctx.marketplace.install(input)),

  uninstall: userProcedure
    .input(packageRef)
    .mutation(({ ctx, input }) => ctx.marketplace.uninstall(input.kind, input.id)),

  setPinned: userProcedure
    .input(packageRef.extend({ pinned: z.boolean() }))
    .mutation(({ ctx, input }) => ctx.marketplace.setPinned(input.kind, input.id, input.pinned)),

  /** The crews installed, for a new project to start from. */
  crews: publicProcedure.query(({ ctx }) => ctx.marketplace.crews()),

  publishPreview: userProcedure
    .input(z.object({ kind: z.enum(['clank', 'integration']), id: packageIdSchema }))
    .query(({ ctx, input }) => ctx.marketplace.publishPreview(input)),

  /** Opens the pull request. The window sends this only after the user confirmed it. */
  publish: userProcedure
    .input(publishInputSchema.extend({ acknowledged: z.boolean() }))
    .mutation(({ ctx, input }) => ctx.marketplace.publish(input)),
});
