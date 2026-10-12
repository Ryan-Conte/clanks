import { ROUTINE_EVENT_INFO, type RoutineTrigger } from '@clanks/core';
import { type Cron, CronError, parseCron } from './cron';
import {
  type Wall,
  instantOf,
  localStamp,
  pad,
  parseStamp,
  wallAt,
  wallNumber,
  wallOf,
} from './zone';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;
}

function nth(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

function everyStep(values: number[], size: number): number | null {
  if (values.length < 2 || values[0] !== 0) return null;
  const step = values[1]! - values[0];
  if (size % step !== 0 || values.length !== size / step) return null;
  return values.every((v, i) => v === i * step) ? step : null;
}

/** The times of day a schedule runs at, when there are few enough to say. */
function timesOf(cron: Cron): string | null {
  if (cron.hours.length * cron.minutes.length > 4) return null;
  return list(cron.hours.flatMap((h) => cron.minutes.map((m) => `${pad(h)}:${pad(m)}`)));
}

/** The days a schedule runs on, as the start of a sentence: "Fridays", "Every weekday". */
function daysOf(cron: Cron): string {
  const { days, weekdays } = cron;
  const parts: string[] = [];
  if (!days.any) {
    const named = days.values.map(nth);
    if (days.last) named.push('last day');
    parts.push(`On the ${list(named)} of every month`);
  }
  if (!weekdays.any) {
    const set = weekdays.values;
    if (weekdays.nth.length > 0 || weekdays.last.length > 0) {
      const named = [
        ...weekdays.nth.map((n) => `${ORDINALS[n.n - 1]!} ${DAY_NAMES[n.weekday]!}`),
        ...weekdays.last.map((w) => `last ${DAY_NAMES[w]!}`),
      ];
      parts.push(`On the ${list(named)} of every month`);
    }
    if (set.length === 7) parts.push('Every day');
    else if (set.join() === '1,2,3,4,5') parts.push('Every weekday');
    else if (set.join() === '0,6') parts.push('Saturdays and Sundays');
    else if (set.length > 0) {
      // Monday first, as people list them.
      const ordered = [...set].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      parts.push(list(ordered.map((d) => `${DAY_NAMES[d]!}s`)));
    }
  }
  if (parts.length === 0) return 'Every day';
  // A day of the month and a day of the week: it runs on either.
  return parts.length === 1 ? parts[0]! : `${parts[0]!}, and ${lower(parts[1]!)}`;
}

function lower(text: string): string {
  return /^(On|Every)\b/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** A cron expression in words: "Fridays at 13:00", "Every 15 minutes". */
export function cronWords(source: string): string {
  let cron: Cron;
  try {
    cron = parseCron(source);
  } catch {
    return source;
  }
  const months =
    cron.months.length === 12 ? '' : `, in ${list(cron.months.map((m) => MONTH_NAMES[m - 1]!))}`;
  const everyDay = cron.days.any && cron.weekdays.any;
  const minuteStep = everyStep(cron.minutes, 60);
  const hourStep = everyStep(cron.hours, 24);
  const allHours = cron.hours.length === 24;
  let often: string | null = null;
  if (allHours && cron.minutes.length === 60) often = 'Every minute';
  else if (allHours && minuteStep) often = `Every ${minuteStep} minutes`;
  else if (allHours && cron.minutes.length === 1) {
    often = cron.minutes[0] === 0 ? 'Every hour' : `Every hour at ${cron.minutes[0]} minutes past`;
  } else if (hourStep && cron.minutes.length === 1 && cron.minutes[0] === 0) {
    often = `Every ${hourStep} hours`;
  }
  if (often) return `${often}${everyDay ? '' : `, ${lower(daysOf(cron))}`}${months}`;
  const times = timesOf(cron);
  if (!times) return `${daysOf(cron)}${months}, at the times in "${cron.source}"`;
  return `${daysOf(cron)} at ${times}${months}`;
}

/** What starts a routine, in words. */
export function triggerWords(trigger: RoutineTrigger, zone: string, now: number | Date): string {
  if (trigger.kind === 'manual') return 'Only when you run it';
  if (trigger.kind === 'cron') return `${cronWords(trigger.cron)} (${zone})`;
  if (trigger.kind === 'once') {
    const wall = parseStamp(trigger.at);
    if (!wall) return `Once, at ${trigger.at}`;
    const sameYear = wall.year === wallAt(now, zone).year;
    const day = `${DAY_NAMES[new Date(wallNumber(wall)).getUTCDay()]!.slice(0, 3)} ${wall.day} ${MONTH_NAMES[wall.month - 1]!.slice(0, 3)}${sameYear ? '' : ` ${wall.year}`}`;
    return `Once, on ${day} at ${pad(wall.hour)}:${pad(wall.minute)} (${zone})`;
  }
  const info = ROUTINE_EVENT_INFO[trigger.event];
  const filters = Object.entries(trigger.filters)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name} ${value}`);
  const when = info.when.charAt(0).toLowerCase() + info.when.slice(1);
  return `When ${when}${filters.length > 0 ? ` (${filters.join(', ')})` : ''}`;
}

// Schedules in plain words

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
};

/** A day of the week as people write it: Fri, Friday, Fridays, Thurs. Never the start of "month". */
const WEEKDAY = /\b(sun|mon|tue|wed|thu|fri|sat)(day|sday|nesday|rsday|urday|s|rs|r)?(s)?\b/g;

function weekdaysIn(text: string): { days: number[]; plural: boolean } {
  const days: number[] = [];
  let plural = false;
  for (const match of text.matchAll(WEEKDAY)) {
    const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(match[1]!);
    if (!days.includes(day)) days.push(day);
    // "Tues" and "Thurs" end in an s of their own, so only a whole name's s makes it plural.
    if (match[3] && match[2]?.endsWith('day')) plural = true;
  }
  return { days, plural };
}

/**
 * The time of day some words name: "at 9", "5pm", "17:30", "noon", "in the afternoon". Null when
 * they name none.
 */
function clockIn(text: string): { hour: number; minute: number } | null {
  if (/\bnoon\b|\bmidday\b/.test(text)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(text)) return { hour: 0, minute: 0 };
  const clock =
    /\b(?:at|@)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?![\d:])/.exec(text) ??
    /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/.exec(text) ??
    /\b(\d{1,2})[:.](\d{2})\b()/.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const half = clock[3]?.replace(/\./g, '');
    if (half === 'pm' && hour < 12) hour += 12;
    if (half === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  if (/\bmorning\b/.test(text)) return { hour: 9, minute: 0 };
  if (/\bafternoon\b/.test(text)) return { hour: 13, minute: 0 };
  if (/\bevening\b/.test(text)) return { hour: 18, minute: 0 };
  if (/\bnight\b/.test(text)) return { hour: 21, minute: 0 };
  return null;
}

/** When a routine starts if its words name no time of day. */
const DEFAULT_TIME = { hour: 9, minute: 0 };

function monthIn(text: string): number | null {
  const match =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|t|tember|ober|ember)?\b/.exec(
      text,
    );
  return match
    ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
        match[1]!,
      ) + 1
    : null;
}

/**
 * Reads a schedule typed in plain words: "every weekday at 9", "first Monday of the month",
 * "tomorrow at 5pm". A cron expression or a date and time is taken as it is. Null for anything it
 * doesn't know, which goes to Atlas instead.
 */
export function parseSchedule(
  words: string,
  options: { now: number | Date; zone: string },
): RoutineTrigger | null {
  const raw = words.trim();
  if (!raw) return null;
  if (/^[\d*,/\-#L a-zA-Z]+$/.test(raw) && raw.split(/\s+/).length === 5 && /[\d*]/.test(raw)) {
    try {
      return { kind: 'cron', cron: parseCron(raw).source };
    } catch (error) {
      if (error instanceof CronError && /^[\d*]/.test(raw)) return null;
    }
  }
  const stamp = parseStamp(raw);
  if (stamp) return { kind: 'once', at: raw.replace(' ', 'T').slice(0, 16) };

  const text = raw.toLowerCase().replace(/[,;]/g, ' ').replace(/\s+/g, ' ');
  if (/^(manual(ly)?|by hand|only when i run it|on demand)$/.test(text)) return { kind: 'manual' };
  const time = clockIn(text);
  const at = time ?? DEFAULT_TIME;
  const clock = `${at.minute} ${at.hour}`;
  const named = weekdaysIn(text);
  const days = named.days;
  const repeats =
    named.plural || /\b(every|each|daily|weekly|monthly|hourly|weekdays?|weekends?)\b/.test(text);

  // Every so often
  const interval = /\bevery (\d{1,3}|[a-z]+)? ?(minute|min|hour|hr)s?\b/.exec(text);
  if (interval || /\bhourly\b/.test(text)) {
    const amount = interval?.[1];
    const n = amount === undefined ? 1 : (NUMBER_WORDS[amount] ?? Number(amount));
    const unit = interval?.[2]?.startsWith('min') ? 'minute' : 'hour';
    if (!Number.isInteger(n) || n < 1) return null;
    if (unit === 'minute') {
      if (n > 59 || 60 % n !== 0) return null;
      return { kind: 'cron', cron: n === 1 ? '* * * * *' : `*/${n} * * * *` };
    }
    if (n > 23 || 24 % n !== 0) return null;
    return { kind: 'cron', cron: n === 1 ? '0 * * * *' : `0 */${n} * * *` };
  }

  // The nth weekday, the last day or a numbered day of the month
  const ordinal = /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b/.exec(text);
  const monthly = /\b(of|in|every|each) (the |every |each )?month\b|\bmonthly\b/.test(text);
  if (ordinal && monthly) {
    const which = ordinal[1]!;
    const weekday = days[0];
    if (weekday !== undefined) {
      const n = ['first', 'second', 'third', 'fourth', 'fifth'].indexOf(
        which
          .replace('1st', 'first')
          .replace('2nd', 'second')
          .replace('3rd', 'third')
          .replace('4th', 'fourth')
          .replace('5th', 'fifth'),
      );
      return {
        kind: 'cron',
        cron: which === 'last' ? `${clock} * * ${weekday}L` : `${clock} * * ${weekday}#${n + 1}`,
      };
    }
    if (which === 'last' && /\blast (week)?day\b/.test(text) && !/weekday/.test(text)) {
      return { kind: 'cron', cron: `${clock} L * *` };
    }
  }
  const numbered = /\b(?:on )?the (\d{1,2})(?:st|nd|rd|th)\b/.exec(text);
  if (numbered && (monthly || repeats)) {
    const day = Number(numbered[1]);
    if (day < 1 || day > 31) return null;
    return { kind: 'cron', cron: `${clock} ${day} * *` };
  }
  if (/\b(every|each) month\b|\bmonthly\b/.test(text))
    return { kind: 'cron', cron: `${clock} 1 * *` };

  // Days of the week
  if (/\b(every|each) ?(week)?day\b|\bdaily\b/.test(text) && !/\bweekdays?\b/.test(text)) {
    return { kind: 'cron', cron: `${clock} * * *` };
  }
  if (/\bweekdays?\b|\bwork(ing)? ?days?\b/.test(text)) {
    return { kind: 'cron', cron: `${clock} * * 1-5` };
  }
  if (/\bweekends?\b/.test(text)) return { kind: 'cron', cron: `${clock} * * 0,6` };
  if (days.length > 0 && repeats) {
    return { kind: 'cron', cron: `${clock} * * ${[...days].sort((a, b) => a - b).join(',')}` };
  }
  if (/\b(every|each) week\b|\bweekly\b/.test(text)) {
    const today = new Date(wallNumber(wallAt(options.now, options.zone))).getUTCDay();
    return { kind: 'cron', cron: `${clock} * * ${today}` };
  }

  // Once
  const today = wallAt(options.now, options.zone);
  const dayStart = Date.UTC(today.year, today.month - 1, today.day);
  const once = (wall: Wall): RoutineTrigger => ({
    kind: 'once',
    at: `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(at.hour)}:${pad(at.minute)}`,
  });
  if (/\btomorrow\b/.test(text)) return once(wallOf(dayStart + 86_400_000));
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(text)) {
    return once(wallOf(dayStart));
  }
  const inSome = /\bin (\d{1,3}|an?|[a-z]+) (minute|min|hour|hr|day)s?\b/.exec(text);
  if (inSome) {
    const amount = inSome[1]!;
    const n = /^an?$/.test(amount) ? 1 : (NUMBER_WORDS[amount] ?? Number(amount));
    if (!Number.isInteger(n) || n < 1) return null;
    const unit = inSome[2]!.startsWith('min')
      ? 60_000
      : inSome[2]!.startsWith('h')
        ? 3_600_000
        : 86_400_000;
    return { kind: 'once', at: localStamp(+options.now + n * unit, options.zone) };
  }
  if (days.length === 1) {
    // "Friday at 5", "next Friday": the next one, today's only if its time is still to come.
    const current = new Date(dayStart).getUTCDay();
    let ahead = (days[0]! - current + 7) % 7;
    const passed = wallNumber({ ...today, hour: at.hour, minute: at.minute }) <= wallNumber(today);
    if (ahead === 0 && (passed || /\bnext\b/.test(text))) ahead = 7;
    return once(wallOf(dayStart + ahead * 86_400_000));
  }
  const month = monthIn(text);
  const dayOfMonth = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text.replace(/\bat \d.*$/, ''));
  if (month && dayOfMonth) {
    const day = Number(dayOfMonth[1]);
    const yearMatch = /\b(20\d{2})\b/.exec(text);
    let year = yearMatch ? Number(yearMatch[1]) : today.year;
    const wall = { year, month, day, hour: at.hour, minute: at.minute };
    if (!parseStamp(`${year}-${pad(month)}-${pad(day)}T00:00`)) return null;
    // A date that has passed this year means next year's.
    if (!yearMatch && wallNumber(wall) <= wallNumber(today)) year += 1;
    return once({ ...wall, year });
  }
  return null;
}

/** When a `once` trigger fires, as an instant. Null when its time isn't one. */
export function onceInstant(at: string, zone: string): Date | null {
  const wall = parseStamp(at);
  return wall ? new Date(instantOf(wall, zone)) : null;
}
