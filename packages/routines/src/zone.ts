/** A date and time as a clock on a wall shows it, in some time zone. Months and days start at 1. */
export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, found);
  }
  return found;
}

/** Whether a name is an IANA time zone this computer knows. */
export function isTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** This computer's own time zone. */
export function localZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** What the clocks in a zone show at an instant. */
export function wallAt(instant: number | Date, zone: string): Wall {
  const parts = formatter(zone).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
  };
}

/** A wall time as if it were UTC: a number to do arithmetic on, not an instant. */
export function wallNumber(wall: Wall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/** The wall time a number from `wallNumber` stands for, with overflow carried: day 32 rolls on. */
export function wallOf(number: number): Wall {
  const date = new Date(number);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function sameWall(a: Wall, b: Wall): boolean {
  return wallNumber(a) === wallNumber(b);
}

/** Every instant at which a zone's clocks show a wall time: none in a gap, two in an overlap. */
function instantsOf(wall: Wall, zone: string): number[] {
  const guess = wallNumber(wall);
  // The zone's offset a day either side covers both sides of any change in between.
  const offsets = new Set<number>();
  for (const probe of [guess - 86_400_000, guess, guess + 86_400_000]) {
    offsets.add(wallNumber(wallAt(probe, zone)) - probe);
  }
  const found: number[] = [];
  for (const offset of offsets) {
    const instant = guess - offset;
    if (sameWall(wallAt(instant, zone), wall) && !found.includes(instant)) found.push(instant);
  }
  return found.sort((a, b) => a - b);
}

/**
 * The instant a zone's clocks show a wall time. A time that happens twice, when clocks go back, is
 * the first of the two. A time that never happens, when clocks go forward over it, is the next
 * minute that does: 02:30 on a day the clocks jump from 02:00 to 03:00 is 03:00.
 */
export function instantOf(wall: Wall, zone: string): number {
  const start = wallNumber(wall);
  // No zone has skipped more than a day at once, and nearly all skip an hour or less.
  for (let minutes = 0; minutes <= 26 * 60; minutes++) {
    const found = instantsOf(wallOf(start + minutes * 60_000), zone);
    if (found.length > 0) return found[0]!;
  }
  throw new Error(`No such time in ${zone}`);
}

/** How many days a month has. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The day of the week of a date, with Sunday as 0. */
export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** A date as `2026-11-14`, in a zone. */
export function dateIn(instant: number | Date, zone: string): string {
  const wall = wallAt(instant, zone);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** A time as `17:00`, in a zone. */
export function timeIn(instant: number | Date, zone: string): string {
  const wall = wallAt(instant, zone);
  return `${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** A date and time as `2026-11-14T17:00`, in a zone: what a `once` trigger holds. */
export function localStamp(instant: number | Date, zone: string): string {
  return `${dateIn(instant, zone)}T${timeIn(instant, zone)}`;
}

/** Reads `2026-11-14T17:00` as a wall time. Null when it isn't one. */
export function parseStamp(text: string): Wall | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(text.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59) return null;
  return { year, month, day, hour, minute };
}

/** A day and time as people read them: "Fri 14 Nov at 17:00". The year only when it isn't this one. */
export function whenText(instant: number | Date, zone: string, now: number | Date): string {
  const date = new Date(instant);
  const sameYear = wallAt(date, zone).year === wallAt(now, zone).year;
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
  return `${day.replace(',', '')} at ${timeIn(date, zone)}`;
}

/** The zone's short name at an instant, such as AEDT, or its offset where it has none. */
export function zoneAbbreviation(instant: number | Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: zone,
    timeZoneName: 'short',
  }).formatToParts(new Date(instant));
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? zone;
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}
