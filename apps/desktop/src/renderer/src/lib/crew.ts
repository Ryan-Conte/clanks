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

/** What each of the crew that ships with the app does, in a few words anyone would use. */
const PLAIN_JOBS: Record<string, string> = {
  atlas: 'Leads the crew',
  scribe: 'Writes up the plan',
  prism: 'Designs it',
  forge: 'Builds it',
  gauge: 'Checks it works',
  scout: 'Does the research',
  quill: 'Writes the words',
  buzz: 'Spreads the word',
};

/** The same, said in a sentence, for a page that introduces one of them. */
const PLAIN_BLURBS: Record<string, string> = {
  atlas:
    'Tell Atlas what you want. It plans the work, hands it to the right clanks and checks it before it comes back to you.',
  scribe:
    'Scribe turns a rough idea into a clear, written list of what will be made, for you to approve.',
  prism: 'Prism designs how things look: pages, logos, colours and graphics.',
  forge: 'Forge builds things: websites, apps and anything else made of code.',
  gauge: "Gauge tries out what was built, the way a person would, and says what's broken.",
  scout: 'Scout looks things up, and comes back with what it found and where it found it.',
  quill: 'Quill writes: documents, emails, the words on a website, and posts.',
  buzz: 'Buzz plans how to tell people: campaigns, posts, and when they go out.',
};

/** What a clank is for, in a sentence. One the user made or installed says it its own way. */
export function plainBlurb(clank: Pick<ClankSummary, 'id' | 'summary'>): string {
  return PLAIN_BLURBS[clank.id] ?? clank.summary;
}

/** A clank's job in plain words. One the user made or installed says its own role. */
export function plainJob(clank: Pick<ClankSummary, 'id' | 'role'>): string {
  return PLAIN_JOBS[clank.id] ?? clank.role;
}

/** Things to ask a clank, to start from when the page is blank. */
const STARTERS: Record<string, string[]> = {
  atlas: [
    "I have an idea and I'm not sure where to start",
    'Help me plan a small website for my business',
    'What can this crew do for me?',
  ],
  scribe: ['Turn my idea into a clear list of what it should do'],
  prism: ['Design a simple logo and colours for my shop', 'Sketch a home page for a bakery'],
  forge: ['Make a one-page website I can open in my browser'],
  gauge: ['Check a web page for problems'],
  scout: ['Compare three ways to take payments online', 'Find out what similar businesses charge'],
  quill: ['Write a friendly email announcing our opening', "Tidy up some text I'll paste in"],
  buzz: ['Plan a week of posts for a product launch'],
};

export function startersFor(clankId: string): string[] {
  return STARTERS[clankId] ?? [];
}

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

/**
 * Whether a clank's model can see pictures. A model on this computer says so itself; one at a
 * provider is taken to, since the ones worth using there do.
 */
export function useSeesPictures(clank: ClankSummary | undefined): boolean {
  const snapshot = useModels();
  const model = useClankModel(clank);
  if (!model || model.provider !== 'builtin') return true;
  return snapshot?.library.find((m) => m.id === model.model)?.capabilities.vision ?? true;
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
