import { type ClankId, GRADIENTS } from './crew';

/**
 * The hero's board: a small project the crew works through, step by step, in the app's own
 * words. The page renders the first state; the board script plays the rest. Both draw it with
 * the functions here, so it looks the same with or without JavaScript.
 */

export type Column = 'todo' | 'build' | 'review' | 'ready';
type Tone = 'mint' | 'amber' | 'dim';

export interface Card {
  key: string;
  title: string;
  type: 'Code' | 'Copy';
  column: Column;
  /** The clank it's with. */
  who: ClankId | null;
  status: string;
  tone: Tone;
  live: boolean;
  progress: string | null;
  bounces: number;
}

export interface FeedLine {
  who: string;
  text: string;
  tone: Tone | 'white';
}

export interface BoardState {
  cards: Card[];
  feed: FeedLine[];
}

/** What changes in one beat: fields of some cards, and maybe a line in the feed. */
export interface Step {
  cards: Record<string, Partial<Card>>;
  feed?: FeedLine;
}

const card = (c: Partial<Card> & Pick<Card, 'key' | 'title' | 'type' | 'column'>): Card => ({
  who: null,
  status: '',
  tone: 'dim',
  live: false,
  progress: null,
  bounces: 0,
  ...c,
});

export const COLUMNS: { id: Column; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'build', label: 'In progress' },
  { id: 'review', label: 'Being checked' },
  { id: 'ready', label: 'Ready for you' },
];

export const INITIAL: BoardState = {
  cards: [
    card({
      key: 'CLK-105',
      title: 'Contact form with opening hours',
      type: 'Code',
      column: 'todo',
      status: 'Waiting on CLK-103',
    }),
    card({
      key: 'CLK-106',
      title: 'Launch email to regulars',
      type: 'Copy',
      column: 'todo',
      status: 'For Quill',
    }),
    card({
      key: 'CLK-103',
      title: 'Order ahead for pickup',
      type: 'Code',
      column: 'build',
      who: 'forge',
      status: 'Running npm test',
      tone: 'mint',
      live: true,
      progress: '3/5',
    }),
    card({
      key: 'CLK-104',
      title: 'About us, in our voice',
      type: 'Copy',
      column: 'build',
      who: 'quill',
      status: 'Writing the second draft',
      tone: 'mint',
      live: true,
    }),
    card({
      key: 'CLK-102',
      title: 'Menu with prices and photos',
      type: 'Code',
      column: 'review',
      who: 'gauge',
      status: 'Clicking through on a phone',
      tone: 'mint',
      live: true,
      bounces: 1,
    }),
    card({
      key: 'CLK-101',
      title: 'Home page with hero and hours',
      type: 'Code',
      column: 'ready',
      who: 'atlas',
      status: 'Signed off by Atlas',
      tone: 'amber',
    }),
  ],
  feed: [
    { who: 'Atlas', text: 'signed off CLK-101, ready for you', tone: 'white' },
    {
      who: 'Gauge',
      text: 'bounced CLK-102 to Forge: AC-4 failed, prices cut off on small screens',
      tone: 'amber',
    },
    { who: 'Forge', text: 'fixed the menu grid, sent CLK-102 back to Gauge', tone: 'white' },
    { who: 'Quill', text: 'picked up CLK-104', tone: 'white' },
    { who: 'You', text: 'approved the spec', tone: 'dim' },
  ],
};

export const STEPS: Step[] = [
  { cards: { 'CLK-103': { status: 'All 14 tests passed', progress: '4/5' } } },
  {
    cards: {
      'CLK-103': {
        column: 'review',
        who: 'gauge',
        status: 'Checking AC-1 to AC-3',
        progress: null,
      },
      'CLK-105': { status: 'Ready to start' },
    },
    feed: { who: 'Forge', text: 'opened a pull request for CLK-103', tone: 'white' },
  },
  {
    cards: {
      'CLK-105': {
        column: 'build',
        who: 'forge',
        status: 'Reading the spec',
        tone: 'mint',
        live: true,
        progress: '1/4',
      },
    },
    feed: { who: 'Forge', text: 'picked up CLK-105', tone: 'white' },
  },
  {
    cards: { 'CLK-102': { status: 'All 4 checks passed' } },
    feed: { who: 'Gauge', text: 'passed CLK-102: every check met', tone: 'white' },
  },
  {
    cards: {
      'CLK-102': {
        column: 'ready',
        who: 'atlas',
        status: 'Signed off by Atlas',
        tone: 'amber',
        live: false,
      },
    },
    feed: { who: 'Atlas', text: 'signed off CLK-102, ready for you', tone: 'white' },
  },
  {
    cards: {
      'CLK-104': { column: 'review', who: 'atlas', status: 'Reading it against the brief' },
    },
    feed: { who: 'Quill', text: 'handed in CLK-104 for review', tone: 'white' },
  },
  {
    cards: { 'CLK-105': { status: 'Writing the form', progress: '2/4' } },
  },
  {
    cards: {
      'CLK-103': {
        column: 'build',
        who: 'forge',
        status: 'Adding a pickup time',
        bounces: 1,
        progress: '4/5',
      },
    },
    feed: {
      who: 'Gauge',
      text: 'bounced CLK-103 to Forge: AC-3 failed, no pickup time on the order',
      tone: 'amber',
    },
  },
  {
    cards: {
      'CLK-106': {
        column: 'build',
        who: 'quill',
        status: 'Drafting the launch email',
        tone: 'mint',
        live: true,
      },
    },
    feed: { who: 'Quill', text: 'picked up CLK-106', tone: 'white' },
  },
  { cards: { 'CLK-105': { status: 'Running npm test', progress: '3/4' } } },
];

