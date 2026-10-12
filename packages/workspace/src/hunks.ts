import type { Hunk } from '@clanks/core';
import { diffArrays } from 'diff';

/** A file's lines, each with its line ending, so joining them gives the file back exactly. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** The line ending a file mostly uses. */
export function lineEnding(text: string): '\r\n' | '\n' {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * The runs of lines that differ between two versions of a file. A side with no lines in a run
 * gives the line before it instead, as Monaco's diff editor does.
 */
export function computeHunks(original: string, modified: string): Hunk[] {
  const changes = diffArrays(splitLines(original), splitLines(modified));
  const hunks: Hunk[] = [];
  let o = 0;
  let m = 0;
  let current: Hunk | null = null;
  const close = () => {
    if (!current) return;
    if (current.originalCount === 0) current.originalStart -= 1;
    if (current.modifiedCount === 0) current.modifiedStart -= 1;
    hunks.push(current);
    current = null;
  };
  for (const change of changes) {
    const count = change.value.length;
    if (!change.added && !change.removed) {
      close();
      o += count;
      m += count;
      continue;
    }
    current ??= { originalStart: o + 1, originalCount: 0, modifiedStart: m + 1, modifiedCount: 0 };
    if (change.removed) {
      current.originalCount += count;
      o += count;
    } else {
      current.modifiedCount += count;
      m += count;
    }
  }
  close();
  return hunks;
}

export function sameHunk(a: Hunk, b: Hunk): boolean {
  return (
    a.originalStart === b.originalStart &&
    a.originalCount === b.originalCount &&
    a.modifiedStart === b.modifiedStart &&
    a.modifiedCount === b.modifiedCount
  );
}

/** The file with one hunk put back as it was in the original. */
export function revertHunk(original: string, modified: string, hunk: Hunk): string {
  const before = splitLines(original);
  const after = splitLines(modified);
  const restored = before.slice(
    hunk.originalStart - (hunk.originalCount ? 1 : 0),
    hunk.originalStart - (hunk.originalCount ? 1 : 0) + hunk.originalCount,
  );
  const at = hunk.modifiedCount ? hunk.modifiedStart - 1 : hunk.modifiedStart;
  after.splice(at, hunk.modifiedCount, ...restored);
  // A last line without a newline that's no longer last needs one.
  const eol = lineEnding(modified || original);
  for (let i = 0; i < after.length - 1; i++) {
    if (!after[i]!.endsWith('\n')) after[i] += eol;
  }
  return after.join('');
}

/**
 * The lines of `after` that differ from `before`, as 1-based inclusive ranges. A deletion marks
 * the line before it, or the first line at the top of the file.
 */
export function changedRanges(before: string, after: string): { start: number; end: number }[] {
  return computeHunks(before, after).map((hunk) => {
    if (hunk.modifiedCount === 0) {
      const line = Math.max(1, hunk.modifiedStart);
      return { start: line, end: line };
    }
    return { start: hunk.modifiedStart, end: hunk.modifiedStart + hunk.modifiedCount - 1 };
  });
}

/** Some lines of a file, for a note: at most a few, each cut short. */
export function excerptOf(text: string, start: number, end: number, maxLines = 8): string {
  const lines = splitLines(text).map((line) => line.replace(/\r?\n$/, ''));
  const picked = lines.slice(Math.max(0, start - 1), Math.max(start, end));
  const shown = picked
    .slice(0, maxLines)
    .map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line));
  if (picked.length > maxLines) shown.push(`… ${picked.length - maxLines} more lines`);
  return shown.join('\n');
}
