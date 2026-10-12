import { z } from 'zod';

/**
 * Where a spec version is. Scribe writes a `draft`; it's in `review` while Atlas checks it, and
 * `signed_off` once Atlas has, waiting for the user. Approving makes it the project's spec.
 */
export type SpecStatus = 'draft' | 'review' | 'signed_off' | 'approved';

/** One version of a project's spec. */
export interface SpecVersion {
  id: string;
  projectId: string;
  /** 1, 2, 3: each approval makes the next draft a new version. */
  version: number;
  /** Markdown. */
  body: string;
  status: SpecStatus;
  /** The spec ticket writing it. */
  ticketId: string | null;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
}

/** An acceptance criterion: `AC-4.2` and its words. Criteria added on a ticket have no id. */
export interface Criterion {
  id: string | null;
  text: string;
}

/** A user story parsed out of a spec. */
export interface SpecStory {
  /** `US-4`. */
  id: string;
  number: number;
  title: string;
  /** The story itself: "As a shopper, I want …". */
  text: string;
  criteria: Criterion[];
  edgeCases: string[];
  /** Marked "Removed in v3": kept so its number is never reused, but not to be built. */
  removed: boolean;
}

export interface ParsedSpec {
  stories: SpecStory[];
  /** What's wrong with it, worded for Scribe: a story with no criteria, a number used twice. */
  problems: string[];
}

export const specVersionSchema = z.number().int().min(1).max(10_000);

const STORY = /^(#{2,5})\s+(?:\*\*)?US-(\d+)(?:\*\*)?\s*(?:[:.\-–—]\s*)?(.*?)\s*#*\s*$/;
const HEADING = /^(#{1,6})\s/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const CRITERION =
  /^(?:\*\*)?(?:\[)?AC-(\d+)\.(\d+)(?:\])?(?:\*\*)?\s*(?:[:.\-–—]\s*)?(?:\*\*\s*)?(.*)$/;
const LABEL = /^(?:#{3,6}\s+)?(?:\*\*|_)?(acceptance criteria|edge cases)(?:\*\*|_)?:?\s*$/i;

/**
 * Picks the stories, their acceptance criteria and edge cases out of a spec in Scribe's shape:
 * `### US-4 Checkout`, then `- AC-4.1: …` bullets and an "Edge cases" list. Lenient about the
 * small variations models write, and says what doesn't fit.
 */
export function parseSpec(body: string): ParsedSpec {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const stories: SpecStory[] = [];
  const problems: string[] = [];
  let story: SpecStory | null = null;
  let level = 0;
  let section: 'text' | 'criteria' | 'edge' = 'text';
  let inCode = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const heading = STORY.exec(line);
    if (heading) {
      const number = Number(heading[2]);
      const title = (heading[3] ?? '').replace(/\*\*/g, '').trim();
      story = {
        id: `US-${number}`,
        number,
        title,
        text: '',
        criteria: [],
        edgeCases: [],
        removed: /removed in v\d+/i.test(title),
      };
      stories.push(story);
      level = heading[1]!.length;
      section = 'text';
      continue;
    }
    if (!story) continue;
    const label = LABEL.exec(line.trim());
    if (label) {
      section = label[1]!.toLowerCase().startsWith('edge') ? 'edge' : 'criteria';
      continue;
    }
    const other = HEADING.exec(line);
    if (other && other[1]!.length <= level) {
      story = null;
      continue;
    }
    if (other) continue;
    const bullet = BULLET.exec(line);
    const item = bullet?.[1]?.trim();
    const criterion = item ? CRITERION.exec(item) : null;
    if (criterion) {
      const id = `AC-${criterion[1]}.${criterion[2]}`;
      const text = criterion[3]!.replace(/^\*\*\s*/, '').trim();
      if (Number(criterion[1]) !== story.number) {
        problems.push(`${id} is under ${story.id}; number it AC-${story.number}.x`);
      }
      story.criteria.push({ id, text });
      continue;
    }
    if (item && section === 'edge') {
      story.edgeCases.push(item);
      continue;
    }
    if (item && section === 'criteria') {
      // A criterion without its number still counts, but it can't be referenced.
      problems.push(`${story.id} has a criterion without an AC number: "${short(item)}"`);
      story.criteria.push({ id: null, text: item });
      continue;
    }
    if (line.trim() && section === 'text') {
      story.text = story.text ? `${story.text} ${line.trim()}` : line.trim();
      if (/removed in v\d+/i.test(line)) story.removed = true;
    }
  }

  if (stories.length === 0) {
    problems.push('It has no stories. Give each one a heading such as "### US-1 Browse boards".');
  }
  const seen = new Set<string>();
  const seenCriteria = new Set<string>();
  for (const s of stories) {
    if (seen.has(s.id)) problems.push(`${s.id} is used twice; give the second a new number`);
    seen.add(s.id);
    if (!s.removed && s.criteria.length === 0) {
      problems.push(`${s.id} has no acceptance criteria`);
    }
    for (const c of s.criteria) {
      if (!c.id) continue;
      if (seenCriteria.has(c.id)) problems.push(`${c.id} is used twice`);
      seenCriteria.add(c.id);
    }
  }
  return { stories, problems };
}

/** The criteria of some stories, in the order the stories are given. Unknown ids are skipped. */
export function criteriaOf(storyIds: string[], stories: SpecStory[]): Criterion[] {
  return storyIds.flatMap(
    (id) => stories.find((s) => s.id === normalizeStoryId(id))?.criteria ?? [],
  );
}

/**
 * `us-4`, `US4`, `4` and `US-4: Checkout` all mean `US-4`. Anything else comes back in capitals,
 * as it was written, so it reads as a story that isn't there.
 */
export function normalizeStoryId(id: string): string {
  const match = /^\s*(?:us)?\s*-?\s*(\d+)\b/i.exec(id) ?? /\bUS\s*-?\s*(\d+)/i.exec(id);
  return match ? `US-${Number(match[1])}` : id.trim().toUpperCase();
}

/** Stories added or changed between two versions of a spec, by id. */
export function changedStories(before: SpecStory[], after: SpecStory[]): string[] {
  const old = new Map(before.map((s) => [s.id, JSON.stringify(s)]));
  return after.filter((s) => old.get(s.id) !== JSON.stringify(s)).map((s) => s.id);
}

function short(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
