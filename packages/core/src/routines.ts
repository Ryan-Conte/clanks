import { z } from 'zod';
import type { TicketColumn, TicketState, Usage } from './board';
import { clankIdSchema, outputTypeSchema } from './crew';
import {
  type ConnectionMode,
  type OperationRisk,
  integrationIdSchema,
  operationIdSchema,
} from './integrations';
import { budgetSchema } from './projects';

/**
 * Routines: work that starts at a time, on a schedule or when something happens, and actions that
 * go out at an exact time once the user has approved them. The spec is in docs/ROUTINES.md.
 */

/** What can start a routine besides the clock and the user. */
export const ROUTINE_EVENTS = [
  'spec.approved',
  'ticket.done',
  'pr.merged',
  'git.tag',
  'routine.finished',
] as const;

export type RoutineEventName = (typeof ROUTINE_EVENTS)[number];

/** What each event is, in words, and the filters it takes. */
export const ROUTINE_EVENT_INFO: Record<
  RoutineEventName,
  { when: string; filters: { id: string; label: string; hint: string }[] }
> = {
  'spec.approved': { when: 'You approve a spec version', filters: [] },
  'ticket.done': {
    when: 'A ticket reaches Done',
    filters: [
      { id: 'type', label: 'Type', hint: 'pr, design, copy…' },
      { id: 'clank', label: 'Clank', hint: 'forge' },
    ],
  },
  'pr.merged': {
    when: "One of the crew's pull requests is merged",
    filters: [{ id: 'base', label: 'Base branch', hint: 'main' }],
  },
  'git.tag': {
    when: "A new tag appears in the project's repository",
    filters: [{ id: 'pattern', label: 'Pattern', hint: 'v*' }],
  },
  'routine.finished': {
    when: "Another routine's run finishes",
    filters: [
      { id: 'routine', label: 'Routine', hint: 'Its name' },
      { id: 'status', label: 'Status', hint: 'done, failed or missed' },
    ],
  },
};

/** Something that happened in a project, as routines' event triggers see it. */
export interface RoutineEvent {
  name: RoutineEventName;
  /** What steps read as `{{event.*}}`, such as `tag`. */
  detail: Record<string, string>;
}

/** A length of time as routines write it: `30m`, `1h`, `2d`. */
export const durationSchema = z
  .string()
  .trim()
  .regex(/^\d{1,4}\s?(m|h|d)$/, 'Use a length of time such as 30m, 1h or 2d');

/** A duration in milliseconds. Zero for one that doesn't parse. */
export function durationMs(text: string): number {
  const match = /^(\d{1,4})\s?(m|h|d)$/.exec(text.trim());
  if (!match) return 0;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'];
  return Number(match[1]) * unit;
}

/** A duration in words: `30 minutes`, `1 hour`. */
export function durationWords(text: string): string {
  const match = /^(\d{1,4})\s?(m|h|d)$/.exec(text.trim());
  if (!match) return text;
  const n = Number(match[1]);
  const unit = { m: 'minute', h: 'hour', d: 'day' }[match[2] as 'm' | 'h' | 'd'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** A step's id: what `depends_on` and `{{steps.<id>.…}}` name it by. */
export const stepIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,23}$/, 'Use lowercase letters, digits and "_", starting with a letter');

/**
 * When an action goes out, or a ticket is due: a time on the run's date (`17:00`), an offset from
 * the run's start (`+4h`), or a date and time (`2026-11-14T17:00`), all in the routine's time zone.
 */
export const atSchema = z
  .string()
  .trim()
  .regex(
    /^(([01]?\d|2[0-3]):[0-5]\d|\+\d{1,4}\s?(m|h|d)|\d{4}-\d{2}-\d{2}[T ]([01]\d|2[0-3]):[0-5]\d)$/,
    'Use a time such as 17:00, an offset such as +4h, or a date and time such as 2026-11-14T17:00',
  );

const localDateTime = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}[T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/,
    'Use a date and time such as 2026-11-14T13:00',
  );

export const routineTriggerSchema = z.discriminatedUnion('kind', [
  /** One run, at a date and time in the routine's zone. */
  z.object({ kind: z.literal('once'), at: localDateTime }),
  /** Five-field cron, with `L` for last and `#` for the nth weekday. */
  z.object({ kind: z.literal('cron'), cron: z.string().trim().min(9).max(120) }),
  z.object({
    kind: z.literal('event'),
    event: z.enum(ROUTINE_EVENTS),
    filters: z.record(z.string().regex(/^[a-z_]{1,20}$/), z.string().trim().max(200)).default({}),
  }),
  /** Only from Run now. */
  z.object({ kind: z.literal('manual') }),
]);

export type RoutineTrigger = z.infer<typeof routineTriggerSchema>;

