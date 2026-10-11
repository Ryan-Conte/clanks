import {
  ACTIVE_RUN_STATUSES,
  type CampaignPostPlan,
  type ComingUp,
  type DraftCheck,
  type MissedPolicy,
  type Routine,
  type RoutineDefinition,
  type RoutineEvent,
  type RoutineInfo,
  type RoutineNeed,
  type RoutineRunInfo,
  type RoutineRunStatus,
  type RoutineTemplate,
  type RoutinesOverview,
  type RoutinesSnapshot,
  type RunTicketInfo,
  type RunTrigger,
  type SchedulePreview,
  type ScheduledActionInfo,
  type Ticket,
  type TicketRoutine,
  type Usage,
  budgetReached,
  columnOf,
  durationMs,
  emptyUsage,
  missedPolicyOf,
  postsOf,
} from '@clanks/core';
import {
  CronError,
  RoutineFormatError,
  actionDue,
  checkDefinition,
  dateIn,
  fillTemplates,
  foundIn,
  frozenText,
  isMediaMarker,
  isTimeZone,
  isTransientStatus,
  localZone,
  mediaIn,
  nextRun,
  nextRuns,
  onceInstant,
  parseCron,
  parseSchedule,
  readDefinition,
  retryDelay,
  routineFromYaml,
  routineToYaml,
  runsBetween,
  stepTimes,
  timeIn,
  triggerWords,
  whenText,
  withMedia,
} from '@clanks/routines';
import { type RoutineAccess, ToolFailure } from '@clanks/tools';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardService } from '../board/service';
import { designedFrames } from '../board/text';
import type { ContextService } from '../context/service';
import type { CrewService } from '../crew/crew';
import { IntegrationError, type IntegrationService } from '../integrations/service';
import type { ProjectService } from '../projects/service';
import type { SettingsService } from '../settings';
import type { Db } from '../store/store';
import { RoutineStore, type StoredAction, type StoredRun } from './store';
import { routineDetail, routineLine } from './text';

/** A routine problem worded for the user, or for the clank whose tool call caused it. */
export class RoutineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutineError';
  }
}

/** Something about a routine the user should hear of, even with the window closed. */
export interface RoutineNotice {
  kind: 'ready' | 'reminder' | 'missed' | 'failed' | 'unknown' | 'paused';
  title: string;
  body: string;
  projectId: string;
  routineId: string | null;
  runId: string | null;
  actionId: string | null;
}

export interface RoutineServiceOptions {
  db: Db;
  projects: ProjectService;
  crew: CrewService;
  board: BoardService;
  integrations: IntegrationService;
  context: ContextService;
  settings: SettingsService;
  /** Where files that actions send are kept, each named by its sha256. */
  artifactsDir: string;
  /**
   * Draws a frame of a project's design as a PNG, as it will be sent: from the design a ticket's
   * maker handed in when there is one, else from the project's own. Null when it can't be found.
   */
  framePng?: (
    projectId: string,
    frame: string,
    ticket: Ticket | null,
  ) => Promise<Uint8Array | null>;
  /** The tags in a project's repository, for routines that start on a new one. */
  tags?: (folder: string) => Promise<string[]>;
  /**
   * Has Atlas read a schedule the app's own reader doesn't know. Resolves with a cron expression
   * or a date and time, or null when it can't say.
   */
  readSchedule?: (words: string, zone: string, now: Date) => Promise<string | null>;
  /** Routine templates installed from a marketplace. */
  templates?: () => RoutineTemplate[];
  now?: () => Date;
}

/** The most missed runs recorded one by one for a routine that skips them. */
const MISSED_RECORDED = 10;
/** Runs that fail in a row before a routine is paused. */
const FAILURES_PAUSED = 3;
/** The longest the scheduler sleeps, so a changed clock or a wake from sleep is noticed. */
const MAX_SLEEP_MS = 30_000;
/** How often projects' repositories are looked at for new tags. */
const TAG_POLL_MS = 2 * 60_000;
/** How long a call to a service may take before it counts as unanswered. */
const CALL_TIMEOUT_MS = 2 * 60_000;
const GOING: readonly RoutineRunStatus[] = ['working', 'awaiting_approval', 'approved'];
/** Stands in for a file while a payload is checked against its operation, which takes text. */
const MEDIA_SENTINEL = '\u0000media:';

interface FrameRequest {
  $frame: { ticketId: string; name: string };
}

const isFrameRequest = (value: unknown): value is FrameRequest =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as FrameRequest).$frame === 'object' &&
  (value as FrameRequest).$frame !== null;

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

function short(text: string, max = 120): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function glob(pattern: string, value: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 'i').test(value);
}

/**
 * Routines: work that starts at a time, on a schedule or when something happens, and actions that
 * go out at an exact time once the user has approved them. A run's tickets go through the board
 * like any others. Its actions are frozen when approved and carried out here, by the orchestrator
 * and never by a model, exactly once and only inside their window. Emits `change` with a
 * project's id when its routines change, and `notice` for what the user should be told.
 */
