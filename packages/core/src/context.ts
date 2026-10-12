import { z } from 'zod';
import type { ClankId } from './crew';

/** What a project note is: see docs/CONTEXT.md. */
export const noteKindSchema = z.enum(['fact', 'decision', 'convention', 'glossary', 'link']);

export type NoteKind = z.infer<typeof noteKindSchema>;

/**
 * Where a note is in its life. A clank's note is `provisional` until the ticket it came from is
 * approved, though the crew sees it straight away; the user's are `active` from the start. A note
 * replaced by a newer one is `superseded`, and one taken back is `dropped`. Only provisional and
 * active notes go into prompts.
 */
export type NoteStatus = 'provisional' | 'active' | 'superseded' | 'dropped';

/** Something the whole crew on a project should know. Information, never instructions. */
export interface ContextNote {
  id: string;
  projectId: string;
  kind: NoteKind;
  title: string;
  body: string;
  /** Why it's true, or why it was decided. */
  why: string;
  /** `user`, or the clank that wrote it. */
  author: string;
  /** The ticket it came from, for a clank's note on a ticket. */
  ticketId: string | null;
  status: NoteStatus;
  /** The note this one replaced. */
  supersedes: string | null;
  /** Always in every prompt, rather than when it's relevant. */
  pinned: boolean;
  /** When a prompt last included it. */
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What a memory entry is: a decision with its reason, a note, a run's summary or a chat's. */
export type MemoryKind = 'decision' | 'note' | 'run_summary' | 'chat';

/** One entry in a clank's own memory of one project. Only it reads it, and Atlas at sign-off. */
export interface MemoryEntry {
  id: string;
  projectId: string;
  clankId: ClankId;
  kind: MemoryKind;
  body: string;
  ticketId: string | null;
  /** The run or chat it came from. */
  conversationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const noteText = z.string().trim().min(1);

/** A note the user adds in the Context tab. */
export const newNoteSchema = z.object({
  projectId: z.uuid(),
  kind: noteKindSchema,
  title: noteText.max(200),
  body: z.string().trim().max(4000).default(''),
  why: z.string().trim().max(2000).default(''),
  pinned: z.boolean().default(false),
});

export type NewNote = z.infer<typeof newNoteSchema>;

export const notePatchSchema = z
  .object({
    kind: noteKindSchema,
    title: noteText.max(200),
    body: z.string().trim().max(4000),
    why: z.string().trim().max(2000),
    pinned: z.boolean(),
    status: z.enum(['active', 'dropped']),
  })
  .partial();

export type NotePatch = z.infer<typeof notePatchSchema>;

export const memoryPatchSchema = z.object({ body: noteText.max(4000) });

/** A project's context and its clanks' memories, as the Context tab shows them. */
export interface ContextSnapshot {
  notes: ContextNote[];
  /** Each clank's memory in the project, newest first. */
  memory: MemoryEntry[];
  /** `CLANKS.md`, or `AGENTS.md` when there's no `CLANKS.md`, at the workspace root. */
  instructions: { file: 'CLANKS.md' | 'AGENTS.md'; text: string } | null;
}

const SECRET_PATTERNS: RegExp[] = [
  // Provider and platform keys with well-known prefixes.
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // A JSON web token.
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  // password=…, api_key: "…", with a value that isn't a placeholder.
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?(?![<{$]|x{3,}|\*{3,})[^\s"']{8,}/i,
  // Credentials in a URL.
  /\b\w+:\/\/[^\s/@:]+:[^\s/@]{3,}@/,
];

/**
 * Whether some text looks like it holds a secret: an API key, a token, a private key or a password.
 * Notes and memory end up in prompts and on screen, so they never keep one.
 */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
