import { useQuery } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import type { ReactNode } from 'react';
import { ModelsContext } from '../lib/models';
import { useTRPC } from '../lib/trpc';

/** Keeps one live subscription to the model manager for the whole window. */
export function ModelsProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const initial = useQuery(trpc.models.snapshot.queryOptions());
  const live = useSubscription(trpc.models.live.subscriptionOptions());
  return <ModelsContext value={live.data ?? initial.data ?? null}>{children}</ModelsContext>;
}
