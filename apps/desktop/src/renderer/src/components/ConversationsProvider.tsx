import { useQuery } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import type { ReactNode } from 'react';
import { ConversationsContext } from '../lib/crew';
import { useTRPC } from '../lib/trpc';

/** Keeps one live subscription to the conversation list for the whole window. */
export function ConversationsProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const initial = useQuery(trpc.chat.list.queryOptions());
  const live = useSubscription(trpc.chat.conversations.subscriptionOptions());
  return (
    <ConversationsContext value={live.data ?? initial.data ?? null}>
      {children}
    </ConversationsContext>
  );
}