/** A step that creates a ticket for a clank, which goes through the normal workflow. */
export const ticketStepSchema = z.object({
  /** Who makes it: a clank in the project's crew. */
  clank: clankIdSchema,
  type: outputTypeSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(''),
  criteria: z.array(z.string().trim().min(1).max(2000)).max(50).default([]),
  /** Overrides the due time worked out from the actions that depend on it. */
  due: atSchema.optional(),
});

export type TicketStep = z.infer<typeof ticketStepSchema>;

/** How an approved action reaches its service: called at its time, or handed over to be sent then. */
export const deliverySchema = z.enum(['at_time', 'hand_off']);

export type ActionDelivery = z.infer<typeof deliverySchema>;

/** A step that calls an integration at a set time, with a payload built from earlier steps. */
export const actionStepSchema = z.object({
  integration: integrationIdSchema,
  operation: operationIdSchema,
  /** The connected account's label. Empty uses the one the project has for the integration. */
  connection: z.string().trim().max(60).default(''),
  at: atSchema,
  /** The operation's arguments, as templates over earlier steps' approved outputs. */
  payload: z.record(z.string().max(60), z.unknown()).default({}),
  deliver: deliverySchema.default('at_time'),
});

export type ActionStep = z.infer<typeof actionStepSchema>;

export const routineStepSchema = z
  .object({
    id: stepIdSchema,
    dependsOn: z.array(stepIdSchema).max(20).default([]),
    ticket: ticketStepSchema.optional(),
    action: actionStepSchema.optional(),
  })
  .refine((step) => !step.ticket !== !step.action, {
    message: 'Give each step a ticket or an action, not both',
  });

export type RoutineStep = z.infer<typeof routineStepSchema>;

/** What happens to a run or an action that came due while the app wasn't running. */
export const missedPolicySchema = z.enum(['skip', 'run_late', 'ask']);

export type MissedPolicy = z.infer<typeof missedPolicySchema>;

/** What happens when a run comes due while the one before it is still going. */
export const concurrencySchema = z.enum(['skip', 'queue', 'parallel']);

export type RoutineConcurrency = z.infer<typeof concurrencySchema>;

const inputName = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, 'Use a name such as offer');

/** A routine as it's written: what the editor edits, YAML holds and the marketplace shares. */
export const routineDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).default(''),
  trigger: routineTriggerSchema,
  /** An IANA zone, such as `Australia/Sydney`. Empty uses the user's. */
  timeZone: z.string().trim().max(64).default(''),
  /** Values steps read as `{{inputs.<name>}}`, with their defaults. */
  inputs: z.record(inputName, z.string().max(2000)).default({}),
  steps: z.array(routineStepSchema).min(1).max(20),
  approval: z
    .object({
      /** A reminder this long before the first action, if the run still waits for approval. */
      remindBefore: durationSchema.default('30m'),
    })
    .default({ remindBefore: '30m' }),
  timing: z
    .object({
      /** Ticket steps are due this long before the first action that needs them. */
      reviewBuffer: durationSchema.default('1h'),
    })
    .default({ reviewBuffer: '1h' }),
  missed: z
    .object({
      /** Null picks by what the routine does: `skip` with actions, `run_late` without. */
      policy: missedPolicySchema.nullable().default(null),
      /** How long after its time a run still starts, and an action still goes out. */
      grace: durationSchema.default('15m'),
    })
    .default({ policy: null, grace: '15m' }),
  concurrency: concurrencySchema.default('skip'),
  budget: z
    .object({
      perRun: budgetSchema.nullable().default(null),
      perMonth: budgetSchema.nullable().default(null),
    })
    .default({ perRun: null, perMonth: null }),
});

export type RoutineDefinition = z.infer<typeof routineDefinitionSchema>;

/** A definition as a form or a clank gives it, before its defaults are filled in. */
export type RoutineDefinitionInput = z.input<typeof routineDefinitionSchema>;

/** The policy a routine follows for what it missed: its own, or the default for what it does. */
export function missedPolicyOf(definition: RoutineDefinition): MissedPolicy {
  if (definition.missed.policy) return definition.missed.policy;
  return definition.steps.some((step) => step.action) ? 'skip' : 'run_late';
}

export type RoutineStatus = 'draft' | 'active' | 'paused' | 'done';

