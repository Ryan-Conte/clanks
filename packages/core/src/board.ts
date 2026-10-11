import { z } from 'zod';
import {
  type ClankId,
  type OutputType,
  clankIdSchema,
  orderStages,
  outputTypeSchema,
} from './crew';
import type { Criterion, SpecStatus } from './spec';

/** The board's columns, in order. A ticket's column follows from where it is on its route. */
export const TICKET_COLUMNS = ['backlog', 'build', 'review', 'ready', 'done'] as const;

export type TicketColumn = (typeof TICKET_COLUMNS)[number];

export const COLUMN_TITLES: Record<TicketColumn, string> = {
  backlog: 'Backlog',
  build: 'Build',
  review: 'QA + review',
  ready: 'Ready for you',
  done: 'Done',
};

/**
 * One clank's turn on a ticket's route. The maker of an open ticket has no clank yet: the first
 * free one that makes the ticket's type picks it up.
 */
export interface RouteStep {
  clankId: ClankId | null;
  role: 'maker' | 'checker';
}

/**
 * How a ticket is doing where it is: waiting its turn, its turn come but waiting for a free slot,
 * being worked, waiting on the user's answer, stopped part way, failed, or bounced so often it came
 * to the user.
 */
export type TicketState =
  'idle' | 'waiting' | 'working' | 'question' | 'paused' | 'failed' | 'looping';

/** A checker's pass, as it handed it in with `review_pass`. */
export interface TicketReview extends Record<string, unknown> {
  clankId: string;
  at: string;
}

/** Where a ticket came from: a chat, a spec's planning, the board, or a clank's proposal. */
export type TicketOrigin = 'chat' | 'spec' | 'board' | 'proposal';

/** An optional check dropped from one ticket, and why. */
export interface SkippedCheck {
  clankId: ClankId;
  reason: string;
  /** `user`, or the clank that dropped it. */
  by: string;
}

/**
 * A ticket sent to a clank outside its route, such as Forge asking Scribe about a gap in the spec.
 * It goes back to the clank that sent it once the question is answered.
 */
export interface TicketDetour {
  clankId: ClankId;
  /** The clank that sent it, which gets it back. */
  from: ClankId;
}

/** How a ticket ended: approved by the user, or rejected. */
export type TicketOutcome = 'approved' | 'rejected';

/** A pull request opened for a ticket's branch. */
export interface TicketPullRequest {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  /** The checks GitHub runs on it: null until they report. */
  ci: 'pending' | 'passing' | 'failing' | null;
}

/** Where a ticket's work is: its branch, whether it's pushed, its pull request, and its merge. */
export interface TicketDelivery {
  /** `clanks/SURF-3`. */
  branch: string;
  /** The branch it merges into. */
  base: string;
  /** The commit at the tip of the branch when it was last handed in. */
  head: string | null;
  /** It has commits its base doesn't. */
  changed: boolean;
  pushedAt: string | null;
  pr: TicketPullRequest | null;
  /** The merge commit, once it's merged. */
  merged: string | null;
  /** Why the last push, pull request or merge didn't work. */
  error: string | null;
}

/**
 * An email the user approved, as it went out through their own account. `error` says why the last
 * try didn't work; `at` stays null until one does.
 */
export interface TicketSend {
  at: string | null;
  to: string[];
  cc: string[];
  /** The account it went from, as the recipient sees it. */
  from: string;
  /** The message id the server gave it. */
  messageId: string | null;
  error: string | null;
}

/** The plan a clank posted with `post_progress`, which its card shows as progress. */
export interface TicketProgress {
  message: string;
  steps: { title: string; done: boolean }[];
}

export interface Ticket {
  id: string;
  projectId: string;
  number: number;
  /** `SURF-12`. */
  key: string;
  title: string;
  description: string;
  type: OutputType;
  /** The spec stories it covers, such as `US-4`. */
  stories: string[];
  criteria: Criterion[];
  /** The clank that makes it. Null leaves it open for the first free maker of its type. */
  assignee: ClankId | null;
  /** Its maker, then the checkers for its type in stage order, ending with sign-off. */
  route: RouteStep[];
  /** Where it is on its route: -1 before it starts, `route.length` once it's with the user. */
  step: number;
  state: TicketState;
  /** The question it asks, why it failed, or why it came to the user. */
  reason: string | null;
  bounces: number;
  /** Its place in the backlog: lower comes first. */
  rank: number;
  origin: TicketOrigin;
  /** `user`, or the clank that made it. */
  createdBy: string;
  /** Filed by a maker for Atlas to accept, merge or close. */
  proposed: boolean;
  /** The spec version it was planned from, or that a spec ticket writes. */
  specVersion: number | null;
  progress: TicketProgress | null;
  /** What the maker handed in with `submit_output`. */
  output: Record<string, unknown> | null;
  /** Its checkers' passes, in order. */
  reviews: TicketReview[];
  /** The chat it came from. */
  conversationId: string | null;
  /** The tickets it waits on, by id. */
  dependsOn: string[];
  /** Optional checks dropped from its route, with why. */
  skipped: SkippedCheck[];
  /** Set while it's with a clank outside its route, answering a bounce. */
  detour: TicketDetour | null;
  /** What the next run on it is told when the scheduler starts it. Set while it's waiting. */
  queued: string | null;
  /** Its branch, pull request and merge, once its maker has handed something in. */
  delivery: TicketDelivery | null;
  /** For an email: how sending it went, once the user has approved it. */
  sent: TicketSend | null;
  /** How it ended. Null until it's done. */
  outcome: TicketOutcome | null;
  createdAt: Date;
  updatedAt: Date;
  doneAt: Date | null;
}

