import { type ClankFrontmatter, clankFrontmatterSchema } from '@clanks/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** The clanks that ship with the app, in the order the roster shows them. */
export const PREMADE_CREW = [
  'atlas',
  'scribe',
  'prism',
  'forge',
  'gauge',
  'scout',
  'quill',
  'buzz',
] as const;

/** The shared rules every clank gets before its own doc. */
export const CREW_RULES_FILE = 'CREW.md';

/** A priming doc split into its parts. */
export interface ClankDoc {
  /** Configuration for the app. Never shown to the model. */
  frontmatter: ClankFrontmatter;
  /** The prompt: everything after the frontmatter, with HTML comments removed. */
  body: string;
}

/** A priming doc that can't be used, with a reason a person can act on. */
export class CrewDocError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CrewDocError';
  }
}

/** Splits a priming doc into frontmatter and body, and checks the frontmatter. */
export function parseClankDoc(text: string): ClankDoc {
  const normalized = normalize(text);
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) throw new CrewDocError('A priming doc starts with frontmatter between two --- lines');
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch (error) {
    throw new CrewDocError(`The frontmatter isn't valid YAML: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const parsed = clankFrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    throw new CrewDocError(`The frontmatter has problems:\n${z.prettifyError(parsed.error)}`);
  }
  const body = stripComments(match[2]!).trim();
  if (!body) throw new CrewDocError('The doc has no prompt after its frontmatter');
  return { frontmatter: parsed.data, body };
}

/** The crew rules: plain Markdown, with comments removed. */
export function parseCrewRules(text: string): string {
  return stripComments(normalize(text)).trim();
}

/** Notes for people editing a doc go in HTML comments, which the model never sees. */
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');
}

/** Windows editors sometimes start a file with a byte order mark. */
const BOM = 0xfeff;

function normalize(text: string): string {
  const unmarked = text.charCodeAt(0) === BOM ? text.slice(1) : text;
  return unmarked.replace(/\r\n?/g, '\n');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
