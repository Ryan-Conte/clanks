import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './docs';

/** Instructions the user wrote for a project, from its folder. */
export interface ProjectInstructions {
  file: 'CLANKS.md' | 'AGENTS.md';
  text: string;
}

/** Bigger than this isn't instructions; it would crowd out the conversation. */
const MAX_BYTES = 256 * 1024;

/** Reads `CLANKS.md` at the root of a folder, or `AGENTS.md` if there's no `CLANKS.md`. */
export function readProjectInstructions(folder: string): ProjectInstructions | null {
  for (const file of ['CLANKS.md', 'AGENTS.md'] as const) {
    const path = join(folder, file);
    try {
      if (!statSync(path).isFile()) continue;
      const buffer = readFileSync(path);
      const text = buffer.subarray(0, MAX_BYTES).toString('utf8');
      return { file, text };
    } catch {
      // Not there, or not readable: try the next one.
    }
  }
  return null;
}

/**
 * The part of a project's instructions one clank gets: everything outside the `## For <clank>`
 * sections, plus that clank's own section. A section can name several clanks:
 * `## For Forge and Gauge`.
 */
export function instructionsFor(text: string, clank: { id: string; names: string[] }): string {
  const wanted = new Set([clank.id, ...clank.names].map((n) => n.trim().toLowerCase()));
  const kept: string[] = [];
  let skipping = false;
  let fence: string | null = null;

  for (const line of stripComments(text.replace(/\r\n?/g, '\n')).split('\n')) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fenceMatch[1] === fence) fence = null;
    }
    // A `#` line inside a code block is code, not a heading.
    const heading = fence === null ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    if (heading && heading[1]!.length <= 2) {
      const forMatch = /^for\s+(.+?)\s*#*\s*$/i.exec(heading[2]!);
      skipping =
        heading[1]!.length === 2 &&
        forMatch !== null &&
        !forMatch[1]!
          .split(/\s*(?:,|&|\band\b)\s*/i)
          .some((name) => wanted.has(name.trim().toLowerCase()));
    }
    if (!skipping) kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