/** A saved routine. It belongs to a project. */
export interface Routine {
  id: string;
  projectId: string;
  definition: RoutineDefinition;
  status: RoutineStatus;
  /** `user`, or the clank that drafted it. */
  createdBy: string;
  /** The chat it was proposed in, whose card activates it. */
  conversationId: string | null;
  /** Why it's paused, when the app paused it: three failed runs, or a spent budget. */
  pausedReason: string | null;
  /** Runs that failed in a row. Three pause it. */
  failures: number;
  /** The marketplace template it was made from. */
  template: string | null;
  /** A clank's proposed change to another routine, which takes its place when activated. */
  replaces: string | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RoutineRunStatus =
  | 'scheduled'
  | 'working'
  | 'awaiting_approval'
  | 'approved'
  | 'done'
  | 'skipped'
  | 'missed'
  | 'failed'
  | 'cancelled';

/** The statuses a run has while it's still going. */
export const ACTIVE_RUN_STATUSES: readonly RoutineRunStatus[] = [
  'scheduled',
  'working',
  'awaiting_approval',
  'approved',
];

/** What started a run. */
export type RunTrigger =
  | { kind: 'time' }
  | { kind: 'manual' }
  /** Started late, for runs that came due while the app wasn't running. */
  | { kind: 'late'; missed: number }
  | { kind: 'event'; event: RoutineEvent };

/** One execution of a routine, for one scheduled time or one event. */
export interface RoutineRun {
  id: string;
  routineId: string;
  projectId: string;
  /** The time it was for. For an event or Run now, when that happened. */
  scheduledFor: Date;
  trigger: RunTrigger;
  /** The inputs it ran with. */
  inputs: Record<string, string>;
  status: RoutineRunStatus;
  /** Why it was skipped, missed or failed. */
  reason: string | null;
  /** A missed run the user is asked about: run it now, or skip it. */
  asks: boolean;
  /** The ticket each ticket step made, by step. */
  ticketIds: Record<string, string>;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

export type ScheduledActionStatus =
  | 'pending_approval'
  | 'approved'
  | 'executing'
  | 'done'
  | 'failed'
  | 'unknown'
  | 'missed'
  | 'cancelled';

/** A file an action sends, such as a banner, kept with it and checked by its sha256. */
export interface ActionMedia {
  sha256: string;
  /** What it is: `Promo / X.png`. */
  name: string;
  mediaType: string;
  size: number;
  /** Relative to the artifacts folder. */
  path: string;
}

/** What a service said when an action went out. */
export interface ActionResult {
  /** A link to what was made, such as the post, when the service gives one. */
  url: string | null;
  /** Its id at the service. */
  id: string | null;
  /** The service's answer, cut down. */
  summary: string;
  /** Handed over for the service to send at its time, rather than sent. */
  handedOff: boolean;
}

/**
 * An action waiting for its time: once approved, the exact payload, files, account and time are
 * frozen, and the orchestrator carries it out with no model involved.
 */
export interface ScheduledAction {
  id: string;
  projectId: string;
  /** The routine run it's a step of. Null for a campaign's post. */
  runId: string | null;
  /** The campaign ticket it's a post of. Null for a routine's action. */
  ticketId: string | null;
  /** Its step in the routine, or `post-<n>` for a campaign's. */
  stepId: string;
  integrationId: string;
  operationId: string;
  /** Null until the project has an account for the integration. */
  connectionId: string | null;
  /**
   * The operation's arguments. A file is `{ "$media": "<sha256>" }`, sent as its bytes in base64.
   * Null until the steps it's built from are signed off.
   */
  payload: Record<string, unknown> | null;
  media: ActionMedia[];
  /** The hash of what was approved. Anything that differs at its time stops it going out. */
  payloadHash: string | null;
  executeAt: Date;
  graceMs: number;
  delivery: ActionDelivery;
  status: ScheduledActionStatus;
  approvedAt: Date | null;
  attempts: number;
  result: ActionResult | null;
  /** Why it failed, was missed or can't be built yet. */
  error: string | null;
  /** The clank whose work it sends, which is told how it went. */
  madeBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An action as the app shows it: with its service, its account, and what will go out. */
export interface ScheduledActionInfo extends ScheduledAction {
  routineId: string | null;
  /** The routine's name, or the campaign ticket's key and title. */
  source: string;
  integrationName: string;
  /** What the operation does, in a line. */
  operationSummary: string;
  /** The account it goes out from. */
  connectionLabel: string | null;
  mode: ConnectionMode | null;
  risk: OperationRisk | null;
  /** The words it sends, when its payload has some. */
  text: string | null;
  /** The rest of its payload, as lines. */
  fields: { name: string; value: string }[];
  /** It can be handed to the service to send at its time. */
  canHandOff: boolean;
  /** Why it can't go out as it is, such as no account connected. */
  problems: string[];
}

/** A ticket a run made, as its card shows it. */
export interface RunTicketInfo {
  stepId: string;
  ticketId: string;
  key: string;
  title: string;
  clankId: string | null;
  column: TicketColumn;
  state: TicketState;
  dueAt: string | null;
}

export interface RoutineRunInfo extends RoutineRun {
  routineName: string;
  tickets: RunTicketInfo[];
  actions: ScheduledActionInfo[];
  usage: Usage;
}

/** A step with the times worked out for the next run. */
export interface StepTiming {
  stepId: string;
  /** For an action: when it goes out. For a ticket: when it's due. Null when it has neither. */
  at: Date | null;
  /** Why it's due then: "an hour before the 17:00 post". */
  why: string | null;
}

/** A routine as the Routines tab shows it. */
export interface RoutineInfo extends Routine {
  /** Its trigger in words: "Fridays at 13:00 (Australia/Sydney)". */
  triggerText: string;
  /** The zone its times are in: its own, or the user's. */
  zone: string;
  /** The next five times it runs. */
  nextRuns: Date[];
  /** The next run's steps, with when each is due or goes out. */
  timings: StepTiming[];
  /** What stops it being activated. */
  problems: string[];
  /** Things worth a look that don't stop it. */
  warnings: string[];
  /** The policy it follows for what it missed. */
  missedPolicy: MissedPolicy;
  lastRun: { status: RoutineRunStatus; at: Date; reason: string | null } | null;
  /** What it has spent this month. */
  monthUsage: Usage;
}

/** Something in a project's routines that waits on the user. */
export interface RoutineNeed {
  kind: 'approve' | 'missed' | 'unknown' | 'failed' | 'draft';
  projectId: string;
  routineId: string | null;
  runId: string | null;
  actionId: string | null;
  text: string;
  at: Date;
}

/** A run or an action coming up, for the Schedule view, Home and the tray. */
export interface ComingUp {
  kind: 'run' | 'action';
  projectId: string;
  routineId: string | null;
  runId: string | null;
  actionId: string | null;
  at: Date;
  /** "Weekend promo", or "Post to X as @surfshop". */
  title: string;
  /** For an action: whether it's approved yet. */
  status: ScheduledActionStatus | null;
}

/** A routine template installed from a marketplace, to start a routine from. */
export interface RoutineTemplate {
  /** The package's id. */
  id: string;
  name: string;
  summary: string;
  version: string;
  definition: RoutineDefinition;
}

/** Everything a project's Routines tab and Schedule view show. */
export interface RoutinesSnapshot {
  routines: RoutineInfo[];
  /** The newest first. */
  runs: RoutineRunInfo[];
  /** Actions waiting for their time, and the latest that went out or didn't. */
  actions: ScheduledActionInfo[];
  needs: RoutineNeed[];
  coming: ComingUp[];
  templates: RoutineTemplate[];
  /** The user's own time zone, which new routines start in. */
  zone: string;
  /** Every routine is paused, from the tray or Settings. */
  paused: boolean;
}

/** Routines across every project, for Home and the tray. */
export interface RoutinesOverview {
  needs: (RoutineNeed & { projectName: string })[];
  coming: (ComingUp & { projectName: string })[];
  /** Routines that are on, across every project. */
  active: number;
  paused: boolean;
}

/** A routine being edited, checked against its project before it's saved. */
export interface DraftCheck {
  /** Its trigger in words. Empty when it can't be read. */
  triggerText: string;
  zone: string;
  nextRuns: Date[];
  timings: StepTiming[];
  problems: string[];
  warnings: string[];
}

/** What a schedule typed in words came to, before anything is saved. */
export interface SchedulePreview {
  trigger: RoutineTrigger | null;
  /** The trigger in words. */
  text: string;
  nextRuns: Date[];
  /** Why it couldn't be read. */
  problem: string | null;
  /** Atlas read it, rather than the app. */
  byModel: boolean;
}

/** A campaign's post as it would be scheduled: what was found for it, and what's missing. */
export interface CampaignPostPlan {
  index: number;
  channel: string;
  account: string | null;
  text: string;
  /** The time it names, as an instant. Null when it names none that can be read. */
  at: Date | null;
  /** The frame that goes with it, when it names one that exists. */
  visual: string | null;
  integrationId: string | null;
  operationId: string | null;
  connectionLabel: string | null;
  /** Why it can't be scheduled. Empty when it can. */
  problems: string[];
}

export const routineIdSchema = z.uuid();

/** Where a routine's ticket came from, kept on the ticket for its card and its maker. */
export interface TicketRoutine {
  routineId: string;
  runId: string;
  stepId: string;
  /** The routine's name. */
  name: string;
  /** The run's date, in the routine's zone: `2026-11-14`. */
  date: string;
  inputs: Record<string, string>;
  /** When it's due, so it can be reviewed before what it's for goes out. */
  dueAt: string | null;
  /** "so it can be reviewed before the 17:00 post". */
  dueWhy: string | null;
  /** The zone its times are in. */
  zone: string;
}
