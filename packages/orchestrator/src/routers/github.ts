import { type GitHubStatus, githubTokenSchema, newRepoSchema } from '@clanks/core';
import { userProcedure } from '../procedures';
import { publicProcedure, router } from '../trpc';
import { snapshots } from './live';

// The window can sign in and out, but never reads the token back: it stays in the orchestrator.
export const githubRouter = router({
  status: publicProcedure.query(({ ctx }) => ctx.github.status()),

  /** Who's signed in, sent again when that changes, such as when a code sign-in completes. */
  live: publicProcedure.subscription(async function* ({
    ctx,
    signal,
  }): AsyncGenerator<GitHubStatus> {
    yield* snapshots({
      signal,
      intervalMs: 100,
      subscribe: (onChange) => {
        ctx.github.on('change', onChange);
        return () => ctx.github.off('change', onChange);
      },
      snapshot: () => ctx.github.status(),
    });
  }),

  signInWithToken: userProcedure
    .input(githubTokenSchema)
    .mutation(({ ctx, input }) => ctx.github.signInWithToken(input)),

  startDeviceFlow: userProcedure.mutation(({ ctx }) => ctx.github.startDeviceFlow()),
  cancelDeviceFlow: userProcedure.mutation(({ ctx }) => ctx.github.cancelDeviceFlow()),
  signOut: userProcedure.mutation(({ ctx }) => ctx.github.signOut()),

  repos: userProcedure.query(({ ctx }) => ctx.github.repos()),

  createRepo: userProcedure
    .input(newRepoSchema)
    .mutation(({ ctx, input }) => ctx.github.createRepo(input)),
});
