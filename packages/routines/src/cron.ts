import { daysInMonth, instantOf, wallAt, wallNumber, weekdayOf } from './zone';

/** A schedule that can't be read, worded for whoever wrote it. */
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

/**
 * A five-field cron expression: minute, hour, day of month, month, day of week. Besides the usual
 * lists, ranges and steps, the day of month takes `L` for the month's last day, and the day of
 * week takes `2#2` for the second Tuesday and `5L` for the last Friday.
 */
export interface Cron {
  source: string;
  minutes: number[];
  hours: number[];
  months: number[];
  days: { any: boolean; values: number[]; last: boolean };
  weekdays: {
    any: boolean;
    values: number[];
    /** The nth of a weekday in the month. */
    nth: { weekday: number; n: number }[];
    /** The last of a weekday in the month. */
    last: number[];
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function numberIn(text: string, what: string, min: number, max: number, names?: string[]): number {
  const named = names?.indexOf(text.toLowerCase().slice(0, 3)) ?? -1;
  if (named !== -1 && /^[a-z]{3,9}$/i.test(text)) return named + (names === MONTHS ? 1 : 0);
  if (!/^\d{1,2}$/.test(text)) throw new CronError(`"${text}" isn't a ${what}`);
  const value = Number(text);
  if (value < min || value > max) {
    throw new CronError(`The ${what} must be between ${min} and ${max}, not ${value}`);
  }
  return value;
}

/** The values one part of a field covers: `*`, `5`, `1-5`, `*\/15`, `10-40/10`, `5/10`. */
function expand(part: string, what: string, min: number, max: number, names?: string[]): number[] {
  const [range = '', stepText] = part.split('/') as [string, string | undefined];
  let step = 1;
  if (stepText !== undefined) {
    if (!/^\d{1,3}$/.test(stepText) || Number(stepText) === 0) {
      throw new CronError(`"${part}" has no step after the "/"`);
    }
    step = Number(stepText);
  }
  let from: number;
  let to: number;
  if (range === '*') {
    from = min;
    to = max;
  } else if (range.includes('-')) {
    const [a = '', b = ''] = range.split('-');
    from = numberIn(a, what, min, max, names);
    to = numberIn(b, what, min, max, names);
    if (from > to) throw new CronError(`"${range}" runs backwards`);
  } else {
    from = numberIn(range, what, min, max, names);
    to = stepText === undefined ? from : max;
  }
  const values: number[] = [];
  for (let value = from; value <= to; value += step) values.push(value);
  return values;
}

function field(text: string, what: string, min: number, max: number, names?: string[]): number[] {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    if (part === '') throw new CronError(`The ${what} has an empty entry`);
    for (const value of expand(part, what, min, max, names)) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** Reads a cron expression. Throws a `CronError` saying what's wrong with it. */
export function parseCron(source: string): Cron {
  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      `A schedule has five parts: minute, hour, day of the month, month and day of the week. "${source.trim()}" has ${fields.length}.`,
    );
  }
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];

  const days: Cron['days'] = { any: day === '*', values: [], last: false };
  const plainDays: string[] = [];
  for (const part of day.split(',')) {
    if (/^L$/i.test(part)) days.last = true;
    else plainDays.push(part);
  }
  if (plainDays.length > 0) days.values = field(plainDays.join(','), 'day of the month', 1, 31);

  const weekdays: Cron['weekdays'] = { any: weekday === '*', values: [], nth: [], last: [] };
  const plainWeekdays: string[] = [];
  // Sunday is 0, and 7 as well.
  const dayNumber = (text: string) => numberIn(text, 'day of the week', 0, 7, WEEKDAYS) % 7;
  for (const part of weekday.split(',')) {
    const nth = /^([a-z0-9]+)#(\d)$/i.exec(part);
    const last = /^([a-z0-9]+)L$/i.exec(part);
    if (nth) {
      const n = Number(nth[2]);
      if (n < 1 || n > 5) throw new CronError(`"${part}": a month has a 1st to a 5th of a weekday`);
      weekdays.nth.push({ weekday: dayNumber(nth[1]!), n });
    } else if (last && !/^[a-z]+$/i.test(part)) {
      weekdays.last.push(dayNumber(last[1]!));
    } else {
      plainWeekdays.push(part);
    }
  }
  if (plainWeekdays.length > 0) {
    weekdays.values = [
      ...new Set(
        field(plainWeekdays.join(','), 'day of the week', 0, 7, WEEKDAYS).map((d) => d % 7),
      ),
    ].sort((a, b) => a - b);
  }