/** The state after one more step. */
export function advance(state: BoardState, step: Step): BoardState {
  return {
    cards: state.cards.map((c) => ({ ...c, ...step.cards[c.key] })),
    feed: step.feed ? [step.feed, ...state.feed].slice(0, 5) : state.feed,
  };
}

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function avatarHtml(who: ClankId, size: 'xs' | 'sm', live = false): string {
  const box = size === 'xs' ? 'size-4' : 'size-5';
  return `<span aria-hidden="true" class="grid ${box} shrink-0 place-items-center rounded-full bg-gradient-to-br ${GRADIENTS[who]} ${live ? 'animate-breathe' : ''}"><span class="size-[38%] rounded-full bg-black/70 ${live ? 'animate-pulse-dot' : ''}"></span></span>`;
}

const TONES: Record<FeedLine['tone'], string> = {
  mint: 'text-accent-2',
  amber: 'text-amber-200',
  dim: 'text-dim',
  white: 'text-white',
};

function cardHtml(c: Card, fresh: boolean): string {
  const border = c.column === 'ready' ? 'border-amber-300/30' : 'border-line';
  const bounce = c.bounces
    ? `<span class="text-amber-200" title="Sent back ${c.bounces} time${c.bounces > 1 ? 's' : ''}">↩${c.bounces}</span>`
    : '';
  const who = c.who ? avatarHtml(c.who, 'xs', c.live) : '';
  const progress = c.progress
    ? `<span class="tabular ml-auto shrink-0 font-mono text-[11px] text-dim">${c.progress}</span>`
    : '';
  return `<li data-key="${c.key}" class="flex flex-col gap-1.5 rounded-xl border ${border} bg-black/30 px-3 py-2.5 ${fresh ? 'animate-rise' : ''}">
  <span class="flex items-center justify-between gap-2 font-mono text-[11px] whitespace-nowrap text-dim">${c.key}<span class="flex items-center gap-1.5">${bounce}<span class="rounded-full bg-white/[0.06] px-1.5 font-sans">${c.type}</span></span></span>
  <span class="text-[13px] leading-snug text-white">${escape(c.title)}</span>
  <span class="flex min-w-0 items-start gap-1.5 text-[12px] leading-4 ${TONES[c.tone]}">${who}<span class="min-w-0">${escape(c.status)}</span>${progress}</span>
</li>`;
}

/** The columns, with `fresh` cards rising into place. */
export function columnsHtml(state: BoardState, fresh: Set<string> = new Set()): string {
  return COLUMNS.map(({ id, label }) => {
    const cards = state.cards.filter((c) => c.column === id);
    return `<div class="flex min-w-0 flex-col gap-2">
  <p class="text-xs text-dim">${label} <span class="tabular text-white/40">${cards.length}</span></p>
  <ul class="flex flex-col gap-2" aria-label="${label}">${cards.map((c) => cardHtml(c, fresh.has(c.key))).join('')}</ul>
</div>`;
  }).join('');
}

export function feedHtml(state: BoardState): string {
  return state.feed
    .map(
      (line, i) =>
        `<li class="text-[12px] leading-relaxed text-white/80 ${i === 0 ? 'animate-rise' : ''}"><b class="font-medium ${TONES[line.tone]}">${line.who}</b> › ${escape(line.text)}</li>`,
    )
    .join('');
}

export function workingText(state: BoardState): string {
  const n = new Set(state.cards.filter((c) => c.live).map((c) => c.who)).size;
  return `${n} clank${n === 1 ? '' : 's'} working`;
}

export function needsYouHtml(state: BoardState): string {
  const ready = state.cards.filter((c) => c.column === 'ready');
  const [first] = ready;
  if (!first) return 'Nothing needs you right now';
  return ready.length === 1
    ? `<b class="font-medium">${first.key} ${escape(first.title)}</b> is signed off and ready to approve`
    : `<b class="font-medium">${ready.length} tickets</b> are signed off and ready to approve`;
}