export class RoutineService extends EventEmitter<{
  change: [projectId: string];
  notice: [notice: RoutineNotice];
}> {
  private readonly store: RoutineStore;
  private timer: NodeJS.Timeout | null = null;
  private tagTimer: NodeJS.Timeout | null = null;
  private started = false;
  private closed = false;
  /** Work that reads or changes runs, one piece at a time, so two never act on the same run. */
  private queue: Promise<void> = Promise.resolve();
  /** Projects whose runs should be looked at again once the current work is done. */
  private readonly stale = new Set<string>();

  constructor(private readonly options: RoutineServiceOptions) {
    super();
    this.setMaxListeners(100);
    this.store = new RoutineStore(options.db);
    options.board.on('change', (projectId) => this.touch(projectId));
    options.board.on('happened', (projectId, event) => this.fire(projectId, event));
    options.board.gateRoutines((ticket) => this.gate(ticket));
    let paused = options.settings.get().routinesPaused;
    options.settings.on('change', (settings) => {
      if (paused && !settings.routinesPaused) this.resumeAll();
      if (paused !== settings.routinesPaused) {
        paused = settings.routinesPaused;
        for (const project of options.projects.list()) this.emit('change', project.id);
        this.wake();
      }
    });
  }

  // The clock

  /** Starts the scheduler: what came due while the app was off is dealt with first. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.enqueue(() => this.recover())
      .catch(logged)
      .then(() => this.tick());
    this.tagTimer = setInterval(() => void this.pollTags(), TAG_POLL_MS);
    this.tagTimer.unref();
    void this.pollTags();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.tagTimer) clearInterval(this.tagTimer);
  }

  /** The computer woke up, or its clock changed: look at everything again now. */
  resume(): void {
    void this.tick();
  }

  /** Settles once everything queued so far has been done. Tests wait on it. */
  idle(): Promise<void> {
    return this.queue.then(() => (this.stale.size > 0 ? this.idle() : undefined));
  }

  /** Does everything whose time has come. Runs after whatever is already under way. */
  tick(): Promise<void> {
    return this.enqueue(() => this.tickOnce())
      .catch(logged)
      .then(() => this.wake());
  }

  /** Runs a piece of work after whatever is under way. What it throws goes to whoever asked. */
  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Sleeps until the next thing comes due, or not for long, so a wake from sleep is noticed. */
  private wake(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.started || this.closed) return;
    const due = this.nextDue();
    const now = +this.now();
    const delay = due === null ? MAX_SLEEP_MS : Math.min(MAX_SLEEP_MS, Math.max(50, due - now));
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref();
  }

  /** The next instant something has to happen: a run, an action, a retry, or a window closing. */
  private nextDue(): number | null {
    const times: number[] = [];
    if (!this.paused()) {
      for (const routine of this.store.routines()) {
        if (routine.status === 'active' && routine.nextRunAt) times.push(+routine.nextRunAt);
      }
    }
    for (const action of this.store.actionsWith(['approved', 'pending_approval'])) {
      if (action.status !== 'approved') times.push(+action.executeAt);
      else if (action.retryAt) times.push(+action.retryAt);
      else times.push(action.delivery === 'hand_off' ? +this.now() : +action.executeAt);
    }
    return times.length > 0 ? Math.min(...times) : null;
  }

  /**
   * When the app should next be running: its next run or action. The OS task that starts the app
   * points here. Null when nothing is coming.
   */
  nextWake(): Date | null {
    const due = this.nextDue();
    return due === null ? null : new Date(Math.max(due, +this.now()));
  }

  /** Whether anything is working or about to go out, so the computer should stay awake. */
  busy(): boolean {
    const now = +this.now();
    if (this.store.runsWith(['working']).length > 0) return true;
    return this.store
      .actionsWith(['approved', 'executing'])
      .some(
        (a) =>
          a.status === 'executing' ||
          (+a.executeAt - 5 * 60_000 <= now && now <= +a.executeAt + a.graceMs),
      );
  }

  private async tickOnce(): Promise<void> {
    const now = this.now();
    const paused = this.paused();
    const touched = new Set<string>();

    if (!paused) {
      for (const routine of this.store.routines()) {
        if (routine.status !== 'active' || !routine.nextRunAt || +routine.nextRunAt > +now)
          continue;
        this.comeDue(routine, now);
        touched.add(routine.projectId);
      }
      // Runs that waited for the one before them, or were planned ahead with inputs of their own.
      for (const run of this.store.runsWith(['scheduled'])) {
        if (+run.scheduledFor > +now) continue;
        const routine = this.store.routine(run.routineId);
        if (!routine || routine.status !== 'active') continue;
        // One planned ahead whose time went by unnoticed isn't started late on the quiet.
        const late = +now - +run.scheduledFor > durationMs(routine.definition.missed.grace);
        if (run.trigger.kind === 'time' && !run.reason && late) {
          this.store.updateRun(run.id, {
            status: 'missed',
            reason: "clanks wasn't running, or this computer was asleep, when it came due.",
            endedAt: now,
          });
          touched.add(run.projectId);
          continue;
        }
        if (this.going(routine.id, run.id).length > 0) continue;
        this.launch(routine, run.scheduledFor, run.trigger, run.inputs, run);
        touched.add(run.projectId);
      }
    }

    // Never approved by its time: it's missed, and never goes out.
    for (const action of this.store.actionsWith(['pending_approval'])) {
      if (+action.executeAt > +now) continue;
      this.miss(action, "It wasn't approved by its time, so it wasn't sent.");
      touched.add(action.projectId);
    }

    for (const action of this.store.actionsWith(['approved'])) {
      if (action.retryAt && +action.retryAt > +now) continue;
      // One handed over goes to its service as soon as it's approved, to be sent at its time.
      const handOff = action.delivery === 'hand_off';
      if (!handOff && +action.executeAt > +now) continue;
      touched.add(action.projectId);
      const late = handOff
        ? +now >= +action.executeAt
        : actionDue({ executeAt: +action.executeAt, graceMs: action.graceMs }, +now) === 'late';
      if (late) {
        this.miss(
          action,
          action.attempts > 0
            ? `It kept failing until its time had passed: ${action.error ?? 'no answer'}`
            : "clanks wasn't running, or this computer was asleep, at its time. It wasn't sent late.",
        );
        continue;
      }
      if (paused) continue;
      await this.send(action);
    }

    // A reminder before the first action of a run that still waits for approval.
    for (const run of this.store.runsWith(['awaiting_approval'])) {
      if (run.reminded) continue;
      const routine = this.store.routine(run.routineId);
      const pending = this.store.actionsOf(run.id).filter((a) => a.status === 'pending_approval');
      if (!routine || pending.length === 0) continue;
      const first = Math.min(...pending.map((a) => +a.executeAt));
      const before = durationMs(routine.definition.approval.remindBefore);
      if (+now < first - before || +now >= first) continue;
      this.store.updateRun(run.id, { reminded: true });
      this.notify({
        kind: 'reminder',
        title: `${routine.definition.name} still needs your approval`,
        body: `${this.count(pending.length, 'action')} ${pending.length === 1 ? 'goes' : 'go'} out ${whenText(first, this.zoneOf(routine.definition), now)}. Nothing is sent until you approve it.`,
        projectId: run.projectId,
        routineId: routine.id,
        runId: run.id,
        actionId: null,
      });
    }

    for (const run of this.store.runsWith(['approved'])) {
      if (this.settle(run)) touched.add(run.projectId);
    }
    for (const projectId of touched) this.emit('change', projectId);
  }

  /** Whatever was mid-call when the app stopped has an unknown outcome: find out, or ask. */
  private async recover(): Promise<void> {
    for (const action of this.store.actionsWith(['executing'])) {
      await this.resolveUnknown(action);
      this.emit('change', action.projectId);
    }
  }

  // Reading

  /** Everything a project's Routines tab and Schedule view show. */
  snapshot(projectId: string): RoutinesSnapshot {
    this.options.projects.get(projectId);
    const now = this.now();
    const tickets = this.options.board.tickets(projectId);
    const usage = this.options.board.ticketUsage(projectId);
    const routines = this.store.routines(projectId);
    const runs = this.store.runs(projectId, 60);
    const infos = routines.map((routine) => this.info(routine, now, usage));
    const names = new Map(routines.map((r) => [r.id, r.definition.name]));
    const runInfos = runs.map((run) => this.runInfo(run, names, tickets, usage));
    const open = this.store.actionsWith(
      ['pending_approval', 'approved', 'executing', 'unknown'],
      projectId,
    );
    const actions = [...open, ...this.store.pastActions(projectId, 40)].map((action) =>
      this.actionInfo(action, names, tickets),
    );
    return {
      routines: infos,
      runs: runInfos,
      actions,
      needs: this.needs(projectId, routines, runs, actions),
      coming: this.coming(projectId, infos, actions, now),
      templates: this.options.templates?.() ?? [],
      zone: this.userZone(),
      paused: this.paused(),
    };
  }

  /** Routines across every project, for Home and the tray. */
  overview(): RoutinesOverview {
    const needs: RoutinesOverview['needs'] = [];
    const coming: RoutinesOverview['coming'] = [];
    let active = 0;
    for (const project of this.options.projects.list()) {
      const snapshot = this.snapshot(project.id);
      active += snapshot.routines.filter((r) => r.status === 'active').length;
      needs.push(...snapshot.needs.map((n) => ({ ...n, projectName: project.name })));
      coming.push(...snapshot.coming.map((c) => ({ ...c, projectName: project.name })));
    }
    return {
      needs: needs.sort((a, b) => +a.at - +b.at),
      coming: coming.sort((a, b) => +a.at - +b.at).slice(0, 30),
      active,
      paused: this.paused(),
    };
  }

  routine(id: string): Routine {
    const found = this.store.routine(id);
    if (!found) throw new RoutineError('That routine was deleted');
    return found;
  }

  /** A file an action sends, as a `data:` address, for its card to show. */
  media(actionId: string, hash: string): { url: string; name: string } | null {
    const action = this.store.action(actionId);
    const file = action?.media.find((m) => m.sha256 === hash);
    if (!file) return null;
    const path = join(this.options.artifactsDir, file.path);
    if (!existsSync(path)) return null;
    return {
      url: `data:${file.mediaType};base64,${readFileSync(path).toString('base64')}`,
      name: file.name,
    };
  }

  /** A schedule typed in words, read back before anything is saved. */
  async previewSchedule(words: string, zone: string): Promise<SchedulePreview> {
    const now = this.now();
    const where = isTimeZone(zone) ? zone : this.userZone();
    let trigger = parseSchedule(words, { now, zone: where });
    let byModel = false;
    if (!trigger && words.trim() && this.options.readSchedule) {
      const said = await this.options.readSchedule(words, where, now).catch(() => null);
      trigger = said ? parseSchedule(said, { now, zone: where }) : null;
      byModel = trigger !== null;
    }
    if (!trigger) {
      return {
        trigger: null,
        text: '',
        nextRuns: [],
        problem: words.trim()
          ? 'That schedule isn\'t one clanks can read. Try "every weekday at 9", "first Monday of the month" or "tomorrow at 5pm", or a cron expression.'
          : null,
        byModel: false,
      };
    }
    return {
      trigger,
      text: triggerWords(trigger, where, now),
      nextRuns: this.upcoming(trigger, where, now, 5),
      problem: null,
      byModel,
    };
  }

  /** A routine as the editor has it, checked against its project: nothing is saved. */
  checkDraft(projectId: string, definition: unknown): DraftCheck {
    this.options.projects.get(projectId);
    const now = this.now();
    let read: RoutineDefinition;
    try {
      read = readDefinition(definition, { now, zone: this.userZone() });
    } catch (error) {
      if (!(error instanceof RoutineFormatError)) throw error;
      return {
        triggerText: '',
        zone: this.userZone(),
        nextRuns: [],
        timings: [],
        // One line each: what's wrong, and where.
        problems: error.message.split(/\n(?=✖)/).map((block) =>
          block
            .replace(/^✖\s*/, '')
            .replace(/\n\s*→ at (\S+)\s*$/, ' (in $1)')
            .trim(),
        ),
        warnings: [],
      };
    }
    const zone = this.zoneOf(read);
    const upcoming = this.upcoming(read.trigger, zone, now, 5);
    const start = upcoming[0] ?? now;
    const { problems, warnings } = this.check(projectId, read, now, start);
    return {
      triggerText: isTimeZone(zone) ? triggerWords(read.trigger, zone, now) : '',
      zone,
      nextRuns: upcoming,
      timings: isTimeZone(zone)
        ? stepTimes(read, start, zone).map((t) => ({ stepId: t.stepId, at: t.at, why: t.why }))
        : [],
      problems,
      warnings,
    };
  }

  // Writing

  /** Saves a new routine as a draft. Nothing is scheduled until it's activated. */
  create(
    projectId: string,
    definition: unknown,
    by: { createdBy?: string; conversationId?: string | null; template?: string | null } = {},
  ): Routine {
    this.options.projects.get(projectId);
    const now = this.now();
    const routine: Routine = {
      id: randomUUID(),
      projectId,
      definition: this.read(definition),
      status: 'draft',
      createdBy: by.createdBy ?? 'user',
      conversationId: by.conversationId ?? null,
      pausedReason: null,
      failures: 0,
      template: by.template ?? null,
      replaces: null,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertRoutine(routine);
    this.emit('change', projectId);
    return routine;
  }

  /** Changes a routine. An active one must still be fit to run, and its times are worked out again. */
  update(id: string, definition: unknown): Routine {
    const routine = this.routine(id);
    const next = this.read(definition);
    const now = this.now();
    if (routine.status === 'active') {
      const { problems } = this.check(routine.projectId, next, now);
      if (problems.length > 0) {
        throw new RoutineError(
          `It can't run like that: ${problems.join(' ')} Fix that, or pause it first.`,
        );
      }
    }
    this.store.updateRoutine(id, {
      definition: next,
      updatedAt: now,
      ...(routine.status === 'active'
        ? { nextRunAt: this.nextFor({ ...routine, definition: next }, now) }
        : {}),
    });
    this.emit('change', routine.projectId);
    this.wake();
    return this.routine(id);
  }

  /**
   * Turns a routine on. Only the user does this, from the app. One a clank proposed as a change to
   * another takes that routine's place.
   */
  activate(id: string): Routine {
    let routine = this.routine(id);
    const now = this.now();
    const { problems } = this.check(routine.projectId, routine.definition, now);
    if (problems.length > 0)
      throw new RoutineError(`It can't be turned on yet: ${problems.join(' ')}`);
    if (routine.replaces) {
      const target = this.store.routine(routine.replaces);
      if (target) {
        this.store.updateRoutine(target.id, { definition: routine.definition, updatedAt: now });
        this.store.deleteRoutine(routine.id);
        routine = { ...target, definition: routine.definition };
      } else {
        this.store.updateRoutine(routine.id, { replaces: null });
      }
    }
    const next = this.nextFor(routine, now);
    this.store.updateRoutine(routine.id, {
      status: 'active',
      pausedReason: null,
      failures: 0,
      nextRunAt: next,
      updatedAt: now,
    });
    this.emit('change', routine.projectId);
    this.wake();
    return this.routine(routine.id);
  }

  pause(id: string): Routine {
    const routine = this.routine(id);
    this.store.updateRoutine(id, {
      status: 'paused',
      pausedReason: null,
      nextRunAt: null,
      updatedAt: this.now(),
    });
    this.emit('change', routine.projectId);
    this.wake();
    return this.routine(id);
  }

  /** Deletes a routine. Tickets its runs made stay on the board; nothing it had waiting goes out. */
  remove(id: string): void {
    const routine = this.routine(id);
    this.store.deleteRoutine(id);
    this.emit('change', routine.projectId);
    this.options.board.pumpProject(routine.projectId);
    this.wake();
  }

  duplicate(id: string): Routine {
    const routine = this.routine(id);
    return this.create(routine.projectId, {
      ...routine.definition,
      name: `${routine.definition.name} (copy)`.slice(0, 80),
    });
  }

  exportYaml(id: string): { name: string; yaml: string } {
    const { definition } = this.routine(id);
    return { name: definition.name, yaml: routineToYaml(definition) };
  }

  /** A routine from YAML, as an inactive draft. */
  importYaml(projectId: string, yaml: string): Routine {
    try {
      return this.create(
        projectId,
        routineFromYaml(yaml, { now: this.now(), zone: this.userZone() }),
      );
    } catch (error) {
      if (error instanceof RoutineFormatError) throw new RoutineError(error.message);
      throw error;
    }
  }

  /** A routine from a marketplace template, as an inactive draft to fill in. */
  fromTemplate(projectId: string, templateId: string): Routine {
    const template = this.options.templates?.().find((t) => t.id === templateId);
    if (!template) throw new RoutineError("That template isn't installed any more");
    return this.create(projectId, template.definition, { template: template.id });
  }

  /** Starts a run now, whatever the routine's trigger, with inputs changed for this run if given. */
  runNow(id: string, inputs: Record<string, string> = {}): void {
    const routine = this.routine(id);
    const { problems } = this.check(routine.projectId, routine.definition, this.now());
    if (problems.length > 0) throw new RoutineError(`It can't run yet: ${problems.join(' ')}`);
    this.begin(routine, this.free(routine.id), { kind: 'manual' }, inputs, true);
    this.emit('change', routine.projectId);
    this.wake();
  }

  /** Builds again what a run will send, after something it needed was put right. */
  async refreshRun(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (run.status !== 'awaiting_approval') return;
    await this.enqueue(async () => {
      this.store.updateRun(runId, { status: 'working' });
      await this.sync(run.projectId);
      this.emit('change', run.projectId);
    });
  }

  /** Sets the inputs one upcoming run uses, in place of the routine's defaults. */
  planRun(id: string, at: Date, inputs: Record<string, string>): void {
    const routine = this.routine(id);
    if (+at <= +this.now()) throw new RoutineError('That run has already come due');
    const existing = this.store.runAt(id, at);
    if (existing && existing.status !== 'scheduled') {
      throw new RoutineError('That run has already started');
    }
    const known = Object.keys(routine.definition.inputs);
    const given = Object.fromEntries(
      Object.entries(inputs).filter(([name]) => known.includes(name)),
    );
    if (existing) this.store.updateRun(existing.id, { inputs: given });
    else this.store.insertRun(this.newRun(routine, at, { kind: 'time' }, given, 'scheduled'));
    this.emit('change', routine.projectId);
  }

  /** A missed run the user was asked about: run it now, or let it go. */
  answerMissed(runId: string, answer: 'run' | 'skip'): void {
    const run = this.requireRun(runId);
    this.store.updateRun(runId, { asks: false });
    if (answer === 'run') {
      const routine = this.routine(run.routineId);
      this.begin(routine, this.free(routine.id), { kind: 'late', missed: 1 }, run.inputs, true);
    }
    this.emit('change', run.projectId);
    this.wake();
  }

  /** Stops a run: its tickets stop being worked, and nothing it had waiting goes out. */
  cancelRun(runId: string): void {
    const run = this.requireRun(runId);
    if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
      throw new RoutineError('That run has already ended');
    }
    this.end(run, 'cancelled', 'You stopped it.');
    this.options.board.pumpProject(run.projectId);
    this.emit('change', run.projectId);
  }

  // Approvals

  /**
   * Approves what a run will send: every action waiting, or only some. The run's tickets are
   * approved with it, since their work is what goes out. Each action is frozen as it's shown:
   * its payload, files, account and time.
   */
  async approveRun(runId: string, actionIds?: string[]): Promise<void> {
    await this.enqueue(async () => {
      const run = this.requireRun(runId);
      if (run.status !== 'awaiting_approval' && run.status !== 'approved') {
        throw new RoutineError("That run isn't waiting for your approval");
      }
      const pending = this.store
        .actionsOf(runId)
        .filter((a) => a.status === 'pending_approval')
        .filter((a) => !actionIds || actionIds.includes(a.id));
      if (pending.length === 0) throw new RoutineError('Nothing there is waiting for approval');
      for (const action of pending) this.requireSendable(action);
      // The work first: what's approved to go out is what the tickets handed in.
      const tickets = this.options.board.tickets(run.projectId);
      for (const ticketId of Object.values(run.ticketIds)) {
        const ticket = tickets.find((t) => t.id === ticketId);
        if (ticket && columnOf(ticket) === 'ready') await this.options.board.approve(ticket.id);
      }
      for (const action of pending) this.freeze(action);
      const left = this.store.actionsOf(runId).some((a) => a.status === 'pending_approval');
      if (!left) this.store.updateRun(runId, { status: 'approved' });
      this.emit('change', run.projectId);
    });
    await this.tick();
  }

  /** Approves one action that isn't part of a run waiting for approval, such as a campaign's post. */
  async approveAction(actionId: string): Promise<void> {
    const action = this.requireAction(actionId);
    if (action.runId) return this.approveRun(action.runId, [actionId]);
    if (action.status !== 'pending_approval')
      throw new RoutineError("It isn't waiting for approval");
    this.requireSendable(action);
    this.freeze(action);
    this.emit('change', action.projectId);
    await this.tick();
  }

  /**
   * Changes what an action says, or when it goes out. Either cancels its approval: it's shown
   * again and asks again.
   */
  editAction(actionId: string, patch: { text?: string; executeAt?: Date }): void {
    const action = this.requireAction(actionId);
    if (!['pending_approval', 'approved', 'missed', 'failed'].includes(action.status)) {
      throw new RoutineError("It's past changing");
    }
    if (action.result?.handedOff)
      throw new RoutineError('It was handed over already. Cancel it instead.');
    const now = this.now();
    let payload = action.payload;
    if (patch.text !== undefined) {
      const field = textField(payload);
      if (!payload || !field) throw new RoutineError('It has no words to change');
      payload = { ...payload, [field]: patch.text };
      this.fit(action, payload);
    }
    if (patch.executeAt && +patch.executeAt <= +now) {
      throw new RoutineError('Pick a time that is still to come');
    }
    this.store.updateAction(actionId, {
      payload,
      executeAt: patch.executeAt ?? action.executeAt,
      status: 'pending_approval',
      approvedAt: null,
      payloadHash: null,
      attempts: 0,
      attemptId: null,
      retryAt: null,
      error: null,
      updatedAt: now,
    });
    this.reopen(action);
    this.emit('change', action.projectId);
    this.wake();
  }

  /**
   * Sends an action now: the user's say-so for one that was missed, failed, or is still waiting.
   * It's as good as approving it for this minute.
   */
  async postNow(actionId: string): Promise<void> {
    await this.enqueue(async () => {
      const action = this.requireAction(actionId);
      if (!['pending_approval', 'approved', 'missed', 'failed'].includes(action.status)) {
        throw new RoutineError("It can't be sent from here");
      }
      this.requireSendable({ ...action, error: null });
      if (action.runId) await this.approveTickets(action.runId);
      this.store.updateAction(actionId, {
        executeAt: this.now(),
        delivery: 'at_time',
        attempts: 0,
        retryAt: null,
        error: null,
      });
      this.freeze(this.requireAction(actionId));
      this.reopen(action, 'approved');
      this.emit('change', action.projectId);
    });
    await this.tick();
  }

  /** Moves an action to another time, approved for that time: its card shows it in full first. */
  async reschedule(actionId: string, at: Date): Promise<void> {
    await this.enqueue(async () => {
      const action = this.requireAction(actionId);
      if (!['pending_approval', 'approved', 'missed', 'failed'].includes(action.status)) {
        throw new RoutineError("It can't be moved from here");
      }
      if (+at <= +this.now()) throw new RoutineError('Pick a time that is still to come');
      this.requireSendable({ ...action, error: null });
      if (action.runId) await this.approveTickets(action.runId);
      this.store.updateAction(actionId, { executeAt: at, attempts: 0, retryAt: null, error: null });
      this.freeze(this.requireAction(actionId));
      this.reopen(action, 'approved');
      this.emit('change', action.projectId);
    });
    await this.tick();
  }

  /**
   * Takes an action off the schedule. One the service is already holding to send is taken back
   * there too, when the integration says how.
   */
  async cancelAction(actionId: string): Promise<void> {
    const action = this.requireAction(actionId);
    if (action.status === 'executing') throw new RoutineError("It's being sent right now");
    if (action.status === 'done' && !action.result?.handedOff) {
      throw new RoutineError('It has gone out already');
    }
    if (action.status === 'done') {
      if (+action.executeAt <= +this.now()) throw new RoutineError('Its time has come already');
      const info = this.options.integrations.operationInfo(
        action.integrationId,
        action.operationId,
        action.connectionId,
      );
      if (!info?.cancel || !action.connectionId || !action.result?.id) {
        throw new RoutineError(
          `${info?.integrationName ?? 'The service'} is holding it and clanks can't take it back from here. Cancel it there.`,
        );
      }
      const outcome = await this.options.integrations.call(
        action.connectionId,
        info.cancel,
        { id: action.result.id },
        AbortSignal.timeout(CALL_TIMEOUT_MS),
      );
      if (outcome.kind !== 'answered') {
        throw new RoutineError(`${info.integrationName} didn't take it back: ${outcome.message}`);
      }
    }
    this.store.updateAction(actionId, {
      status: 'cancelled',
      error: 'You took it off the schedule.',
      updatedAt: this.now(),
    });
    await this.tick();
    this.emit('change', action.projectId);
  }

  /** An action whose outcome isn't known: the user says it went out, has it sent, or drops it. */
  async decideUnknown(actionId: string, decision: 'sent' | 'send' | 'drop'): Promise<void> {
    const action = this.requireAction(actionId);
    if (action.status !== 'unknown') throw new RoutineError("Its outcome isn't in doubt");
    const now = this.now();
    if (decision === 'sent') {
      this.store.updateAction(actionId, {
        status: 'done',
        error: null,
        result: { id: null, url: null, summary: 'You said it went out.', handedOff: false },
        updatedAt: now,
      });
    } else if (decision === 'drop') {
      this.store.updateAction(actionId, {
        status: 'cancelled',
        error: 'You dropped it.',
        updatedAt: now,
      });
    } else {
      this.store.updateAction(actionId, { status: 'failed', updatedAt: now });
      return this.postNow(actionId);
    }
    await this.tick();
    this.emit('change', action.projectId);
  }

  // Campaigns

  /** A campaign's posts as they would be scheduled, with what's missing for each. */
  campaignPlan(ticketId: string): CampaignPostPlan[] {
    const ticket = this.options.board.ticket(ticketId);
    const now = this.now();
    const zone = this.userZone();
    const integrations = this.options.integrations.forRoutines(ticket.projectId);
    const frames = designedFrames(this.options.board.tickets(ticket.projectId));
    const taken = this.store.actionsOfTicket(ticketId).filter((a) => a.status !== 'cancelled');
    return postsOf(ticket.output).map((post, index): CampaignPostPlan => {
      const problems: string[] = [];
      const channel = post.channel.trim();
      const wanted = channel.toLowerCase().replace(/[^a-z0-9]/g, '');
      const integration = integrations.find((i) =>
        [
          i.id,
          i.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
          ...(CHANNEL_NAMES[i.id] ?? []),
        ].includes(wanted),
      );
      const visual =
        frames.find((f) => f.toLowerCase() === (post.visual ?? '').trim().toLowerCase()) ?? null;
      const posting = (integration?.operations ?? []).filter(
        (o) => o.parameters.includes('text') && /post|publish|tweet|message|update/.test(o.id),
      );
      const operation = visual
        ? posting.find((o) => o.parameters.includes('image'))
        : posting.find((o) => !o.required.includes('image'));
      let at: Date | null = null;
      if (post.at) {
        const parsed = Date.parse(post.at);
        if (!Number.isNaN(parsed) && /\d{4}-\d{2}-\d{2}T/.test(post.at)) at = new Date(parsed);
        else {
          const trigger = parseSchedule(post.at, { now, zone });
          at = trigger?.kind === 'once' ? onceInstant(trigger.at, zone) : null;
        }
      }
      if (taken.some((a) => a.stepId === `post-${index + 1}`))
        problems.push('It is scheduled already.');
      if (!integration) problems.push(`No integration posts to ${channel || 'its channel'}.`);
      else if (!integration.connection) {
        problems.push(`No ${integration.name} account is turned on in this project.`);
      } else if (!operation) {
        problems.push(
          visual
            ? `${integration.name} has no operation that posts a picture.`
            : `${integration.name} has no operation that posts.`,
        );
      }
      if (!post.at) problems.push('It names no time.');
      else if (!at) problems.push(`"${post.at}" isn't a time clanks can read.`);
      else if (+at <= +now) problems.push('Its time has passed.');
      if (post.visual && !visual) {
        problems.push(`"${short(post.visual, 60)}" isn't a frame in the project's design.`);
      }
      return {
        index,
        channel,
        account: post.account,
        text: post.text,
        at,
        visual,
        integrationId: integration?.id ?? null,
        operationId: operation?.id ?? null,
        connectionLabel: integration?.connection ?? null,
        problems,
      };
    });
  }

  /**
   * Schedules an approved campaign's posts: each one picked becomes an action, approved as shown,
   * that goes out at its time. Resolves with how many were scheduled.
   */
  async scheduleCampaign(ticketId: string, indexes: number[]): Promise<number> {
    const ticket = this.options.board.ticket(ticketId);
    if (ticket.type !== 'campaign' || ticket.outcome !== 'approved') {
      throw new RoutineError('Approve the campaign first: only approved posts are scheduled');
    }
    const plans = this.campaignPlan(ticketId).filter((p) => indexes.includes(p.index));
    if (plans.length === 0) throw new RoutineError('Pick the posts to schedule');
    const bad = plans.find((p) => p.problems.length > 0);
    if (bad)
      throw new RoutineError(`Post ${bad.index + 1} can't be scheduled: ${bad.problems.join(' ')}`);
    const now = this.now();
    for (const plan of plans) {
      const action: StoredAction = {
        id: randomUUID(),
        projectId: ticket.projectId,
        runId: null,
        ticketId,
        stepId: `post-${plan.index + 1}`,
        integrationId: plan.integrationId!,
        operationId: plan.operationId!,
        connectionId:
          this.options.integrations.connectionFor(ticket.projectId, plan.integrationId!)
            ?.connectionId ?? null,
        payload: null,
        media: [],
        payloadHash: null,
        executeAt: plan.at!,
        graceMs: durationMs('15m'),
        delivery: 'at_time',
        status: 'pending_approval',
        approvedAt: null,
        attempts: 0,
        attemptId: null,
        retryAt: null,
        result: null,
        error: null,
        madeBy: ticket.route[0]?.clankId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      const payload: Record<string, unknown> = { text: plan.text };
      if (plan.visual) payload.image = { $frame: { ticketId, name: plan.visual } };
      const built = { ...action, ...(await this.render(action, payload, null)) };
      // Checked before it's kept, so one that can't go out leaves nothing behind.
      this.requireSendable(built);
      this.store.insertAction(built);
      this.freeze(built);
    }
    this.emit('change', ticket.projectId);
    this.wake();
    return plans.length;
  }

  // Events

  /** Something happened in a project: routines that start on it start. */
  fire(projectId: string, event: RoutineEvent): void {
    if (this.paused() || this.closed) return;
    let started = false;
    for (const routine of this.store.routines(projectId)) {
      const { trigger } = routine.definition;
      if (routine.status !== 'active' || trigger.kind !== 'event') continue;
      if (trigger.event !== event.name) continue;
      // A routine that starts when routines finish doesn't start itself in a circle.
      if (event.name === 'routine.finished' && event.detail.id === routine.id) continue;
      const matches = Object.entries(trigger.filters).every(([name, wanted]) => {
        if (!wanted) return true;
        if (name === 'pattern') return glob(wanted, event.detail.tag ?? '');
        if (name === 'routine') {
          return [event.detail.routine, event.detail.id].some(
            (v) => (v ?? '').toLowerCase() === wanted.toLowerCase(),
          );
        }
        return (event.detail[name] ?? '').toLowerCase() === wanted.toLowerCase();
      });
      if (!matches) continue;
      this.begin(routine, this.free(routine.id), { kind: 'event', event });
      started = true;
    }
    if (started) {
      this.emit('change', projectId);
      this.wake();
    }
  }

  /** Looks for tags that weren't there last time, in projects with a routine waiting on one. */
  async pollTags(): Promise<void> {
    const read = this.options.tags;
    if (!read || this.paused()) return;
    const waiting = new Set(
      this.store
        .routines()
        .filter(
          (r) =>
            r.status === 'active' &&
            r.definition.trigger.kind === 'event' &&
            r.definition.trigger.event === 'git.tag',
        )
        .map((r) => r.projectId),
    );
    for (const projectId of waiting) {
      const project = this.options.projects.find(projectId);
      if (!project) continue;
      const tags = await read(project.folder).catch(() => null);
      if (!tags) continue;
      const key = `routineTags.${projectId}` as const;
      const known = this.options.settings.readInternal(key);
      this.options.settings.writeInternal(key, tags);
      // The first look only notes what's there: a tag from last year isn't news.
      if (!Array.isArray(known)) continue;
      for (const tag of tags.filter((t) => !known.includes(t))) {
        this.fire(projectId, { name: 'git.tag', detail: { tag } });
      }
    }
  }

  // Tools

  /** The routine tools, for a clank in a project: reading, and drafting. Never more. */
  access(projectId: string, clankId: string, conversationId: string): RoutineAccess {
    const names = () => this.crewNames(projectId);
    // What's wrong is said to the clank, in words it can act on.
    const said = <A extends unknown[]>(run: (...args: A) => string) => {
      return (...args: A): string => {
        try {
          return run(...args);
        } catch (error) {
          if (error instanceof RoutineError) throw new ToolFailure(error.message);
          throw error;
        }
      };
    };
    const access: RoutineAccess = {
      list: () => {
        const { routines } = this.snapshot(projectId);
        if (routines.length === 0) return 'This project has no routines yet.';
        return routines.map((r) => routineLine(r, this.now())).join('\n');
      },
      get: (ref) => {
        const snapshot = this.snapshot(projectId);
        const routine = this.find(snapshot.routines, ref);
        if (!routine) {
          throw new RoutineError(
            snapshot.routines.length === 0
              ? 'This project has no routines yet.'
              : `There's no routine called "${ref}". There ${snapshot.routines.length === 1 ? 'is' : 'are'}: ${snapshot.routines.map((r) => r.definition.name).join(', ')}.`,
          );
        }
        return routineDetail(
          routine,
          snapshot.runs.filter((run) => run.routineId === routine.id).slice(0, 5),
          this.now(),
          names(),
        );
      },
      propose: (draft) => {
        const given =
          typeof draft === 'object' && draft !== null ? (draft as Record<string, unknown>) : {};
        const now = this.now();
        let definition: RoutineDefinition;
        try {
          definition = readDefinition(given, { now, zone: this.userZone() });
        } catch (error) {
          if (error instanceof RoutineFormatError) {
            throw new RoutineError(`That isn't a routine yet:\n${error.message}`);
          }
          throw error;
        }
        const { problems, warnings } = this.check(projectId, definition, now);
        if (problems.length > 0) {
          throw new RoutineError(
            `Nothing was drafted. Fix these and call routine_propose again:\n${problems.map((p) => `- ${p}`).join('\n')}`,
          );
        }
        const existing = this.store.routines(projectId);
        const ref = typeof given.routine === 'string' ? given.routine.trim() : '';
        const target = ref
          ? this.find(existing, ref)
          : existing.find((r) => r.definition.name.toLowerCase() === definition.name.toLowerCase());
        if (ref && !target) throw new RoutineError(`There's no routine called "${ref}" to change.`);
        let routine: Routine;
        if (target && target.status === 'draft') {
          this.store.updateRoutine(target.id, { definition, conversationId, updatedAt: now });
          routine = this.routine(target.id);
        } else {
          routine = this.create(projectId, definition, { createdBy: clankId, conversationId });
          // A change to one that's on waits beside it until the user turns it on in its place.
          if (target) {
            this.store.updateRoutine(routine.id, { replaces: target.id });
            routine = this.routine(routine.id);
          }
        }
        this.emit('change', projectId);
        const info = this.info(routine, now, new Map());
        const user = this.options.settings.get().profile.name || 'the user';
        return [
          `Drafted "${definition.name}" [routine ${routine.id}]. It shows in this chat as a card ${user} can edit. Nothing is scheduled until they press Activate${target && target.status !== 'draft' ? `, which puts it in place of "${target.definition.name}"` : ''}.`,
          `Starts: ${info.triggerText}.${info.nextRuns.length > 0 ? ` Next: ${info.nextRuns.map((r) => whenText(r, info.zone, now)).join('; ')}.` : ''}`,
          ...info.timings
            .filter((t) => t.at)
            .map((t) => {
              const step = definition.steps.find((s) => s.id === t.stepId)!;
              return step.action
                ? `- ${t.stepId}: goes out at ${timeIn(t.at!, info.zone)}, once ${user} has approved it`
                : `- ${t.stepId}: due ${timeIn(t.at!, info.zone)}${t.why ? `, ${t.why}` : ''}`;
            }),
          ...warnings.map((w) => `Worth a look: ${w}`),
          `Tell ${user} what it will do, in a sentence or two, and that it waits for them to activate it.`,
        ].join('\n');
      },
    };
    return {
      list: said(() => access.list()),
      get: said((ref: string) => access.get(ref)),
      propose: said((draft: unknown) => access.propose(draft)),
    };
  }

  // Runs

  /** A routine's time came. On time, it runs; late, its missed policy decides. */
  private comeDue(routine: Routine, now: Date): void {
    const { definition } = routine;
    const zone = this.zoneOf(definition);
    const first = routine.nextRunAt!;
    let due: Date[] = [first];
    let more = false;
    if (definition.trigger.kind === 'cron') {
      const between = runsBetween(parseCron(definition.trigger.cron), first, now, zone);
      due = [first, ...between.runs];
      more = between.more;
    }
    const last = due.at(-1)!;
    const policy: MissedPolicy = missedPolicyOf(definition);
    const onTime = +now - +last <= durationMs(definition.missed.grace);
    const count = `${due.length}${more ? ' or more' : ''}`;
    const away = "clanks wasn't running, or this computer was asleep";

    let missed = due.slice(0, -1);
    if (onTime) {
      this.begin(routine, last, { kind: 'time' });
    } else if (policy === 'run_late') {
      // Once, however many were missed.
      this.begin(routine, last, { kind: 'late', missed: due.length });
      missed = [];
    } else if (policy === 'ask') {
      const asked = this.newRun(routine, last, { kind: 'time' }, {}, 'missed');
      asked.asks = true;
      asked.reason =
        due.length === 1
          ? `${cap(away)} when it came due.`
          : `${count} runs came due while ${away}.`;
      asked.endedAt = now;
      if (!this.store.runAt(routine.id, last)) this.store.insertRun(asked);
      missed = [];
      this.notify({
        kind: 'missed',
        title: `${definition.name} was missed`,
        body: `${asked.reason} Run it now, or skip it.`,
        projectId: routine.projectId,
        routineId: routine.id,
        runId: asked.id,
        actionId: null,
      });
    } else {
      missed = due;
    }
    for (const at of missed.slice(-MISSED_RECORDED)) {
      if (this.store.runAt(routine.id, at)) continue;
      const run = this.newRun(routine, at, { kind: 'time' }, {}, 'missed');
      run.reason = `${cap(away)} at ${whenText(at, zone, now)}.`;
      run.endedAt = now;
      this.store.insertRun(run);
    }
    if (!onTime && policy === 'skip') {
      this.notify({
        kind: 'missed',
        title: `${definition.name} was missed`,
        body:
          due.length === 1
            ? `${cap(away)} at ${whenText(last, zone, now)}, so it didn't run.`
            : `${count} runs came due while ${away}. None of them ran.`,
        projectId: routine.projectId,
        routineId: routine.id,
        runId: null,
        actionId: null,
      });
    }

    const next = this.nextFor(routine, now);
    if (definition.trigger.kind === 'once') {
      // One run: once it has had its time it's over, or it waits to be given another.
      const ran = onTime || policy === 'run_late';
      this.store.updateRoutine(routine.id, {
        nextRunAt: null,
        ...(ran ? {} : { status: 'paused', pausedReason: `Its time passed while ${away}.` }),
      });
    } else {
      this.store.updateRoutine(routine.id, { nextRunAt: next });
    }
  }

  /**
   * A run is wanted. Whether it starts now depends on the run before it, and on what the routine
   * has left to spend this month.
   */
  private begin(
    routine: Routine,
    scheduledFor: Date,
    trigger: RunTrigger,
    inputs: Record<string, string> = {},
    force = false,
  ): void {
    const planned = this.store.runAt(routine.id, scheduledFor);
    // Nothing runs twice for the same scheduled time, whatever the clock does.
    if (planned && planned.status !== 'scheduled') return;
    const { definition } = routine;
    const now = this.now();
    const zone = this.zoneOf(definition);
    const going = this.going(routine.id, planned?.id);
    const record = (status: RoutineRunStatus, reason: string) => {
      const run = planned ?? this.newRun(routine, scheduledFor, trigger, inputs, status);
      if (planned) this.store.updateRun(planned.id, { status, reason, endedAt: now });
      else this.store.insertRun({ ...run, status, reason, endedAt: now });
    };
    if (going.length > 0 && !force && definition.concurrency !== 'parallel') {
      const before = whenText(going[0]!.scheduledFor, zone, now);
      if (definition.concurrency === 'skip') {
        record('skipped', `The run of ${before} was still going.`);
        return;
      }
      const reason = `Waiting for the run of ${before} to finish.`;
      if (planned) this.store.updateRun(planned.id, { reason });
      else {
        this.store.insertRun({
          ...this.newRun(routine, scheduledFor, trigger, inputs, 'scheduled'),
          reason,
        });
      }
      return;
    }
    const spent = budgetReached(definition.budget.perMonth, this.monthUsage(routine, now));
    if (spent) {
      record('skipped', `Its budget for the month, ${spent}, is spent.`);
      this.pauseFor(
        routine,
        `Its budget for the month, ${spent}, is spent. Raise it, or it starts again next month.`,
      );
      return;
    }
    this.launch(routine, scheduledFor, trigger, { ...planned?.inputs, ...inputs }, planned ?? null);
  }

  /** Starts a run: its tickets go on the board together, and its actions wait for their steps. */
  private launch(
    routine: Routine,
    scheduledFor: Date,
    trigger: RunTrigger,
    given: Record<string, string>,
    planned: StoredRun | null,
  ): void {
    const { definition } = routine;
    const now = this.now();
    const zone = this.zoneOf(definition);
    const inputs = { ...definition.inputs, ...given };
    const run = planned ?? this.newRun(routine, scheduledFor, trigger, inputs, 'working');
    const started: StoredRun = { ...run, inputs, status: 'working', reason: null, startedAt: now };
    if (planned) this.store.updateRun(run.id, started);
    else this.store.insertRun(started);
    this.store.updateRoutine(routine.id, { lastRunAt: now });

    const times = stepTimes(definition, scheduledFor, zone);
    const scope = {
      inputs,
      run: {
        date: dateIn(scheduledFor, zone),
        time: timeIn(scheduledFor, zone),
        started_at: now.toISOString(),
      },
      routine: { name: definition.name },
      event: trigger.kind === 'event' ? trigger.event.detail : {},
    };
    const ticketSteps = definition.steps.filter((step) => step.ticket);
    try {
      const made = this.options.board.addForRoutine(
        routine.projectId,
        ticketSteps.map((step) => {
          const time = times.find((t) => t.stepId === step.id);
          const ticket = step.ticket!;
          const filled = fillTemplates(
            { title: ticket.title, description: ticket.description, criteria: ticket.criteria },
            scope,
          ).value as { title: string; description: string; criteria: string[] };
          const from: TicketRoutine = {
            routineId: routine.id,
            runId: run.id,
            stepId: step.id,
            name: definition.name,
            date: scope.run.date,
            inputs,
            dueAt: time?.at?.toISOString() ?? null,
            dueWhy: time?.why ?? null,
            zone,
          };
          return {
            stepId: step.id,
            title: filled.title.slice(0, 200) || ticket.title,
            type: ticket.type,
            description: filled.description,
            criteria: filled.criteria,
            clank: ticket.clank,
            dependsOn: step.dependsOn.filter((d) => ticketSteps.some((s) => s.id === d)),
            routine: from,
          };
        }),
      );
      this.store.updateRun(run.id, {
        ticketIds: Object.fromEntries([...made].map(([stepId, ticket]) => [stepId, ticket.id])),
      });
    } catch (error) {
      this.end(
        { ...started },
        'failed',
        `Its tickets couldn't be made: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const grace = durationMs(definition.missed.grace);
    for (const step of definition.steps) {
      if (!step.action) continue;
      const at = times.find((t) => t.stepId === step.id)?.at ?? scheduledFor;
      // Its words come from the last ticket it waits on, whose maker hears how it went.
      const maker = [...step.dependsOn]
        .reverse()
        .map((d) => definition.steps.find((s) => s.id === d)?.ticket?.clank)
        .find(Boolean);
      this.store.insertAction({
        id: randomUUID(),
        projectId: routine.projectId,
        runId: run.id,
        ticketId: null,
        stepId: step.id,
        integrationId: step.action.integration,
        operationId: step.action.operation,
        connectionId:
          this.options.integrations.connectionFor(routine.projectId, step.action.integration)
            ?.connectionId ?? null,
        payload: null,
        media: [],
        payloadHash: null,
        executeAt: at,
        graceMs: grace,
        delivery: step.action.deliver,
        status: 'pending_approval',
        approvedAt: null,
        attempts: 0,
        attemptId: null,
        retryAt: null,
        result: null,
        error: null,
        madeBy: maker ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
    this.touch(routine.projectId);
  }

  /** A project's board changed: its runs are looked at again, after what's under way. */
  private touch(projectId: string): void {
    if (this.closed || this.stale.has(projectId)) return;
    this.stale.add(projectId);
    void this.enqueue(async () => {
      this.stale.delete(projectId);
      if (await this.sync(projectId)) this.emit('change', projectId);
    }).catch(logged);
  }

  /**
   * Brings a project's runs up to date with their tickets: a run whose work is all signed off
   * builds what it will send and waits for approval; one with nothing to send ends when its
   * tickets are done. Resolves true when anything changed.
   */
  private async sync(projectId: string): Promise<boolean> {
    const runs = this.store.runsWith(GOING, projectId);
    if (runs.length === 0) return false;
    const tickets = this.options.board.tickets(projectId);
    let changed = false;
    for (const run of runs) {
      const routine = this.store.routine(run.routineId);
      if (!routine) continue;
      const steps = routine.definition.steps.filter((s) => s.ticket && run.ticketIds[s.id]);
      const made = new Map(
        steps.map((s) => [s.id, tickets.find((t) => t.id === run.ticketIds[s.id])] as const),
      );
      const gone = steps.find((s) => !made.get(s.id));
      const rejected = [...made.values()].find((t) => t?.outcome === 'rejected');
      if (gone || rejected) {
        this.end(
          run,
          'cancelled',
          rejected ? `${rejected.key} was rejected.` : `The ticket for "${gone!.id}" was deleted.`,
        );
        changed = true;
        continue;
      }
      const actions = this.store.actionsOf(run.id);
      const signed = [...made.values()].every((t) => t && (t.doneAt || columnOf(t) === 'ready'));
      if (run.status === 'working') {
        if (actions.length === 0) {
          if ([...made.values()].every((t) => t?.doneAt)) {
            this.end(run, 'done', null);
            changed = true;
          }
          continue;
        }
        if (!signed) continue;
        for (const action of actions) {
          if (action.status !== 'pending_approval') continue;
          const step = routine.definition.steps.find((s) => s.id === action.stepId);
          if (!step?.action) continue;
          const scope = {
            inputs: run.inputs,
            run: {
              date: dateIn(run.scheduledFor, this.zoneOf(routine.definition)),
              time: timeIn(run.scheduledFor, this.zoneOf(routine.definition)),
              started_at: (run.startedAt ?? run.scheduledFor).toISOString(),
            },
            routine: { name: routine.definition.name },
            event: run.trigger.kind === 'event' ? run.trigger.event.detail : {},
            steps: Object.fromEntries(
              step.dependsOn
                .filter((d) => made.get(d))
                .map((d) => [d, { output: outputView(made.get(d)!) }]),
            ),
          };
          const filled = fillTemplates(step.action.payload, scope);
          const built = await this.render(
            action,
            filled.value as Record<string, unknown>,
            filled.missing.length > 0
              ? `${filled.missing.join(', ')} ${filled.missing.length === 1 ? 'has' : 'have'} no value in what was handed in.`
              : null,
          );
          this.store.updateAction(action.id, { ...built, updatedAt: this.now() });
        }
        this.store.updateRun(run.id, { status: 'awaiting_approval' });
        changed = true;
        if (!run.notified) {
          this.store.updateRun(run.id, { notified: true });
          const first = Math.min(...actions.map((a) => +a.executeAt));
          const zone = this.zoneOf(routine.definition);
          this.notify({
            kind: 'ready',
            title: `${routine.definition.name} is ready for you`,
            body: `${this.count(actions.length, 'action')} to approve. The first goes out ${whenText(first, zone, this.now())}.`,
            projectId,
            routineId: routine.id,
            runId: run.id,
            actionId: null,
          });
        }
      } else if (run.status === 'awaiting_approval' && !signed) {
        // Work sent back for changes: what was built from it is built again when it returns.
        for (const action of actions) {
          if (action.status !== 'pending_approval') continue;
          this.store.updateAction(action.id, { payload: null, media: [], error: null });
        }
        this.store.updateRun(run.id, { status: 'working', notified: false, reminded: false });
        changed = true;
      } else if (run.status === 'approved' && this.settle(run)) {
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Turns a filled-in payload into what's kept: frames drawn and saved as files, the rest checked
   * against the operation it's for. What's wrong goes in `error`, for the card to say.
   */
  private async render(
    action: StoredAction,
    payload: Record<string, unknown>,
    problem: string | null,
  ): Promise<Pick<StoredAction, 'payload' | 'media' | 'error' | 'connectionId'>> {
    const media: StoredAction['media'] = [];
    const problems = problem ? [problem] : [];
    const tickets = this.options.board.tickets(action.projectId);
    const draw = async (value: unknown): Promise<unknown> => {
      if (isFrameRequest(value)) {
        const { ticketId, name } = value.$frame;
        const ticket = tickets.find((t) => t.id === ticketId) ?? null;
        const png = await this.options.framePng?.(action.projectId, name, ticket).catch(() => null);
        if (!png) {
          problems.push(`The frame "${name}" couldn't be drawn, so there's no picture to send.`);
          return null;
        }
        const hash = sha256(png);
        const path = join('routines', action.runId ?? action.ticketId ?? 'actions', `${hash}.png`);
        const file = join(this.options.artifactsDir, path);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, png);
        if (!media.some((m) => m.sha256 === hash)) {
          media.push({
            sha256: hash,
            name: `${name}.png`,
            mediaType: 'image/png',
            size: png.length,
            path,
          });
        }
        return { $media: hash };
      }
      if (Array.isArray(value)) return Promise.all(value.map(draw));
      if (typeof value === 'object' && value !== null && !isMediaMarker(value)) {
        const entries = await Promise.all(
          Object.entries(value).map(async ([key, entry]) => [key, await draw(entry)] as const),
        );
        return Object.fromEntries(entries);
      }
      return value;
    };
    let drawn = (await draw(payload)) as Record<string, unknown>;
    if (problems.length === 0) {
      try {
        drawn = this.fit(action, drawn);
      } catch (error) {
        if (!(error instanceof RoutineError)) throw error;
        problems.push(error.message);
      }
    }
    return {
      payload: drawn,
      media,
      error: problems.join(' ') || null,
      connectionId:
        action.connectionId ??
        this.options.integrations.connectionFor(action.projectId, action.integrationId)
          ?.connectionId ??
        null,
    };
  }

  /** Checks a payload against its operation's arguments, with files standing in as text. */
  private fit(
    action: Pick<
      StoredAction,
      'integrationId' | 'operationId' | 'connectionId' | 'delivery' | 'executeAt'
    >,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const flat = withMedia(payload, (hash) => `${MEDIA_SENTINEL}${hash}`) as Record<
      string,
      unknown
    >;
    // Handed over, its time is filled in when it's sent: it stands in here so the check passes.
    const held =
      action.delivery === 'hand_off'
        ? (this.options.integrations.operationInfo(
            action.integrationId,
            action.operationId,
            action.connectionId,
          )?.schedule ?? null)
        : null;
    if (held && flat[held] === undefined) flat[held] = action.executeAt.toISOString();
    let fitted: Record<string, unknown>;
    try {
      fitted = this.options.integrations.fitArguments(
        action.integrationId,
        action.operationId,
        flat,
      );
    } catch (error) {
      if (error instanceof IntegrationError) {
        throw new RoutineError(`Its payload doesn't fit ${action.operationId}: ${error.message}.`);
      }
      throw error;
    }
    const back = (value: unknown): unknown => {
      if (typeof value === 'string' && value.startsWith(MEDIA_SENTINEL)) {
        return { $media: value.slice(MEDIA_SENTINEL.length) };
      }
      if (Array.isArray(value)) return value.map(back);
      if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, back(v)]));
      }
      return value;
    };
    if (held && payload[held] === undefined) delete fitted[held];
    return back(fitted) as Record<string, unknown>;
  }

  /** A run whose actions have all ended ends too. Returns true when it did. */
  private settle(run: StoredRun): boolean {
    const actions = this.store.actionsOf(run.id);
    const open = actions.some((a) =>
      ['pending_approval', 'approved', 'executing', 'unknown'].includes(a.status),
    );
    if (open) return false;
    const failed = actions.find((a) => a.status === 'failed');
    const missed = actions.find((a) => a.status === 'missed');
    if (failed) this.end(run, 'failed', failed.error);
    else if (missed) this.end(run, 'missed', missed.error);
    else if (actions.length > 0 && actions.every((a) => a.status === 'cancelled')) {
      this.end(run, 'cancelled', 'Everything it had to send was taken off the schedule.');
    } else this.end(run, 'done', null);
    return true;
  }

  /** Ends a run, and with it whatever it still had waiting. */
  private end(run: StoredRun, status: RoutineRunStatus, reason: string | null): void {
    const now = this.now();
    this.store.updateRun(run.id, { status, reason, endedAt: now, asks: false });
    if (status === 'cancelled' || status === 'failed') {
      for (const action of this.store.actionsOf(run.id)) {
        if (['pending_approval', 'approved'].includes(action.status)) {
          this.store.updateAction(action.id, {
            status: 'cancelled',
            error: reason,
            updatedAt: now,
          });
        }
      }
    }
    const routine = this.store.routine(run.routineId);
    if (!routine) return;
    if (status === 'failed') {
      const failures = routine.failures + 1;
      this.store.updateRoutine(routine.id, { failures });
      if (failures >= FAILURES_PAUSED && routine.status === 'active') {
        this.pauseFor(
          routine,
          `Its last ${FAILURES_PAUSED} runs failed. The latest: ${reason ?? 'no reason given'}`,
        );
      } else {
        this.notify({
          kind: 'failed',
          title: `${routine.definition.name} failed`,
          body: reason ?? 'Open it to see why.',
          projectId: run.projectId,
          routineId: routine.id,
          runId: run.id,
          actionId: null,
        });
      }
    } else if (status === 'done') {
      this.store.updateRoutine(routine.id, { failures: 0 });
    }
    // A routine that runs once has had its run, however it went.
    const current = this.store.routine(routine.id);
    if (
      current?.status === 'active' &&
      current.definition.trigger.kind === 'once' &&
      !current.nextRunAt &&
      run.trigger.kind !== 'manual'
    ) {
      this.store.updateRoutine(routine.id, { status: 'done' });
    }
    this.fire(run.projectId, {
      name: 'routine.finished',
      detail: { routine: routine.definition.name, id: routine.id, status, run: run.id },
    });
    // The next in line, if one was waiting on this.
    if (this.started) void this.tick();
  }

  /** Why a routine's ticket may not be worked now: its run is over, or has spent its budget. */
  private gate(ticket: Ticket): string | null {
    if (!ticket.routine) return null;
    const run = this.store.run(ticket.routine.runId);
    if (!run) return null;
    if (run.status === 'cancelled') return 'its run was stopped';
    const routine = this.store.routine(run.routineId);
    const budget = routine?.definition.budget.perRun;
    if (!budget) return null;
    const usage = this.options.board.ticketUsage(run.projectId);
    const spent = budgetReached(budget, this.sum(Object.values(run.ticketIds), usage));
    return spent ? `this run's budget of ${spent} is spent` : null;
  }

  // Actions

  /** Why an action can't be approved or sent as it is. */
  private requireSendable(action: StoredAction): void {
    const info = this.options.integrations.operationInfo(
      action.integrationId,
      action.operationId,
      action.connectionId,
    );
    if (!info) throw new RoutineError(`${action.integrationId} isn't installed any more`);
    if (info.problem) throw new RoutineError(info.problem);
    if (!action.payload) throw new RoutineError("What it sends isn't ready yet");
    if (action.error && action.status === 'pending_approval') throw new RoutineError(action.error);
    for (const hash of mediaIn(action.payload)) {
      const file = action.media.find((m) => m.sha256 === hash);
      if (!file || !existsSync(join(this.options.artifactsDir, file.path))) {
        throw new RoutineError('A file it sends is missing');
      }
    }
    if (action.delivery === 'hand_off' && !info.schedule) {
      throw new RoutineError(`${info.integrationName} can't hold it to send later`);
    }
  }

  /** Approves an action as it stands: what it is now is what goes out, or nothing does. */
  private freeze(action: StoredAction): void {
    const now = this.now();
    this.store.updateAction(action.id, {
      status: 'approved',
      approvedAt: now,
      payloadHash: sha256(frozenText({ ...action, executeAt: +action.executeAt })),
      attemptId: null,
      retryAt: null,
      error: null,
      updatedAt: now,
    });
  }

  /** Approves a run's signed-off tickets, for an action sent or moved outside the run's card. */
  private async approveTickets(runId: string): Promise<void> {
    const run = this.store.run(runId);
    if (!run) return;
    const tickets = this.options.board.tickets(run.projectId);
    for (const ticketId of Object.values(run.ticketIds)) {
      const ticket = tickets.find((t) => t.id === ticketId);
      if (ticket && columnOf(ticket) === 'ready') await this.options.board.approve(ticket.id);
    }
  }

  /** An action changed after its run ended or was approved: the run is open again. */
  private reopen(
    action: StoredAction,
    status: 'awaiting_approval' | 'approved' = 'awaiting_approval',
  ): void {
    if (!action.runId) return;
    const run = this.store.run(action.runId);
    if (!run || run.status === 'working') return;
    const pending = this.store.actionsOf(run.id).some((a) => a.status === 'pending_approval');
    this.store.updateRun(run.id, {
      status: pending ? 'awaiting_approval' : status,
      endedAt: null,
      reason: null,
    });
  }

  private miss(action: StoredAction, why: string): void {
    this.store.updateAction(action.id, {
      status: 'missed',
      error: why,
      attemptId: null,
      retryAt: null,
      updatedAt: this.now(),
    });
    const info = this.options.integrations.operationInfo(
      action.integrationId,
      action.operationId,
      action.connectionId,
    );
    this.notify({
      kind: 'missed',
      title: `${info?.integrationName ?? action.integrationId}: an action was missed`,
      body: `${why} Open it to post it now or pick another time.`,
      projectId: action.projectId,
      routineId: this.store.run(action.runId ?? '')?.routineId ?? null,
      runId: action.runId,
      actionId: action.id,
    });
    const run = action.runId ? this.store.run(action.runId) : undefined;
    if (run?.status === 'awaiting_approval') {
      // Nothing left to approve: the run is over.
      const left = this.store.actionsOf(run.id).some((a) => a.status === 'pending_approval');
      if (!left) this.store.updateRun(run.id, { status: 'approved' });
    }
  }

  private fail(action: StoredAction, why: string): void {
    this.store.updateAction(action.id, {
      status: 'failed',
      error: why,
      attemptId: null,
      retryAt: null,
      updatedAt: this.now(),
    });
    const info = this.options.integrations.operationInfo(
      action.integrationId,
      action.operationId,
      action.connectionId,
    );
    this.notify({
      kind: 'failed',
      title: `${info?.integrationName ?? action.integrationId}: an action failed`,
      body: short(why, 200),
      projectId: action.projectId,
      routineId: this.store.run(action.runId ?? '')?.routineId ?? null,
      runId: action.runId,
      actionId: action.id,
    });
  }

  /**
   * Carries out an approved action whose time has come. It goes out only if it's exactly what was
   * approved. It's marked as being sent before the service is called, so a crash mid-call is
   * known for what it is rather than tried again blind.
   */
  private async send(action: StoredAction): Promise<void> {
    const { integrations } = this.options;
    const info = integrations.operationInfo(
      action.integrationId,
      action.operationId,
      action.connectionId,
    );
    if (!info || info.problem || !action.connectionId) {
      return this.fail(
        action,
        info?.problem ?? `${action.integrationId} isn't installed any more.`,
      );
    }
    if (
      !action.payload ||
      sha256(frozenText({ ...action, executeAt: +action.executeAt })) !== action.payloadHash
    ) {
      return this.fail(action, "It isn't what was approved any more, so it wasn't sent.");
    }
    const files = new Map<string, string>();
    for (const hash of mediaIn(action.payload)) {
      const file = action.media.find((m) => m.sha256 === hash);
      const path = file ? join(this.options.artifactsDir, file.path) : '';
      const data = file && existsSync(path) ? readFileSync(path) : null;
      if (!data || sha256(data) !== hash) {
        return this.fail(
          action,
          "A file it sends isn't the one that was approved, so it wasn't sent.",
        );
      }
      files.set(hash, data.toString('base64'));
    }
    const handOff = action.delivery === 'hand_off';
    if (handOff && !info.schedule) {
      return this.fail(action, `${info.integrationName} can't hold it to send later.`);
    }
    const attempts = action.attempts + 1;
    this.store.updateAction(action.id, {
      status: 'executing',
      attempts,
      attemptId: randomUUID(),
      retryAt: null,
      updatedAt: this.now(),
    });
    this.emit('change', action.projectId);

    const args = withMedia(action.payload, (hash) => files.get(hash)) as Record<string, unknown>;
    if (handOff) args[info.schedule!] = action.executeAt.toISOString();
    let outcome;
    try {
      outcome = await integrations.call(
        action.connectionId,
        action.operationId,
        args,
        AbortSignal.timeout(CALL_TIMEOUT_MS),
      );
    } catch (error) {
      outcome = {
        kind: 'unanswered' as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const current = this.requireAction(action.id);
    if (outcome.kind === 'answered') return this.sent(current, outcome.body, handOff);
    if (outcome.kind === 'unavailable') return this.fail(current, outcome.message);
    if (outcome.kind === 'refused') {
      if (isTransientStatus(outcome.status)) return this.retry(current, outcome.message);
      return this.fail(current, `${info.integrationName} turned it down: ${outcome.message}`);
    }
    // No answer: it may have gone through. Where the service can say, ask before trying again.
    if (info.verify) {
      const checked = await this.verify(current, info.verify);
      if (checked === 'found') return;
      if (checked === 'unsure') return this.unknown(current, outcome.message);
    }
    this.retry(current, outcome.message);
  }

  /** Tries again after a wait, while its window is open. After that it has failed. */
  private retry(action: StoredAction, why: string): void {
    const now = +this.now();
    const at = now + retryDelay(action.attempts);
    const closes =
      action.delivery === 'hand_off' ? +action.executeAt : +action.executeAt + action.graceMs;
    if (at > closes) {
      return this.fail(action, `It kept failing until its time had passed: ${why}`);
    }
    this.store.updateAction(action.id, {
      status: 'approved',
      attemptId: null,
      retryAt: new Date(at),
      error: `Trying again: ${short(why, 200)}`,
      updatedAt: new Date(now),
    });
    this.emit('change', action.projectId);
  }

  private sent(action: StoredAction, body: unknown, handedOff: boolean): void {
    const info = this.options.integrations.operationInfo(
      action.integrationId,
      action.operationId,
      action.connectionId,
    );
    const result = resultOf(
      body,
      this.options.integrations.linkFor(action.integrationId, action.operationId, body),
      handedOff,
    );
    this.store.updateAction(action.id, {
      status: 'done',
      result,
      error: null,
      attemptId: null,
      retryAt: null,
      updatedAt: this.now(),
    });
    // The clank whose work it was hears how it went, for next time.
    if (action.madeBy) {
      const words = textOf(action.payload);
      try {
        this.options.context.remember({
          projectId: action.projectId,
          clankId: action.madeBy,
          kind: 'note',
          body: short(
            `${handedOff ? 'Handed to' : 'Sent through'} ${info?.integrationName ?? action.integrationId}${info?.connectionLabel ? ` as ${info.connectionLabel}` : ''} on ${action.executeAt.toISOString().slice(0, 16).replace('T', ' ')} UTC${words ? `: "${short(words, 200)}"` : ''}${result.url ? ` ${result.url}` : ''}`,
            600,
          ),
          ticketId: action.ticketId,
        });
      } catch {
        // It held something like a secret: it went out, unremembered.
      }
    }
    this.emit('change', action.projectId);
  }

  private unknown(action: StoredAction, why: string): void {
    this.store.updateAction(action.id, {
      status: 'unknown',
      error: `clanks can't tell whether it went out: ${short(why, 200)}`,
      attemptId: null,
      retryAt: null,
      updatedAt: this.now(),
    });
    const info = this.options.integrations.operationInfo(
      action.integrationId,
      action.operationId,
      action.connectionId,
    );
    this.notify({
      kind: 'unknown',
      title: `${info?.integrationName ?? action.integrationId}: did the action go out?`,
      body: "clanks stopped while sending it and can't tell. Check, then say what happened, rather than risk sending it twice.",
      projectId: action.projectId,
      routineId: this.store.run(action.runId ?? '')?.routineId ?? null,
      runId: action.runId,
      actionId: action.id,
    });
    this.emit('change', action.projectId);
  }

  /**
   * Asks the service whether an action went out, with the read operation its integration names
   * for that. `found` marks it done; `absent` means it's safe to try again.
   */
  private async verify(
    action: StoredAction,
    operation: string,
  ): Promise<'found' | 'absent' | 'unsure'> {
    if (!action.connectionId) return 'unsure';
    // Where it would be listed: what the action names that the check takes too, such as a channel.
    const takes =
      this.options.integrations
        .forRoutines(action.projectId)
        .find((i) => i.id === action.integrationId)
        ?.operations.find((o) => o.id === operation)?.parameters ?? [];
    const words = textField(action.payload);
    const args = Object.fromEntries(
      Object.entries(action.payload ?? {}).filter(
        ([name, value]) =>
          name !== words && takes.includes(name) && ['string', 'number'].includes(typeof value),
      ),
    );
    const outcome = await this.options.integrations
      .call(action.connectionId, operation, args, AbortSignal.timeout(CALL_TIMEOUT_MS))
      .catch(() => null);
    if (outcome?.kind !== 'answered') return 'unsure';
    if (!foundIn(action.payload, outcome.body ?? outcome.text)) return 'absent';
    this.store.updateAction(action.id, {
      status: 'done',
      result: {
        id: null,
        url: null,
        summary: 'It went out: the service lists it.',
        handedOff: false,
      },
      error: null,
      attemptId: null,
      retryAt: null,
      updatedAt: this.now(),
    });
    this.emit('change', action.projectId);
    return 'found';
  }

  /** An action that was mid-call when the app stopped: find out what happened, or ask the user. */
  private async resolveUnknown(action: StoredAction): Promise<void> {
    const info = this.options.integrations.operationInfo(
      action.integrationId,
      action.operationId,
      action.connectionId,
    );
    const why = 'clanks stopped while it was being sent.';
    if (!info?.verify) return this.unknown(action, why);
    const checked = await this.verify(action, info.verify);
    if (checked === 'unsure') return this.unknown(action, why);
    if (checked === 'absent') {
      // It never went out. Back in line: sent if its window is still open, missed if not.
      this.store.updateAction(action.id, { status: 'approved', attemptId: null, retryAt: null });
    }
  }

  // Building what the window shows

  private info(routine: Routine, now: Date, usage: Map<string, Usage>): RoutineInfo {
    const { definition } = routine;
    const zone = this.zoneOf(definition);
    const upcoming =
      routine.status === 'paused' || routine.status === 'done'
        ? []
        : this.upcoming(definition.trigger, zone, now, 5);
    const start = upcoming[0] ?? now;
    const { problems, warnings } = this.check(routine.projectId, definition, now, start);
    const last = this.store.runsOf(routine.id, 1).find((r) => r.status !== 'scheduled');
    return {
      ...routine,
      triggerText: isTimeZone(zone) ? triggerWords(definition.trigger, zone, now) : '',
      zone,
      nextRuns: upcoming,
      timings: isTimeZone(zone)
        ? stepTimes(definition, start, zone).map((t) => ({
            stepId: t.stepId,
            at: t.at,
            why: t.why,
          }))
        : [],
      problems,
      warnings,
      missedPolicy: missedPolicyOf(definition),
      lastRun: last
        ? {
            status: last.status,
            at: last.endedAt ?? last.startedAt ?? last.scheduledFor,
            reason: last.reason,
          }
        : null,
      monthUsage: usage.size > 0 ? this.monthUsage(routine, now, usage) : emptyUsage(),
    };
  }

  private runInfo(
    run: StoredRun,
    names: Map<string, string>,
    tickets: Ticket[],
    usage: Map<string, Usage>,
  ): RoutineRunInfo {
    const { notified: _notified, reminded: _reminded, ...rest } = run;
    const made: RunTicketInfo[] = [];
    for (const [stepId, ticketId] of Object.entries(run.ticketIds)) {
      const ticket = tickets.find((t) => t.id === ticketId);
      if (!ticket) continue;
      made.push({
        stepId,
        ticketId,
        key: ticket.key,
        title: ticket.title,
        clankId: ticket.assignee,
        column: columnOf(ticket),
        state: ticket.state,
        dueAt: ticket.routine?.dueAt ?? null,
      });
    }
    return {
      ...rest,
      routineName: names.get(run.routineId) ?? 'A deleted routine',
      tickets: made,
      actions: this.store.actionsOf(run.id).map((a) => this.actionInfo(a, names, tickets)),
      usage: this.sum(Object.values(run.ticketIds), usage),
    };
  }

  private actionInfo(
    action: StoredAction,
    names: Map<string, string>,
    tickets: Ticket[],
  ): ScheduledActionInfo {
    const { attemptId: _attemptId, retryAt: _retryAt, ...rest } = action;
    const info = this.options.integrations.operationInfo(
      action.integrationId,
      action.operationId,
      action.connectionId,
    );
    const run = action.runId ? this.store.run(action.runId) : undefined;
    const ticket = action.ticketId ? tickets.find((t) => t.id === action.ticketId) : undefined;
    const field = textField(action.payload);
    const problems: string[] = [];
    const open = ['pending_approval', 'approved'].includes(action.status);
    if (!info) problems.push(`${action.integrationId} isn't installed any more.`);
    else if (info.problem && open) problems.push(info.problem);
    if (open && action.error && action.status === 'pending_approval') problems.push(action.error);
    return {
      ...rest,
      routineId: run?.routineId ?? null,
      source: run
        ? (names.get(run.routineId) ?? 'A deleted routine')
        : ticket
          ? `${ticket.key}: ${ticket.title}`
          : 'A campaign',
      integrationName: info?.integrationName ?? action.integrationId,
      operationSummary: info?.summary ?? action.operationId,
      connectionLabel: info?.connectionLabel ?? null,
      mode: info?.mode ?? null,
      risk: info?.risk ?? null,
      text: field && action.payload ? String(action.payload[field]) : null,
      fields: Object.entries(action.payload ?? {})
        .filter(([name]) => name !== field)
        .map(([name, value]) => ({
          name,
          value: isMediaMarker(value)
            ? (action.media.find((m) => m.sha256 === value.$media)?.name ?? 'A file')
            : typeof value === 'string'
              ? value
              : JSON.stringify(value),
        })),
      canHandOff: info?.schedule !== null && info?.schedule !== undefined,
      problems,
    };
  }

  private needs(
    projectId: string,
    routines: Routine[],
    runs: StoredRun[],
    actions: ScheduledActionInfo[],
  ): RoutineNeed[] {
    const needs: RoutineNeed[] = [];
    const name = (id: string | null) =>
      routines.find((r) => r.id === id)?.definition.name ?? 'A routine';
    for (const run of runs) {
      if (run.status === 'awaiting_approval') {
        const waiting = actions.filter(
          (a) => a.runId === run.id && a.status === 'pending_approval',
        );
        needs.push({
          kind: 'approve',
          projectId,
          routineId: run.routineId,
          runId: run.id,
          actionId: null,
          text: `${name(run.routineId)}: ${this.count(waiting.length, 'action')} to approve`,
          at: run.startedAt ?? run.createdAt,
        });
      } else if (run.status === 'missed' && run.asks) {
        needs.push({
          kind: 'missed',
          projectId,
          routineId: run.routineId,
          runId: run.id,
          actionId: null,
          text: `${name(run.routineId)} was missed. Run it now, or skip it.`,
          at: run.scheduledFor,
        });
      }
    }
    for (const action of actions) {
      if (!['unknown', 'missed', 'failed'].includes(action.status)) continue;
      // One that was never approved and whose run moved on isn't waiting on anything.
      needs.push({
        kind: action.status as 'unknown' | 'missed' | 'failed',
        projectId,
        routineId: action.routineId,
        runId: action.runId,
        actionId: action.id,
        text:
          action.status === 'unknown'
            ? `${action.source}: did its ${action.integrationName} action go out?`
            : `${action.source}: its ${action.integrationName} action ${action.status === 'missed' ? 'was missed' : 'failed'}`,
        at: action.executeAt,
      });
    }
    for (const routine of routines) {
      if (routine.status === 'draft' && routine.createdBy !== 'user') {
        needs.push({
          kind: 'draft',
          projectId,
          routineId: routine.id,
          runId: null,
          actionId: null,
          text: `${this.crewNames(projectId)(routine.createdBy)} drafted "${routine.definition.name}". Look it over and activate it.`,
          at: routine.updatedAt,
        });
      }
    }
    return needs.sort((a, b) => +a.at - +b.at);
  }

  private coming(
    projectId: string,
    routines: RoutineInfo[],
    actions: ScheduledActionInfo[],
    now: Date,
  ): ComingUp[] {
    const coming: ComingUp[] = [];
    if (!this.paused()) {
      for (const routine of routines) {
        if (routine.status !== 'active') continue;
        for (const at of routine.nextRuns) {
          coming.push({
            kind: 'run',
            projectId,
            routineId: routine.id,
            runId: null,
            actionId: null,
            at,
            title: routine.definition.name,
            status: null,
          });
        }
      }
    }
    for (const action of actions) {
      if (!['pending_approval', 'approved'].includes(action.status)) continue;
      if (+action.executeAt < +now) continue;
      coming.push({
        kind: 'action',
        projectId,
        routineId: action.routineId,
        runId: action.runId,
        actionId: action.id,
        at: action.executeAt,
        title: `${action.operationSummary.replace(/\.$/, '')}${action.connectionLabel ? ` as ${action.connectionLabel}` : ''}`,
        status: action.status,
      });
    }
    return coming.sort((a, b) => +a.at - +b.at).slice(0, 60);
  }

  // Helpers

  private read(definition: unknown): RoutineDefinition {
    try {
      return readDefinition(definition, { now: this.now(), zone: this.userZone() });
    } catch (error) {
      if (error instanceof RoutineFormatError) throw new RoutineError(error.message);
      throw error;
    }
  }

  private check(
    projectId: string,
    definition: RoutineDefinition,
    now: Date,
    start?: Date,
  ): { problems: string[]; warnings: string[] } {
    return checkDefinition(definition, {
      crew: this.options.projects.clanks(projectId).map((c) => ({
        id: c.id,
        name: c.name,
        outputs: c.frontmatter.outputs,
      })),
      integrations: this.options.integrations.forRoutines(projectId),
      zone: this.zoneOf(definition),
      now,
      start: start ?? null,
    });
  }

  /** The next few times a trigger fires after an instant. */
  private upcoming(
    trigger: RoutineDefinition['trigger'],
    zone: string,
    after: Date,
    count: number,
  ): Date[] {
    if (!isTimeZone(zone)) return [];
    if (trigger.kind === 'cron') {
      try {
        return nextRuns(parseCron(trigger.cron), after, zone, count);
      } catch (error) {
        if (error instanceof CronError) return [];
        throw error;
      }
    }
    if (trigger.kind === 'once') {
      const at = onceInstant(trigger.at, zone);
      return at && +at > +after ? [at] : [];
    }
    return [];
  }

  /** When an active routine next runs, after an instant. Null for one the clock doesn't start. */
  private nextFor(routine: Pick<Routine, 'definition'>, after: Date): Date | null {
    const { trigger } = routine.definition;
    const zone = this.zoneOf(routine.definition);
    if (trigger.kind === 'cron' && isTimeZone(zone)) {
      try {
        return nextRun(parseCron(trigger.cron), after, zone);
      } catch {
        return null;
      }
    }
    return this.upcoming(trigger, zone, after, 1)[0] ?? null;
  }

  /** Every routine was let go on after a pause: each starts from now, with nothing owed. */
  private resumeAll(): void {
    const now = this.now();
    for (const routine of this.store.routines()) {
      if (routine.status !== 'active') continue;
      this.store.updateRoutine(routine.id, { nextRunAt: this.nextFor(routine, now) });
    }
  }

  private pauseFor(routine: Routine, reason: string): void {
    this.store.updateRoutine(routine.id, {
      status: 'paused',
      pausedReason: reason,
      nextRunAt: null,
      updatedAt: this.now(),
    });
    this.notify({
      kind: 'paused',
      title: `${routine.definition.name} is paused`,
      body: short(reason, 200),
      projectId: routine.projectId,
      routineId: routine.id,
      runId: null,
      actionId: null,
    });
  }

  private newRun(
    routine: Routine,
    scheduledFor: Date,
    trigger: RunTrigger,
    inputs: Record<string, string>,
    status: RoutineRunStatus,
  ): StoredRun {
    return {
      id: randomUUID(),
      routineId: routine.id,
      projectId: routine.projectId,
      scheduledFor,
      trigger,
      inputs,
      status,
      reason: null,
      asks: false,
      ticketIds: {},
      notified: false,
      reminded: false,
      startedAt: null,
      endedAt: null,
      createdAt: this.now(),
    };
  }

  /** A routine's runs that are still going, besides one. */
  private going(routineId: string, except?: string): StoredRun[] {
    return this.store
      .runsOf(routineId)
      .filter((r) => GOING.includes(r.status) && r.id !== except)
      .sort((a, b) => +a.scheduledFor - +b.scheduledFor);
  }

  private monthUsage(routine: Routine, now: Date, usage?: Map<string, Usage>): Usage {
    const zone = this.zoneOf(routine.definition);
    const month = dateIn(now, isTimeZone(zone) ? zone : 'UTC').slice(0, 7);
    const runs = this.store
      .runsSince(routine.id, new Date(+now - 32 * 86_400_000))
      .filter((r) => dateIn(r.createdAt, isTimeZone(zone) ? zone : 'UTC').startsWith(month));
    return this.sum(
      runs.flatMap((r) => Object.values(r.ticketIds)),
      usage ?? this.options.board.ticketUsage(routine.projectId),
    );
  }

  private sum(ticketIds: string[], usage: Map<string, Usage>): Usage {
    const total = emptyUsage();
    for (const id of ticketIds) {
      const spent = usage.get(id);
      if (!spent) continue;
      total.tokens += spent.tokens;
      total.ms += spent.ms;
      total.dollars += spent.dollars;
      total.unpriced += spent.unpriced;
    }
    return total;
  }

  private find<T extends Pick<Routine, 'id' | 'definition'>>(
    routines: T[],
    ref: string,
  ): T | undefined {
    const wanted = ref.trim().toLowerCase();
    return (
      routines.find((r) => r.id === wanted) ??
      routines.find((r) => r.definition.name.toLowerCase() === wanted) ??
      routines.find((r) => r.definition.name.toLowerCase().includes(wanted) && wanted.length >= 3)
    );
  }

  private crewNames(projectId: string): (id: string) => string {
    const crew = this.options.projects.clanks(projectId);
    return (id) => crew.find((c) => c.id === id)?.name ?? id;
  }

  private requireRun(id: string): StoredRun {
    const run = this.store.run(id);
    if (!run) throw new RoutineError('That run is gone');
    return run;
  }

  private requireAction(id: string): StoredAction {
    const action = this.store.action(id);
    if (!action) throw new RoutineError('That action is gone');
    return action;
  }

  /** A time for a run that starts now, that no other run of the routine has: each is its own. */
  private free(routineId: string): Date {
    let at = +this.now();
    while (this.store.runAt(routineId, new Date(at))) at += 1;
    return new Date(at);
  }

  private notify(notice: RoutineNotice): void {
    this.emit('notice', notice);
  }

  private count(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
  }

  private paused(): boolean {
    return this.options.settings.get().routinesPaused;
  }

  /** The user's own time zone: their profile's, or this computer's. */
  private userZone(): string {
    return this.options.settings.get().profile.timeZone || localZone();
  }

  private zoneOf(definition: Pick<RoutineDefinition, 'timeZone'>): string {
    return definition.timeZone || this.userZone();
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/** What channels are called besides their integration's own name. */
const CHANNEL_NAMES: Record<string, string[]> = {
  xcom: ['x', 'twitter', 'xtwitter', 'twitterx', 'xcom'],
};

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function logged(error: unknown): void {
  console.error('A routine step failed', error);
}

/** The field of a payload that holds its words, if one does. */
function textField(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  return (
    ['text', 'body', 'message', 'content', 'status'].find(
      (name) => typeof payload[name] === 'string',
    ) ?? null
  );
}

function textOf(payload: Record<string, unknown> | null): string | null {
  const field = textField(payload);
  return field && payload ? String(payload[field]) : null;
}

/** What a ticket handed in, as templates read it: a design's frames by name, each with its PNG. */
function outputView(ticket: Ticket): Record<string, unknown> {
  const output = ticket.output ?? {};
  if (ticket.type === 'campaign') {
    // Its words, for a routine with one post: the first post's.
    const [first] = postsOf(output);
    return first ? { ...output, text: first.text } : output;
  }
  if (ticket.type !== 'design') return output;
  const frames: Record<string, unknown> = {};
  for (const name of designedFrames([ticket])) {
    frames[name] = { name, png: { $frame: { ticketId: ticket.id, name } } };
  }
  // Its picture, for a routine with one banner: the first frame's.
  const [first] = Object.values(frames) as { png: unknown }[];
  return { ...output, frames, ...(first ? { image: first.png } : {}) };
}

/** What a service's answer says about what was made: its id, and a link where there's one. */
function resultOf(
  body: unknown,
  link: string | null,
  handedOff: boolean,
): NonNullable<StoredAction['result']> {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const inner = (
    typeof record.data === 'object' && record.data !== null ? record.data : record
  ) as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;
  const url = [link, inner.url, inner.html_url, inner.permalink, inner.link]
    .map(text)
    .find((v): v is string => v !== null && /^https:\/\//i.test(v));
  return {
    id: text(inner.id) ?? text(record.id),
    url: url ?? null,
    summary: short(typeof body === 'string' ? body : JSON.stringify(body ?? {}), 400),
    handedOff,
  };
}