/** A clank sending a ticket back, with why. */
export interface Bounce {
  id: string;
  ticketId: string;
  /** A clank's id, or `user` for changes the user asked for. */
  from: string;
  to: ClankId;
  reason: string;
  issues: string[];
  at: Date;
}

/** The column a ticket is in, from where it is on its route. */
export function columnOf(ticket: Pick<Ticket, 'step' | 'route' | 'doneAt'>): TicketColumn {
  if (ticket.doneAt) return 'done';
  if (ticket.step < 0) return 'backlog';
  if (ticket.step >= ticket.route.length) return 'ready';
  return ticket.route[ticket.step]!.role === 'maker' ? 'build' : 'review';
}

/** The clank whose turn it is, if it's a clank's: one answering a bounce has it meanwhile. */
export function currentClank(
  ticket: Pick<Ticket, 'step' | 'route' | 'doneAt'> & { detour?: TicketDetour | null },
): ClankId | null {
  if (ticket.doneAt || ticket.step < 0) return null;
  if (ticket.detour) return ticket.detour.clankId;
  return ticket.route[ticket.step]?.clankId ?? null;
}

/** What the clank whose turn it is does on the ticket now. */
export function currentRole(
  ticket: Pick<Ticket, 'step' | 'route' | 'doneAt'> & { detour?: TicketDetour | null },
): RunRole | null {
  if (ticket.doneAt || ticket.step < 0 || ticket.step >= ticket.route.length) return null;
  if (ticket.detour) return 'helper';
  return ticket.route[ticket.step]!.role;
}

/** A clank as the workflow sees it: what it makes, which tickets it checks, who it bounces to. */
export interface WorkflowMember {
  id: ClankId;
  name: string;
  kind: 'maker' | 'checker';
  stage: string;
  after?: string | undefined;
  appliesTo: (OutputType | 'all')[];
  outputs: OutputType[];
  /** Clank ids, `maker` or `all`. */
  bounceTo: string[];
}

/** The clanks in a crew that make a type. */
export function makersOf(type: OutputType, crew: WorkflowMember[]): WorkflowMember[] {
  return crew.filter((c) => c.kind === 'maker' && c.outputs.includes(type));
}

