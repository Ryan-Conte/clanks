import { type GitLabStatus, gitlabSignInSchema, newRepoSchema } from '@clanks/core';
import { userProcedure } from '../procedures';
import { publicProcedure, router } from '../trpc';
import { snapshots } from './live';

// As with GitHub: the window can sign in and out, but never reads the token back.
export const gitlabRouter = router({
  status: publicProcedure.query(({ ctx }) => ctx.gitlab.status()),

  /** Who's signed in, sent again when that changes. */
  live: publicProcedure.subscription(async function* ({
    ctx,
    signal,
  }): AsyncGenerator<GitLabStatus> {
    yield* snapshots({
      signal,
      intervalMs: 100,
      subscribe: (onChange) => {
        ctx.gitlab.on('change', onChange);
        return () => ctx.gitlab.off('change', onChange);
      },
      snapshot: () => ctx.gitlab.status(),
    });
  }),

  /** Signs in with a token, on gitlab.com or the GitLab at `baseUrl`. */
  signIn: userProcedure
    .input(gitlabSignInSchema)
    .mutation(({ ctx, input }) => ctx.gitlab.signIn(input.token, input.baseUrl)),

  signOut: userProcedure.mutation(({ ctx }) => ctx.gitlab.signOut()),

  repos: userProcedure.query(({ ctx }) => ctx.gitlab.repos()),

  createRepo: userProcedure
    .input(newRepoSchema)
    .mutation(({ ctx, input }) => ctx.gitlab.createRepo(input)),
});
