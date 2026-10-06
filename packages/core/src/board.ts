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
 * How a ticket is doing where it is: waiting its turn, being worked, waiting on the user's answer,
 * stopped part way, failed, or bounced so often it came to the user.
 */
export type TicketState = 'idle' | 'working' | 'question' | 'paused' | 'failed' | 'looping';

/** A checker's pass, as it handed it in with `review_pass`. */
export interface TicketReview extends Record<string, unknown> {
  clankId: string;
  at: string;
}

/** Where a ticket came from: a chat, a spec's planning, the board, or a clank's proposal. */
export type TicketOrigin = 'chat' | 'spec' | 'board' | 'proposal';

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

/** The clank whose turn it is, if it's a clank's. */
export function currentClank(ticket: Pick<Ticket, 'step' | 'route' | 'doneAt'>): ClankId | null {
  if (ticket.doneAt || ticket.step < 0) return null;
  return ticket.route[ticket.step]?.clankId ?? null;
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

/**
 * A ticket's route: its maker, then every checker that applies to its type, in stage order, so a
 * `pr` goes Forge → Gauge → Atlas and a `spec` goes Scribe → Atlas. The user comes after.
 */
export function routeFor(
  type: OutputType,
  maker: ClankId | null,
  crew: WorkflowMember[],
): RouteStep[] {
  const stages = orderStages(crew);
  const checkers = crew
    .map((c, i) => ({ c, i }))
    .filter(
      ({ c }) =>
        c.kind === 'checker' && (c.appliesTo.includes('all') || c.appliesTo.includes(type)),
    )
    .sort((a, b) => stages.indexOf(a.c.stage) - stages.indexOf(b.c.stage) || a.i - b.i)
    .map(({ c }) => ({ clankId: c.id, role: 'checker' as const }));
  return [{ clankId: maker, role: 'maker' }, ...checkers];
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
 * Why the board can't move a ticket to a column by a drag, or null when it can. The board never
 * moves a ticket itself; it asks, and the workflow decides.
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
  return 'The crew moves tickets through Build and QA + review as they work them.';
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
  | 'changes'
  | 'planned'
  | 'moved'
  | 'updated'
  | 'linked'
  | 'deleted';

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

/** What a clank is doing in a run: making the ticket, checking it, or planning from the spec. */
export type RunRole = 'maker' | 'checker' | 'planner';

/** What's happening on a ticket right now, for its card. */
export interface TicketLive {
  conversationId: string;
  clankId: ClankId;
  /** "Running `npm test`", "Thinking", "Waiting for gemma4:26b". */
  label: string;
  /** A tool call waits for the user's approval. */
  asking: boolean;
}

/** A ticket as the board shows it. */
export interface TicketCard extends Ticket {
  column: TicketColumn;
  live: TicketLive | null;
  runs: TicketRun[];
  bounceHistory: Bounce[];
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