/** The checkers that apply to a type, in stage order: sign-off comes last. */
export function checkersFor(type: OutputType, crew: WorkflowMember[]): WorkflowMember[] {
  const stages = orderStages(crew);
  return crew
    .map((c, i) => ({ c, i }))
    .filter(
      ({ c }) =>
        c.kind === 'checker' && (c.appliesTo.includes('all') || c.appliesTo.includes(type)),
    )
    .sort((a, b) => stages.indexOf(a.c.stage) - stages.indexOf(b.c.stage) || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * A ticket's route: its maker, then every checker that applies to its type, in stage order, so a
 * `pr` goes Forge → Gauge → Atlas and a `spec` goes Scribe → Atlas. Checks skipped on the ticket
 * are left out. The user comes after.
 */
export function routeFor(
  type: OutputType,
  maker: ClankId | null,
  crew: WorkflowMember[],
  skipped: Pick<SkippedCheck, 'clankId'>[] = [],
): RouteStep[] {
  const checkers = checkersFor(type, crew)
    .filter((c) => !skipped.some((s) => s.clankId === c.id))
    .map((c) => ({ clankId: c.id, role: 'checker' as const }));
  return [{ clankId: maker, role: 'maker' }, ...checkers];
}

/** The key a project's optional checks are listed under: `gauge:pr`. */
export function checkKey(clankId: ClankId, type: OutputType): string {
  return `${clankId}:${type}`;
}

/**
 * Whether a check is required on a type in a project. Sign-off always is; the rest are unless the
 * project made them optional. Only an optional check can be skipped on a ticket.
 */
export function checkRequired(
  checker: Pick<WorkflowMember, 'id' | 'stage'>,
  type: OutputType,
  optionalChecks: readonly string[],
): boolean {
  if (checker.stage === 'signoff') return true;
  return !optionalChecks.includes(checkKey(checker.id, type));
}

/** Who a clank can send a ticket back to, on this ticket, among the crew. */
export function bounceTargets(
  sender: WorkflowMember,
  route: RouteStep[],
  crew: WorkflowMember[],
): ClankId[] {
  const targets = new Set<ClankId>();
  for (const entry of sender.bounceTo) {
    if (entry === 'all') crew.forEach((c) => targets.add(c.id));
    else if (entry === 'maker') {
      const maker = route[0]?.clankId;
      if (maker) targets.add(maker);
    } else if (crew.some((c) => c.id === entry)) targets.add(entry);
  }
  targets.delete(sender.id);
  return [...targets];
}

/**
 * What a bounce to a clank does. One that had the ticket earlier on its route gets it back, and the
 * route runs again from there, so fixed work goes through every check again. Anyone else answers
 * from outside the route, and the ticket comes back to the sender.
 */
export function bounceKind(
  ticket: Pick<Ticket, 'route' | 'step'>,
  to: ClankId,
): { kind: 'restart'; step: number } | { kind: 'detour' } {
  const step = ticket.route.slice(0, ticket.step).findIndex((s) => s.clankId === to);
  return step === -1 ? { kind: 'detour' } : { kind: 'restart', step };
}

/**
 * Why the board can't move a ticket to a column by a drag, or null when it can. The board never
 * moves a ticket itself; it asks, and the workflow decides. A drag from Backlog to Build starts a
 * ticket now; one from Build back to Backlog stops its run.
 */
export function moveRefusal(ticket: Ticket, to: TicketColumn): string | null {
  const from = columnOf(ticket);
  if (from === to) {
    return from === 'backlog' ? null : 'Only the backlog can be put in order by hand.';
  }
  if (to === 'ready' || to === 'done') {
    return 'Tickets reach you when Atlas signs them off, and approving always opens the ticket. Nothing is approved by a drag.';
  }
  if (from === 'done') return 'Done tickets stay done.';
  if (from === 'backlog' && to === 'build') {
    if (ticket.proposed) return `${ticket.key} is a proposal. Take it on first.`;
    return null;
  }
  if (from === 'build' && to === 'backlog') {
    if (ticket.type === 'spec')
      return 'A spec ticket keeps going once it has started. Pause it instead.';
    return null;
  }
  return 'The crew moves tickets through Build and QA + review as they work them.';
}

/**
 * The clank that picks up an open ticket, among the makers of its type that are free: the one that
 * made the tickets it depends on, since it knows that work, then the one with the shortest queue.
 */
export function pickMaker(
  free: ClankId[],
  input: { madeDependencies: ClankId[]; queue: (clankId: ClankId) => number },
): ClankId | null {
  if (free.length === 0) return null;
  const knows = (id: ClankId) => input.madeDependencies.filter((m) => m === id).length;
  return [...free].sort((a, b) => knows(b) - knows(a) || input.queue(a) - input.queue(b))[0]!;
}

/** Things to show for each kind of board event, in the feed. */
export type BoardEventKind =
  | 'created'
  | 'proposed'
  | 'accepted'
  | 'assigned'
  | 'started'
  | 'progress'
  | 'submitted'
  | 'passed'
  | 'bounced'
  | 'question'
  | 'failed'
  | 'looping'
  | 'approved'
  | 'rejected'
  | 'changes'
  | 'planned'
  | 'moved'
  | 'updated'
  | 'linked'
  | 'deleted'
  | 'skipped'
  | 'answered'
  | 'pushed'
  | 'merged'
  | 'noted'
  | 'paused'
  | 'stopped'
  | 'budget'
  | 'sent'
  | 'saved'
  | 'asked';

/** One line in a project's activity feed. Append-only. */
export interface BoardEvent {
  id: number;
  projectId: string;
  ticketId: string | null;
  /** `user`, `app`, or a clank's id. */
  actor: string;
  kind: BoardEventKind;
  /** The line, without its actor: "bounced SURF-3 to Forge: AC-4 failed". */
  text: string;
  at: Date;
}

/** A conversation working a ticket, or planning from a spec. */
export interface TicketRun {
  conversationId: string;
  clankId: ClankId;
  role: RunRole;
  title: string;
  replying: boolean;
}

/**
 * What a clank is doing in a run: making the ticket, checking it, answering a bounce from outside
 * its route, planning from the spec, or answering another clank's quick question (`ask_clank`).
 */
export type RunRole = 'maker' | 'checker' | 'helper' | 'planner' | 'consult';

/** The roles that work a ticket along its route, and so end with a finishing call. */
export function isTicketRole(
  role: RunRole | null | undefined,
): role is 'maker' | 'checker' | 'helper' {
  return role === 'maker' || role === 'checker' || role === 'helper';
}

/** What's happening on a ticket right now, for its card. */
export interface TicketLive {
  conversationId: string;
  clankId: ClankId;
  /** "Running `npm test`", "Thinking", "Loading gemma4:26b". */
  label: string;
  /** A tool call waits for the user's approval. */
  asking: boolean;
  /** When the reply being written began. */
  since: Date;
}

/** Tokens, time and money spent: on a ticket, by a clank, or in a project. */
export interface Usage {
  tokens: number;
  /** Time models spent writing, in milliseconds. */
  ms: number;
  /** Cloud spend in dollars, from the prices in Settings. Local models cost nothing. */
  dollars: number;
  /** Cloud calls with no price set, so `dollars` leaves them out. */
  unpriced: number;
}

export const emptyUsage = (): Usage => ({ tokens: 0, ms: 0, dollars: 0, unpriced: 0 });

/** A ticket as the board shows it. */
export interface TicketCard extends Ticket {
  column: TicketColumn;
  live: TicketLive | null;
  runs: TicketRun[];
  bounceHistory: Bounce[];
  usage: Usage;
}

/** One version of the spec, in brief. */
export interface SpecVersionInfo {
  version: number;
  status: SpecStatus;
  ticketId: string | null;
  stories: number;
  updatedAt: Date;
  approvedAt: Date | null;
}

/** Something on the board waiting on the user. */
export interface NeedsYouItem {
  ticketId: string;
  key: string;
  kind: 'ready' | 'question' | 'approval' | 'paused' | 'failed' | 'looping' | 'proposal';
  /** The project it's in, for Home. */
  projectId: string;
  text: string;
  /** The run to answer in, when there is one. */
  conversationId: string | null;
  at: Date;
}

export const ticketIdSchema = z.uuid();

/** `SURF-12`, or `surf-12`. */
export const ticketKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9]{1,5}-\d{1,6}$/, 'Use a ticket key such as SURF-12');

