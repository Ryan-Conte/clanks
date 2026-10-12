import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { type ReactNode, useEffect } from 'react';
import { ModelsContext } from '../lib/models';
import { useTRPC } from '../lib/trpc';

/** Keeps one live subscription to the model manager for the whole window. */
export function ModelsProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const initial = useQuery(trpc.models.snapshot.queryOptions());
  const live = useSubscription(trpc.models.live.subscriptionOptions());
  const snapshot = live.data ?? initial.data ?? null;
  // The app itself changes these settings when first run's download lands, so the window's copy
  // of the settings is fetched again whenever they move.
  const mark = snapshot ? `${snapshot.crewModel}\n${snapshot.setupModel}` : null;
  useEffect(() => {
    if (mark !== null) {
      void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() });
    }
  }, [mark, queryClient, trpc]);
  return <ModelsContext value={snapshot}>{children}</ModelsContext>;
}