  return {
    source: fields.join(' '),
    minutes: field(minute, 'minute', 0, 59),
    hours: field(hour, 'hour', 0, 23),
    months: field(month, 'month', 1, 12, MONTHS),
    days,
    weekdays,
  };
}

/** Why an expression isn't a schedule, or null when it is. */
export function cronProblem(source: string): string | null {
  try {
    const cron = parseCron(source);
    // One that names only days no month has, such as 31 February, would never run.
    if (!cron.days.any && cron.weekdays.any && !cron.days.last) {
      const longest = Math.max(
        ...cron.months.map((m) => (m === 2 ? 29 : [4, 6, 9, 11].includes(m) ? 30 : 31)),
      );
      if (cron.days.values.every((d) => d > longest)) return 'No month it names has that day';
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Whether a schedule runs on a date. A day of the month and a day of the week: either will do. */
export function runsOn(cron: Cron, year: number, month: number, day: number): boolean {
  if (!cron.months.includes(month)) return false;
  const length = daysInMonth(year, month);
  const weekday = weekdayOf(year, month, day);
  const byDay = cron.days.values.includes(day) || (cron.days.last && day === length);
  const byWeekday =
    cron.weekdays.values.includes(weekday) ||
    cron.weekdays.nth.some((n) => n.weekday === weekday && Math.ceil(day / 7) === n.n) ||
    cron.weekdays.last.some((w) => w === weekday && day + 7 > length);
  if (cron.days.any && cron.weekdays.any) return true;
  if (cron.days.any) return byWeekday;
  if (cron.weekdays.any) return byDay;
  return byDay || byWeekday;
}

/** How far ahead to look for a schedule's next time: far enough for 29 February. */
const HORIZON_DAYS = 366 * 8 + 2;

/**
 * The first time a schedule runs after an instant, in a zone. Times are the zone's own, so 09:00
 * stays 09:00 across daylight-saving changes; a time the clocks skip runs at the next minute that
 * exists, and one that happens twice runs once, the first time. Null when it never runs again.
 */
export function nextRun(cron: Cron, after: number | Date, zone: string): Date | null {
  const from = +after;
  const start = wallAt(from, zone);
  const startNumber = wallNumber(start);
  const first = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const date = new Date(first + i * 86_400_000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!runsOn(cron, year, month, day)) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        // A time the clocks already showed can't be still to come: it ran, or was the first of two.
        if (Date.UTC(year, month - 1, day, hour, minute) <= startNumber) continue;
        const instant = instantOf({ year, month, day, hour, minute }, zone);
        if (instant > from) return new Date(instant);
      }
    }
  }
  return null;
}

/** The next few times a schedule runs after an instant. */
export function nextRuns(cron: Cron, after: number | Date, zone: string, count: number): Date[] {
  const runs: Date[] = [];
  let from = +after;
  while (runs.length < count) {
    const next = nextRun(cron, from, zone);
    if (!next) break;
    runs.push(next);
    from = +next;
  }
  return runs;
}

/**
 * Every time a schedule came due after one instant, up to and including another, oldest first,
 * and how many more there were than `limit` allows for.
 */
export function runsBetween(
  cron: Cron,
  after: number | Date,
  until: number | Date,
  zone: string,
  limit = 500,
): { runs: Date[]; more: boolean } {
  const runs: Date[] = [];
  let from = +after;
  for (;;) {
    const next = nextRun(cron, from, zone);
    if (!next || +next > +until) return { runs, more: false };
    if (runs.length >= limit) return { runs, more: true };
    runs.push(next);
    from = +next;
  }
}
