import type { GitHubStatus, GitLabStatus } from '@clanks/core';
import { useQuery } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useTRPC } from './trpc';

/** Who's signed in to GitHub, kept live: a code sign-in finishes in the background. */
export function useGitHub(): GitHubStatus | undefined {
  const trpc = useTRPC();
  const initial = useQuery(trpc.github.status.queryOptions());
  const live = useSubscription(trpc.github.live.subscriptionOptions());
  return live.data ?? initial.data;
}

/** Who's signed in to GitLab, kept live. */
export function useGitLab(): GitLabStatus | undefined {
  const trpc = useTRPC();
  const initial = useQuery(trpc.gitlab.status.queryOptions());
  const live = useSubscription(trpc.gitlab.live.subscriptionOptions());
  return live.data ?? initial.data;
}
