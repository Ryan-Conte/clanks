import {
  type ContextNote,
  type MemoryEntry,
  type MemoryKind,
  type NoteKind,
  type NotePatch,
  type NoteStatus,
  estimateTokens,
  looksSecret,
} from '@clanks/core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { contextNote, memory } from '../store/schema';
import type { Db } from '../store/store';

/** A context or memory problem worded for the user, or for the clank whose call caused it. */
export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextError';
  }
}

/** Notes that go into prompts: the rest are history. */
const LIVE: NoteStatus[] = ['provisional', 'active'];

/** Words too common to search on. */
const STOPWORDS = new Set(
  'a an and are as at be but by can do for from has have how i if in into is it its me my no not of on or our so that the their them then there these they this to up us was we what when where which who why will with you your'.split(
    ' ',
  ),
);

/**
 * An FTS5 query from plain words: each word quoted, so nothing in it is read as syntax, and any of
 * them may match. Null when nothing is left to search on.
 */
export function ftsQuery(text: string): string | null {
  const words = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
    ),
  ].slice(0, 24);
  return words.length > 0 ? words.map((w) => `"${w}"`).join(' OR ') : null;
}

/** A note's short reference, as clanks see and give it: the first characters of its id. */
export function noteRef(note: Pick<ContextNote, 'id'>): string {
  return note.id.slice(0, 6);
}

export interface ContextServiceOptions {
  db: Db;
  now?: () => Date;
}

/**
 * Each project's context, which its whole crew shares: project notes. And each clank's memory of
 * each project, which only it reads. Both are searched with SQLite's full-text index. Emits
 * `change` with a project's id when either changes. See docs/CONTEXT.md.
 */
export class ContextService extends EventEmitter<{ change: [projectId: string] }> {
  constructor(private readonly options: ContextServiceOptions) {
    super();
    this.setMaxListeners(100);
  }

  // Project notes

  /** A project's notes, pinned first, then newest first. */
  notes(projectId: string, statuses: NoteStatus[] = LIVE): ContextNote[] {
    return this.options.db
      .select()
      .from(contextNote)
      .where(and(eq(contextNote.projectId, projectId), inArray(contextNote.status, statuses)))
      .orderBy(desc(contextNote.pinned), desc(contextNote.createdAt))
      .all();
  }

  note(id: string): ContextNote {
    const found = this.options.db.select().from(contextNote).where(eq(contextNote.id, id)).get();
    if (!found) throw new ContextError('That note was deleted');
    return found;
  }

  /** A live note in a project by its short reference, or its title. */
  findNote(projectId: string, ref: string): ContextNote | undefined {
    const wanted = ref
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
    return this.notes(projectId).find(
      (n) => n.id.startsWith(wanted) || n.title.toLowerCase() === wanted,
    );
  }

