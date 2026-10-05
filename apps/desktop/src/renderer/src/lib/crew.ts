import type {
  Avatar,
  ClankSummary,
  ConversationSummary,
  ModelChoice,
  ProviderStatus,
} from '@clanks/core';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { useModels } from './models';
import { useTRPC } from './trpc';

/** Each colour's gradient, as the clanks on clanks.si wear them. */
export const AVATAR_GRADIENTS: Record<Avatar, string> = {
  violet: 'from-violet-300 to-indigo-400',
  rose: 'from-rose-200 to-pink-400',
  fuchsia: 'from-fuchsia-200 to-purple-400',
  amber: 'from-amber-200 to-orange-400',
  lime: 'from-lime-200 to-green-400',
  emerald: 'from-emerald-200 to-teal-400',
  sky: 'from-sky-200 to-blue-400',
  yellow: 'from-yellow-200 to-amber-400',
  orange: 'from-orange-200 to-red-400',
  cyan: 'from-cyan-200 to-sky-400',
  red: 'from-red-300 to-rose-500',
  slate: 'from-slate-300 to-zinc-500',
};

export function useCrew(): ClankSummary[] {
  const trpc = useTRPC();
  return useQuery(trpc.crew.list.queryOptions()).data ?? [];
}

export function useClank(id: string | null | undefined): ClankSummary | undefined {
  return useCrew().find((c) => c.id === id);
}

export function useProviders(): ProviderStatus[] {
  const trpc = useTRPC();
  return useQuery(trpc.providers.list.queryOptions()).data ?? [];
}

/** The conversation list, kept live for the whole window. Null until it first arrives. */
export const ConversationsContext = createContext<ConversationSummary[] | null>(null);

export function useConversations(): ConversationSummary[] | null {
  return useContext(ConversationsContext);
}

/** The model a clank runs on: its own, or the crew's. Null when there's none yet. */
export function useClankModel(clank: ClankSummary | undefined): ModelChoice | null {
  const snapshot = useModels();
  if (!clank) return null;
  if (clank.model) return clank.model;
  return snapshot?.crewModel ? { provider: 'builtin', model: snapshot.crewModel } : null;
}

/** The provider's name: Anthropic, or the name the user gave a server. */
export function providerName(choice: ModelChoice, providers: ProviderStatus[]): string {
  return providers.find((p) => p.id === choice.provider)?.name ?? choice.provider;
}

/** Where a model runs, in a few words: "this machine", "Anthropic, your key", or a server's name. */
export function whereItRuns(choice: ModelChoice, providers: ProviderStatus[]): string {
  if (choice.provider === 'builtin') return 'this machine';
  const name = providerName(choice, providers);
  return choice.provider.startsWith('server-') ? name : `${name}, your key`;
}
