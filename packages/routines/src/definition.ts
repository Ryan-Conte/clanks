import {
  type RoutineDefinition,
  type RoutineDefinitionInput,
  type RoutineTrigger,
  routineDefinitionSchema,
} from '@clanks/core';
import { parse as parseYaml, stringify } from 'yaml';
import { z } from 'zod';
import { parseSchedule } from './words';

/** A routine that can't be read, worded for whoever wrote it. */
export class RoutineFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutineFormatError';
  }
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A field under either of the names it's written by: `depends_on` in YAML, `dependsOn` in code. */
function pick(record: Raw, ...names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name];
  }
  return undefined;
}

/** Small models write an object or a list as JSON inside a string. */
function unwrap(value: unknown): unknown {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function lines(value: unknown): unknown {
  const given = unwrap(value);
  if (typeof given === 'string') {
    return given
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
      .filter(Boolean);
  }
  return given;
}

function budget(value: unknown): unknown {
  const given = unwrap(value);
  if (!isRecord(given)) return given ?? null;
  const number = (name: string) => {
    const raw = given[name];
    const parsed = typeof raw === 'string' ? Number(raw.replace(/[_,\s]/g, '')) : raw;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
  };
  const filled = {
    tokens: number('tokens'),
    minutes: number('minutes'),
    dollars: number('dollars'),
  };
  return Object.values(filled).every((v) => v === null) ? null : filled;
}

function trigger(
  value: unknown,
  schedule: unknown,
  options: { now: number | Date; zone: string },
): unknown {
  const words = text(schedule) ?? text(value);
  if (words !== undefined) {
    return (
      parseSchedule(words, options) ??
      // Left as it is, so the check says what's wrong with it rather than that it's missing.
      ({ kind: 'cron', cron: words } satisfies RoutineTrigger)
    );
  }
  const given = unwrap(value);
  if (!isRecord(given)) return given;
  const kind =
    text(given.kind) ??
    (given.cron !== undefined
      ? 'cron'
      : given.at !== undefined
        ? 'once'
        : given.event !== undefined
          ? 'event'
          : 'manual');
  if (kind === 'cron') return { kind, cron: text(given.cron) ?? '' };
  if (kind === 'once') {
    const at = given.at instanceof Date ? given.at.toISOString().slice(0, 16) : text(given.at);
    return { kind, at: (at ?? '').replace(' ', 'T').slice(0, 16) };
  }
  if (kind === 'event') {
    const filters: Record<string, string> = {};
    const listed = unwrap(given.filters);
    if (isRecord(listed)) {
      for (const [name, entry] of Object.entries(listed)) {
        const said = text(entry);
        if (said !== undefined) filters[name] = said;
      }
    }
    // `match` is how a tag pattern is written; the other filters go by name.
    const match = text(given.match);
    if (match !== undefined) filters.pattern = match;
    for (const name of ['type', 'clank', 'base', 'routine', 'status', 'pattern']) {
      const said = text(given[name]);
      if (said !== undefined) filters[name] = said;
    }
    return { kind, event: text(given.event) ?? '', filters };
  }
  return { kind };
}

function step(value: unknown): unknown {
  const given = unwrap(value);
  if (!isRecord(given)) return given;
  const out: Raw = { id: text(given.id) ?? '' };
  const deps = unwrap(pick(given, 'dependsOn', 'depends_on'));
  if (deps !== undefined) out.dependsOn = typeof deps === 'string' ? [deps] : deps;
  const ticket = unwrap(given.ticket);
  if (isRecord(ticket)) {
    out.ticket = {
      clank: (text(ticket.clank) ?? '').toLowerCase(),
      type: text(ticket.type) ?? '',
      title: text(ticket.title) ?? '',
      ...(ticket.description !== undefined ? { description: text(ticket.description) ?? '' } : {}),
      ...(ticket.criteria !== undefined ? { criteria: lines(ticket.criteria) } : {}),
      ...(pick(ticket, 'due') !== undefined ? { due: text(ticket.due) } : {}),
    };
  }
  const action = unwrap(given.action);
  if (isRecord(action)) {
    const payload = unwrap(action.payload);
    out.action = {
      integration: text(action.integration) ?? '',
      operation: text(action.operation) ?? '',
      ...(action.connection !== undefined ? { connection: text(action.connection) ?? '' } : {}),
      at: text(action.at) ?? '',
      ...(payload !== undefined ? { payload } : {}),
      ...(action.deliver !== undefined ? { deliver: text(action.deliver) } : {}),
    };
  }
  return out;
}

/**
 * A routine as someone wrote it, in YAML or as a clank's tool call, put into the shape the app
 * keeps: either spelling of each field, a schedule in plain words, lists written as lines.
 * Nothing is checked here; `readDefinition` does that.
 */
export function normalizeDefinition(
  value: unknown,
  options: { now: number | Date; zone: string },
): unknown {
  const given = unwrap(value);
  if (!isRecord(given)) return given;
  const rawTrigger = unwrap(given.trigger);
  const zone =
    text(pick(given, 'timeZone', 'time_zone')) ??
    (isRecord(rawTrigger) ? text(pick(rawTrigger, 'timeZone', 'time_zone')) : undefined);
  const out: Raw = {
    name: text(given.name) ?? '',
    trigger: trigger(rawTrigger, given.schedule, { now: options.now, zone: zone || options.zone }),
  };
  if (given.description !== undefined) out.description = text(given.description) ?? '';
  if (zone !== undefined) out.timeZone = zone;
  const inputs = unwrap(given.inputs);
  if (isRecord(inputs)) {
    out.inputs = Object.fromEntries(
      Object.entries(inputs).map(([name, entry]) => [name, text(entry) ?? JSON.stringify(entry)]),
    );
  }
  const steps = unwrap(given.steps);
  out.steps = Array.isArray(steps) ? steps.map(step) : steps;
  const approval = unwrap(given.approval);
  if (isRecord(approval)) {
    const remind = text(pick(approval, 'remindBefore', 'remind_before'));
    if (remind !== undefined) out.approval = { remindBefore: remind };
  }
  const timing = unwrap(given.timing);
  if (isRecord(timing)) {
    const buffer = text(pick(timing, 'reviewBuffer', 'review_buffer'));
    if (buffer !== undefined) out.timing = { reviewBuffer: buffer };
  }
  const missed = unwrap(given.missed);
  if (isRecord(missed)) {
    out.missed = {
      ...(missed.policy !== undefined ? { policy: text(missed.policy) ?? null } : {}),
      ...(missed.grace !== undefined ? { grace: text(missed.grace) } : {}),
    };
  } else if (typeof missed === 'string') out.missed = { policy: missed };
  if (given.concurrency !== undefined) out.concurrency = text(given.concurrency);
  const money = unwrap(given.budget);
  if (isRecord(money)) {
    out.budget = {
      perRun: budget(pick(money, 'perRun', 'per_run')),
      perMonth: budget(pick(money, 'perMonth', 'per_month')),
    };
  }
  return out;
}

/** Checks a routine against its schema. Throws a `RoutineFormatError` listing what's wrong. */
export function readDefinition(
  value: unknown,
  options: { now: number | Date; zone: string },
): RoutineDefinition {
  const parsed = routineDefinitionSchema.safeParse(normalizeDefinition(value, options));
  if (!parsed.success) throw new RoutineFormatError(z.prettifyError(parsed.error));
  return parsed.data;
}

/** Reads a routine from YAML: how routines are exported, imported and shared. */
export function routineFromYaml(
  yaml: string,
  options: { now: number | Date; zone: string },
): RoutineDefinition {
  let data: unknown;
  try {
    data = parseYaml(yaml.charCodeAt(0) === 0xfeff ? yaml.slice(1) : yaml);
  } catch (error) {
    throw new RoutineFormatError(
      `That isn't YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    );
  }
  if (!isRecord(data)) throw new RoutineFormatError('A routine is a YAML mapping, with a name');
  return readDefinition(data, options);
}

/** A routine as YAML, leaving out whatever is as it would be anyway. */
export function routineToYaml(definition: RoutineDefinition): string {
  const { trigger: when } = definition;
  const out: Raw = { name: definition.name };
  if (definition.description) out.description = definition.description;
  const zone = definition.timeZone ? { time_zone: definition.timeZone } : {};
  if (when.kind === 'cron') out.trigger = { kind: 'cron', cron: when.cron, ...zone };
  else if (when.kind === 'once') out.trigger = { kind: 'once', at: when.at, ...zone };
  else if (when.kind === 'event') {
    const { pattern, ...filters } = when.filters;
    out.trigger = {
      kind: 'event',
      event: when.event,
      ...(pattern ? { match: pattern } : {}),
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
    };
  } else out.trigger = { kind: 'manual' };
  if (Object.keys(definition.inputs).length > 0) out.inputs = definition.inputs;
  out.steps = definition.steps.map((s) => {
    const entry: Raw = { id: s.id };
    if (s.dependsOn.length > 0) entry.depends_on = s.dependsOn;
    if (s.ticket) {
      entry.ticket = {
        clank: s.ticket.clank,
        type: s.ticket.type,
        title: s.ticket.title,
        ...(s.ticket.description ? { description: s.ticket.description } : {}),
        ...(s.ticket.criteria.length > 0 ? { criteria: s.ticket.criteria } : {}),
        ...(s.ticket.due ? { due: s.ticket.due } : {}),
      };
    }
    if (s.action) {
      entry.action = {
        integration: s.action.integration,
        operation: s.action.operation,
        ...(s.action.connection ? { connection: s.action.connection } : {}),
        at: s.action.at,
        ...(Object.keys(s.action.payload).length > 0 ? { payload: s.action.payload } : {}),
        ...(s.action.deliver !== 'at_time' ? { deliver: s.action.deliver } : {}),
      };
    }
    return entry;
  });
  if (definition.approval.remindBefore !== '30m') {
    out.approval = { remind_before: definition.approval.remindBefore };
  }
  if (definition.timing.reviewBuffer !== '1h') {
    out.timing = { review_buffer: definition.timing.reviewBuffer };
  }
  if (definition.missed.policy || definition.missed.grace !== '15m') {
    out.missed = {
      ...(definition.missed.policy ? { policy: definition.missed.policy } : {}),
      ...(definition.missed.grace !== '15m' ? { grace: definition.missed.grace } : {}),
    };
  }
  if (definition.concurrency !== 'skip') out.concurrency = definition.concurrency;
  const { perRun, perMonth } = definition.budget;
  if (perRun || perMonth) {
    const trim = (limit: NonNullable<typeof perRun>) =>
      Object.fromEntries(Object.entries(limit).filter(([, v]) => v !== null));
    out.budget = {
      ...(perRun ? { per_run: trim(perRun) } : {}),
      ...(perMonth ? { per_month: trim(perMonth) } : {}),
    };
  }
  return stringify(out, { lineWidth: 100 });
}

export type { RoutineDefinitionInput };