  /**
   * Adds a note. One that looks like it holds a secret is refused. A note can replace an older one,
   * which stays in history, superseded.
   */
  addNote(input: {
    projectId: string;
    kind: NoteKind;
    title: string;
    body: string;
    why: string;
    author: string;
    ticketId: string | null;
    status: 'provisional' | 'active';
    pinned?: boolean;
    supersedes?: string | null;
  }): ContextNote {
    this.checkSecret(`${input.title}\n${input.body}\n${input.why}`);
    const now = this.now();
    const note: ContextNote = {
      id: randomUUID(),
      projectId: input.projectId,
      kind: input.kind,
      title: input.title.trim(),
      body: input.body.trim(),
      why: input.why.trim(),
      author: input.author,
      ticketId: input.ticketId,
      status: input.status,
      supersedes: input.supersedes ?? null,
      pinned: input.pinned ?? false,
      usedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.options.db.transaction((tx) => {
      tx.insert(contextNote).values(note).run();
      if (note.supersedes) {
        tx.update(contextNote)
          .set({ status: 'superseded', updatedAt: now })
          .where(eq(contextNote.id, note.supersedes))
          .run();
      }
    });
    this.emit('change', input.projectId);
    return note;
  }

  updateNote(id: string, patch: NotePatch): ContextNote {
    const note = this.note(id);
    const next = { ...note, ...patch };
    this.checkSecret(`${next.title}\n${next.body}\n${next.why}`);
    this.options.db
      .update(contextNote)
      .set({ ...patch, updatedAt: this.now() })
      .where(eq(contextNote.id, id))
      .run();
    this.emit('change', note.projectId);
    return this.note(id);
  }

  deleteNote(id: string): void {
    const note = this.note(id);
    this.options.db.delete(contextNote).where(eq(contextNote.id, id)).run();
    this.emit('change', note.projectId);
  }

  /** A ticket was approved: the notes the crew wrote on it are settled. */
  activateForTicket(projectId: string, ticketId: string): number {
    return this.setStatusForTicket(projectId, ticketId, 'active');
  }

  /** A ticket was rejected: the notes the crew wrote on it go. */
  dropForTicket(projectId: string, ticketId: string): number {
    return this.setStatusForTicket(projectId, ticketId, 'dropped');
  }

  private setStatusForTicket(projectId: string, ticketId: string, status: NoteStatus): number {
    const changed = this.options.db
      .update(contextNote)
      .set({ status, updatedAt: this.now() })
      .where(and(eq(contextNote.ticketId, ticketId), eq(contextNote.status, 'provisional')))
      .run().changes;
    if (changed > 0) this.emit('change', projectId);
    return changed;
  }

  /** The live notes that best match some words, best first. */
  searchNotes(projectId: string, text: string, limit = 8): ContextNote[] {
    const query = ftsQuery(text);
    if (!query) return [];
    const ids = this.options.db
      .all<{ id: string }>(
        sql`select context_note_fts.id as id from context_note_fts
            join context_note n on n.id = context_note_fts.id
            where context_note_fts match ${query} and n.project_id = ${projectId}
              and n.status in ('provisional', 'active')
            order by bm25(context_note_fts) limit ${limit}`,
      )
      .map((r) => r.id);
    return this.byIds(ids);
  }

  /** Notes a prompt just included, so the Context tab can tell which nobody uses. */
  markUsed(ids: string[]): void {
    if (ids.length === 0) return;
    this.options.db
      .update(contextNote)
      .set({ usedAt: this.now() })
      .where(inArray(contextNote.id, ids))
      .run();
  }

  private byIds(ids: string[]): ContextNote[] {
    if (ids.length === 0) return [];
    const rows = this.options.db
      .select()
      .from(contextNote)
      .where(inArray(contextNote.id, ids))
      .all();
    return ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
  }

  // Clank memory

  /** A project's memory: one clank's, or every clank's. Newest first. */
  memories(projectId: string, clankId?: string): MemoryEntry[] {
    return this.options.db
      .select()
      .from(memory)
      .where(
        clankId
          ? and(eq(memory.projectId, projectId), eq(memory.clankId, clankId))
          : eq(memory.projectId, projectId),
      )
      .orderBy(desc(memory.createdAt))
      .all();
  }

  remember(input: {
    projectId: string;
    clankId: string;
    kind: MemoryKind;
    body: string;
    ticketId?: string | null;
    conversationId?: string | null;
  }): MemoryEntry {
    this.checkSecret(input.body);
    const now = this.now();
    const entry: MemoryEntry = {
      id: randomUUID(),
      projectId: input.projectId,
      clankId: input.clankId,
      kind: input.kind,
      body: input.body.trim(),
      ticketId: input.ticketId ?? null,
      conversationId: input.conversationId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.options.db.insert(memory).values(entry).run();
    this.emit('change', input.projectId);
    return entry;
  }

  /**
   * Keeps one `chat` entry per chat, replaced as the chat goes on. A chat that brings up a secret
   * isn't remembered, rather than failing the chat.
   */
  rememberChat(input: {
    projectId: string;
    clankId: string;
    conversationId: string;
    body: string;
  }): void {
    if (looksSecret(input.body)) return;
    const existing = this.options.db
      .select()
      .from(memory)
      .where(and(eq(memory.conversationId, input.conversationId), eq(memory.kind, 'chat')))
      .get();
    if (existing) {
      if (existing.body === input.body.trim()) return;
      this.options.db
        .update(memory)
        .set({ body: input.body.trim(), updatedAt: this.now() })
        .where(eq(memory.id, existing.id))
        .run();
      this.emit('change', input.projectId);
      return;
    }
    this.remember({ ...input, kind: 'chat' });
  }

  updateMemory(id: string, body: string): MemoryEntry {
    const entry = this.entry(id);
    this.checkSecret(body);
    this.options.db
      .update(memory)
      .set({ body: body.trim(), updatedAt: this.now() })
      .where(eq(memory.id, id))
      .run();
    this.emit('change', entry.projectId);
    return this.entry(id);
  }

  deleteMemory(id: string): void {
    const entry = this.entry(id);
    this.options.db.delete(memory).where(eq(memory.id, id)).run();
    this.emit('change', entry.projectId);
  }

  /** One clank's entries that best match some words, best first. */
  searchMemory(projectId: string, clankId: string, text: string, limit = 8): MemoryEntry[] {
    const query = ftsQuery(text);
    if (!query) return [];
    const ids = this.options.db
      .all<{ id: string }>(
        sql`select memory_fts.id as id from memory_fts join memory m on m.id = memory_fts.id
            where memory_fts match ${query} and m.project_id = ${projectId}
              and m.clank_id = ${clankId}
            order by bm25(memory_fts) limit ${limit}`,
      )
      .map((r) => r.id);
    if (ids.length === 0) return [];
    const rows = this.options.db.select().from(memory).where(inArray(memory.id, ids)).all();
    return ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
  }

  private entry(id: string): MemoryEntry {
    const found = this.options.db.select().from(memory).where(eq(memory.id, id)).get();
    if (!found) throw new ContextError('That memory was deleted');
    return found;
  }

  private checkSecret(text: string): void {
    if (looksSecret(text)) {
      throw new ContextError(
        "That looks like it holds a secret, such as a key, token or password, so it wasn't saved. Leave the secret out.",
      );
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/** A note as one line for a prompt or a search result. */
export function noteLine(note: ContextNote, names: (author: string) => string): string {
  const provisional = note.status === 'provisional' ? ' (provisional)' : '';
  const body = note.body ? ` ${note.body}` : '';
  const why = note.why ? ` Why: ${note.why}` : '';
  return `- [${noteRef(note)}] ${note.kind}${provisional}: ${note.title}.${body}${why} (${names(note.author)})`;
}

/** A memory entry as one line. */
export function memoryLine(entry: MemoryEntry): string {
  const date = entry.createdAt.toISOString().slice(0, 10);
  const kind = { decision: 'Decision', note: 'Note', run_summary: 'Run', chat: 'Chat' }[entry.kind];
  return `- ${date} ${kind}: ${entry.body.replace(/\s+/g, ' ')}`;
}

/**
 * Lines that fit a token budget, in order, and how many didn't. Lines are never cut in half: the
 * model would read half a note as the whole of it.
 */
export function fitLines(lines: string[], budget: number): { kept: string[]; left: number } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  return { kept, left: lines.length - kept.length };
}
