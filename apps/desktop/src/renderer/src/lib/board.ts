import {
  type BoardSnapshot,
  type ClankSummary,
  type OutputType,
  type TicketCard,
  type Usage,
  compactNumber,
} from '@clanks/core';
import type { Tone } from '../components/ui';
import { formatSeconds } from './format';

/** How each output type reads on a card. */
export const TYPE_LABELS: Record<OutputType, string> = {
  spec: 'Spec',
  design: 'Design',
  pr: 'PR',
  copy: 'Copy',
  doc: 'Doc',
  email: 'Email',
  research: 'Research',
  campaign: 'Campaign',
  other: 'Other',
};

/** The fields of a written hand-in its own view shows, so they aren't listed again below it. */
export const SHOWN_FIELDS = new Set([
  'type',
  'title',
  'body',
  'note',
  'plan',
  'posts',
  'to',
  'cc',
  'subject',
  'sources',
  'screenshots',
  'warnings',
  'path',
]);

/** What a card says about where its ticket is: always an icon and words, never colour alone. */
export interface CardStatus {
  icon: string;
  text: string;
  tone: Tone;
  live: boolean;
  /** The clank it's with, if one. */
  clankId: string | null;
}

export function cardStatus(
  card: TicketCard,
  snapshot: BoardSnapshot,
  name: (clankId: string) => string,
): CardStatus {
  const step = card.route[card.step];
  const working = card.column === 'build' || card.column === 'review';
  const clankId = working ? (card.detour?.clankId ?? step?.clankId ?? null) : null;
  const base = { live: false, clankId };
  if (card.column === 'done') {
    return card.outcome === 'rejected'
      ? { ...base, icon: '✕', text: 'Rejected', tone: 'dim' }
      : {
          ...base,
          icon: '✓',
          text: card.sent?.at ? 'Sent' : card.delivery?.merged ? 'Merged' : 'Done',
          tone: 'dim',
        };
  }
  if (card.column === 'ready') {
    if (card.state === 'looping') {
      return {
        ...base,
        icon: '!',
        text: `Bounced ${card.bounces} times, came to you`,
        tone: 'amber',
      };
    }
    if (card.delivery?.error) {
      return { ...base, icon: '!', text: "Couldn't merge: see the ticket", tone: 'amber' };
    }
    if (card.sent?.error) {
      return { ...base, icon: '!', text: "Couldn't send: see the ticket", tone: 'amber' };
    }
    const signer = card.route.at(-1)?.clankId;
    return {
      ...base,
      icon: '✓',
      text: signer ? `${name(signer)} signed off` : 'Ready for you',
      tone: 'mint',
    };
  }
  if (card.live?.asking) return { ...base, icon: '!', text: card.live.label, tone: 'amber' };
  if (card.state === 'question')
    return { ...base, icon: '!', text: 'Question for you', tone: 'amber' };
  if (card.state === 'failed') {
    return {
      ...base,
      icon: '✕',
      text: `Failed: ${card.reason ?? 'no reason given'}`,
      tone: 'rose',
    };
  }
  if (card.state === 'paused') {
    const budget = card.reason?.startsWith('Paused:') ? card.reason.replace(/\.$/, '') : null;
    return { ...base, icon: '‖', text: budget ?? 'Paused', tone: budget ? 'amber' : 'dim' };
  }
  if (card.state === 'waiting') {
    return {
      ...base,
      icon: '◐',
      text: `${card.step < 0 ? 'Ready · ' : clankId ? `${name(clankId)} next · ` : ''}${card.reason?.replace(/\.$/, '') ?? 'Waiting for a free slot'}`,
      tone: card.reason?.startsWith('Paused:') ? 'amber' : 'dim',
    };
  }
  if (working) {
    // The card's live line says what it's doing.
    const answering = card.detour ? ` · answering ${name(card.detour.from)}` : '';
    return {
      ...base,
      icon: '●',
      text: clankId ? `${name(clankId)}${card.live ? '' : ' · starting'}${answering}` : 'Starting',
      tone: 'mint',
      live: card.live !== null,
    };
  }
  const waiting = card.dependsOn
    .map((id) => snapshot.tickets.find((t) => t.id === id))
    .filter((t) => t && t.column !== 'done')
    .map((t) => t!.key);
  if (waiting.length > 0) {
    return { ...base, icon: '○', text: `Waits on ${waiting.join(', ')}`, tone: 'dim' };
  }
  if (card.proposed)
    return { ...base, icon: '○', text: 'Proposed, waiting for you', tone: 'lavender' };
  return {
    ...base,
    icon: '○',
    text: card.assignee
      ? `${name(card.assignee)} · next`
      : `Open: next free ${TYPE_LABELS[card.type]} maker`,
    tone: 'dim',
  };
}

/** A clank's name, or the id when it's not in the crew list. */
export function namer(crew: ClankSummary[]): (clankId: string) => string {
  return (id) => crew.find((c) => c.id === id)?.name ?? id;
}

/** Who did something in the feed. */
export function actorName(actor: string, crew: ClankSummary[]): string {
  if (actor === 'user') return 'You';
  if (actor === 'app') return 'clanks';
  return namer(crew)(actor);
}

/** Steps done out of the plan the clank posted, such as "3/5 steps". */
export function progressText(card: TicketCard): string | null {
  const steps = card.progress?.steps ?? [];
  if (steps.length === 0) return null;
  return `${steps.filter((s) => s.done).length}/${steps.length} steps`;
}

/** Spending in a few words: "120k tokens · 4 min 10 s · $0.42". */
export function usageText(usage: Usage): string {
  const parts = [`${compactNumber(usage.tokens)} tokens`, formatSeconds(usage.ms)];
  if (usage.dollars > 0) parts.push(`$${usage.dollars.toFixed(2)}`);
  if (usage.unpriced > 0)
    parts.push(`${usage.unpriced} cloud ${usage.unpriced === 1 ? 'call' : 'calls'} unpriced`);
  return parts.join(' · ');
}

/** The pull request's checks, as a card's badge shows them. */
export function ciText(ci: 'pending' | 'passing' | 'failing' | null): string {
  return ci === 'passing' ? 'CI ✓' : ci === 'failing' ? 'CI ✕' : ci === 'pending' ? 'CI …' : '';
}