const criteriaInputSchema = z.array(z.string().trim().min(1).max(2000)).max(50);

/** A card the user adds on the board. */
export const newTicketSchema = z.object({
  projectId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  type: outputTypeSchema,
  description: z.string().trim().max(20_000).default(''),
  criteria: criteriaInputSchema.default([]),
  stories: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  /** Null leaves it open. */
  assignee: clankIdSchema.nullable(),
});

export type NewTicket = z.infer<typeof newTicketSchema>;

export const ticketPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(20_000),
    criteria: criteriaInputSchema,
    stories: z.array(z.string().trim().min(1).max(200)).max(30),
  })
  .partial();

export type TicketPatch = z.infer<typeof ticketPatchSchema>;

/** A criterion as written, `AC-4.2: Given …`, or plain words. */
/**
 * A list item a clank wrote as an object, as a line a person reads: a criterion with its verdict
 * and the evidence for it, a frame with what it shows, anything else field by field. Hand-ins
 * hold these as the clank wrote them, and both the user and the next clank read them.
 */
export function itemText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return JSON.stringify(item);
  const record = item as Record<string, unknown>;
  const text = (key: string) => {
    const value = record[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  const verdict =
    text('status') || (typeof record.met === 'boolean' ? (record.met ? 'met' : 'not met') : '');
  if (verdict) {
    const what = text('text') || text('criterion') || text('id');
    const evidence = text('evidence') || text('note') || text('notes');
    const first = what
      ? `${what.replace(/[.:]$/, '')}: ${verdict}`
      : `${verdict.charAt(0).toUpperCase()}${verdict.slice(1)}`;
    return evidence ? `${first}. ${evidence}` : first;
  }
  if (text('name')) {
    const says = text('shows') || text('description') || text('note');
    return says ? `${text('name')}: ${says}` : text('name');
  }
  return Object.entries(record)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('; ');
}

export function parseCriterion(text: string): Criterion {
  const match = /^\s*(?:\*\*)?(AC-\d+\.\d+)(?:\*\*)?\s*[:.\-–—]?\s*(.*)$/i.exec(text);
  return match
    ? { id: match[1]!.toUpperCase(), text: match[2]!.trim() || text.trim() }
    : { id: null, text: text.trim() };
}

/** A criterion as the clanks read and write it. */
export function criterionText(criterion: Criterion): string {
  return criterion.id ? `${criterion.id}: ${criterion.text}` : criterion.text;
}
