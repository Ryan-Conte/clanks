import {
  type McpServerStatus,
  clankIdSchema,
  mcpServerInputSchema,
  toolNameSchema,
  toolPolicyLevelSchema,
} from '@clanks/core';
import { z } from 'zod';
import { userProcedure } from '../procedures';
import { publicProcedure, router } from '../trpc';
import { snapshots } from './live';

export const toolsRouter = router({
  /** A clank's tools and what applies to each. */
  policies: userProcedure.input(clankIdSchema).query(({ ctx, input }) => ctx.tools.policies(input)),

  /** Sets a clank's policy for one tool. Null goes back to its doc's. */
  setPolicy: userProcedure
    .input(
      z.object({
        clankId: clankIdSchema,
        tool: toolNameSchema,
        level: toolPolicyLevelSchema.nullable(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.tools.setPolicy(input.clankId, input.tool, input.level)),

  /** Every "always allow" the user gave from an approval prompt. */
  rules: publicProcedure.query(({ ctx }) => ctx.tools.rules()),

  deleteRule: publicProcedure
    .input(z.uuid())
    .mutation(({ ctx, input }) => ctx.tools.deleteRule(input)),
});

export const mcpRouter = router({
  list: publicProcedure.query(({ ctx }) => ctx.mcp.list()),

  /** The servers and whether each is running, sent again as that changes. */
  live: publicProcedure.subscription(async function* ({
    ctx,
    signal,
  }): AsyncGenerator<McpServerStatus[]> {
    yield* snapshots({
      signal,
      intervalMs: 150,
      subscribe: (onChange) => {
        ctx.mcp.on('change', onChange);
        return () => ctx.mcp.off('change', onChange);
      },
      snapshot: () => ctx.mcp.list(),
    });
  }),

  add: userProcedure.input(mcpServerInputSchema).mutation(({ ctx, input }) => ctx.mcp.add(input)),

  update: userProcedure
    .input(z.object({ id: z.uuid(), server: mcpServerInputSchema }))
    .mutation(({ ctx, input }) => ctx.mcp.update(input.id, input.server)),

  remove: userProcedure.input(z.uuid()).mutation(({ ctx, input }) => ctx.mcp.remove(input)),

  /** Starts the server, or restarts it, to see its tools. */
  test: userProcedure.input(z.uuid()).mutation(({ ctx, input }) => ctx.mcp.test(input)),
});
