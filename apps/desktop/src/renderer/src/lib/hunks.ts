import type { Hunk } from '@clanks/core';

/** Where a hunk is on the right-hand side of a diff, for markers and comments. */
export function hunkLines(hunk: Hunk): { start: number; end: number } {
  if (hunk.modifiedCount === 0) {
    const line = Math.max(1, hunk.modifiedStart);
    return { start: line, end: line };
  }
  return { start: hunk.modifiedStart, end: hunk.modifiedStart + hunk.modifiedCount - 1 };
}
