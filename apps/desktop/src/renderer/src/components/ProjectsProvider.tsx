import { useQuery } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import type { ReactNode } from 'react';
import { ProjectsContext } from '../lib/projects';
import { useTRPC } from '../lib/trpc';

/** Keeps one live subscription to the project list, with each board's counts, for the window. */
export function ProjectsProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const initial = useQuery(trpc.projects.list.queryOptions());
  const live = useSubscription(trpc.projects.live.subscriptionOptions());
  return <ProjectsContext value={live.data ?? initial.data ?? null}>{children}</ProjectsContext>;
}
