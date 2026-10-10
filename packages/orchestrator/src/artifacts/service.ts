import {
  type Artifact,
  type ArtifactKind,
  artifactNameSchema,
  isTextArtifact,
  mediaTypeOf,
} from '@clanks/core';
import { type ArtifactAccess, ToolFailure } from '@clanks/tools';
import { removeTree } from '@clanks/workspace';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { artifact as artifactTable } from '../store/schema';
import type { Db } from '../store/store';

/** An artifact problem worded for the user, or for the clank whose tool call caused it. */
export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactError';
  }
}

/** The most one artifact may hold. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Where an artifact belongs: a ticket, or a chat outside one. */
export interface ArtifactScope {
  ticketId: string | null;
  conversationId: string | null;
  projectId: string | null;
}

export interface ArtifactServiceOptions {
  db: Db;
  /** The app data's artifacts folder. */
  dir: string;
  now?: () => Date;
}

/**
 * What the crew makes that isn't in a repository: hand-ins as documents, working notes, pictures
 * of pages. Files are in the artifacts folder, under their ticket or chat, and every save under a
 * name that's taken adds a version. Emits `change` with the ticket's id, or null for a chat's.
 */
export class ArtifactService extends EventEmitter<{ change: [ticketId: string | null] }> {
  constructor(private readonly options: ArtifactServiceOptions) {
    super();
    this.setMaxListeners(100);
  }

  /**
   * Saves a file. The same bytes as the newest version under that name aren't saved again: the
   * version there is returned, with `unchanged` set.
   */
  save(
    input: ArtifactScope & {
      author: string;
      kind: ArtifactKind;
      name: string;
      data: string | Uint8Array;
      mediaType?: string;
    },
  ): Artifact & { unchanged?: boolean } {
    const parsed = artifactNameSchema.safeParse(input.name);
    if (!parsed.success) {
      throw new ArtifactError(
        `"${input.name}" isn't a file name. ${parsed.error.issues[0]?.message ?? ''}`.trim(),
      );
    }
    if (!input.ticketId && !input.conversationId) {
      throw new ArtifactError('An artifact belongs to a ticket or a chat');
    }
    const name = parsed.data;
    const data = typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : input.data;
    if (data.byteLength > MAX_BYTES) {
      throw new ArtifactError(
        `${name} is over ${MAX_BYTES / 1024 / 1024} MB, which is too big to keep.`,
      );
    }
    const latest = this.latest(input, name);
    const file0 = latest ? join(this.options.dir, latest.path) : null;
    if (latest && file0 && existsSync(file0) && sameBytes(readFileSync(file0), data)) {
      return { ...latest, unchanged: true };
    }
    const version = (latest?.version ?? 0) + 1;
    const ending = extname(name);
    const stem = ending ? name.slice(0, -ending.length) : name;
    const folder = input.ticketId ? `tickets/${input.ticketId}` : `${input.conversationId!}/files`;
    const path = `${folder}/${stem}.v${version}${ending}`;
    const file = join(this.options.dir, path);
    mkdirSync(dirname(file), { recursive: true });
    // A sibling file renamed into place, so a crash never leaves half an artifact.
    writeFileSync(`${file}.tmp`, data);
    renameSync(`${file}.tmp`, file);
    const row: Artifact = {
      id: randomUUID(),
      ticketId: input.ticketId,
      conversationId: input.conversationId,
      projectId: input.projectId,
      author: input.author,
      kind: input.kind,
      name,
      version,
      mediaType: input.mediaType ?? mediaTypeOf(name),
      size: data.byteLength,
      path,
      createdAt: this.now(),
    };
    this.options.db.insert(artifactTable).values(row).run();
    this.emit('change', input.ticketId);
    return row;
  }

  /**
   * Keeps a picture a tool took in a chat, such as a page a clank read, with a ticket. `from` is
   * the picture's path in the artifacts folder. Null when the picture is gone.
   */
  keepPicture(
    scope: ArtifactScope & { author: string },
    from: string,
    stem: string,
  ): Artifact | null {
    const file = join(this.options.dir, from);
    // Only pictures the app saved itself, inside its own folder.
    if (from.includes('..') || !/\.(jpg|png)$/i.test(from) || !existsSync(file)) return null;
    return this.save({
      ...scope,
      kind: 'screenshot',
      name: `${stem}${extname(from).toLowerCase()}`,
      data: readFileSync(file),
    });
  }

  /** Everything saved with a ticket: every name, every version, the newest first. */
  forTicket(ticketId: string): Artifact[] {
    return this.options.db
      .select()
      .from(artifactTable)
      .where(eq(artifactTable.ticketId, ticketId))
      .orderBy(asc(artifactTable.name), desc(artifactTable.version))
      .all();
  }

  /** What a chat outside a ticket saved. */
  forConversation(conversationId: string): Artifact[] {
    return this.options.db
      .select()
      .from(artifactTable)
      .where(and(eq(artifactTable.conversationId, conversationId), isNull(artifactTable.ticketId)))
      .orderBy(asc(artifactTable.name), desc(artifactTable.version))
      .all();
  }

  /** Everything saved in a scope: its ticket's, or its chat's when it has no ticket. */
  list(scope: ArtifactScope): Artifact[] {
    if (scope.ticketId) return this.forTicket(scope.ticketId);
    return scope.conversationId ? this.forConversation(scope.conversationId) : [];
  }

  latest(scope: ArtifactScope, name: string): Artifact | undefined {
    return this.list(scope).find((a) => a.name.toLowerCase() === name.toLowerCase());
  }

  find(id: string): Artifact | undefined {
    return this.options.db.select().from(artifactTable).where(eq(artifactTable.id, id)).get();
  }

  get(id: string): Artifact {
    const found = this.find(id);
    if (!found) throw new ArtifactError('That file was deleted');
    return found;
  }

  /** An artifact's bytes. */
  read(id: string): Uint8Array {
    const artifact = this.get(id);
    const file = join(this.options.dir, artifact.path);
    if (!existsSync(file)) throw new ArtifactError(`${artifact.name} is gone from the data folder`);
    return readFileSync(file);
  }

  /** An artifact as text. Throws for one that isn't text. */
  text(id: string): string {
    const artifact = this.get(id);
    if (!isTextArtifact(artifact)) throw new ArtifactError(`${artifact.name} isn't text`);
    return Buffer.from(this.read(id)).toString('utf8');
  }

  /** Where an artifact's file is. */
  file(id: string): string {
    return join(this.options.dir, this.get(id).path);
  }

  /** A ticket was deleted: its rows went with it, and its files go now. */
  async removeTicket(ticketId: string): Promise<void> {
    this.options.db.delete(artifactTable).where(eq(artifactTable.ticketId, ticketId)).run();
    await removeTree(join(this.options.dir, 'tickets', ticketId)).catch((error: unknown) =>
      console.error('Removing a ticket’s artifacts failed', error),
    );
  }

  /** A chat was deleted: what it saved outside a ticket goes. Its folder is the chat's to remove. */
  removeConversation(conversationId: string): void {
    this.options.db
      .delete(artifactTable)
      .where(and(eq(artifactTable.conversationId, conversationId), isNull(artifactTable.ticketId)))
      .run();
  }

  /** The artifacts as one clank's tools reach them, in one chat or run. */
  access(
    scope: ArtifactScope & { author: string; label: string },
    maxChars: number,
  ): ArtifactAccess {
    return {
      save: ({ name, content }) => {
        try {
          const saved = this.save({
            ...scope,
            kind: /\.(md|markdown|txt)$/i.test(name) || !/\./.test(name) ? 'note' : 'file',
            name,
            data: content,
          });
          if (saved.unchanged) {
            return `${saved.name} is the same as version ${saved.version}, so nothing new was saved.`;
          }
          return `Saved ${saved.name} with ${scope.label}${saved.version > 1 ? ` as version ${saved.version}; earlier versions are kept` : ''} (${sizeText(saved.size)}). Read it back with artifact_read.`;
        } catch (error) {
          if (error instanceof ArtifactError) throw new ToolFailure(error.message);
          throw error;
        }
      },
      read: ({ name, version, fromLine }) => {
        const all = this.list(scope);
        if (!name) {
          if (all.length === 0) return `Nothing is saved with ${scope.label} yet.`;
          const names = [...new Set(all.map((a) => a.name))];
          return [
            `Saved with ${scope.label}:`,
            '',
            ...names.map((n) => {
              const versions = all.filter((a) => a.name === n);
              const newest = versions[0]!;
              return `- ${n} (${newest.kind}, ${sizeText(newest.size)}, by ${newest.author}${versions.length > 1 ? `, ${versions.length} versions` : ''})`;
            }),
          ].join('\n');
        }
        const versions = all.filter((a) => a.name.toLowerCase() === name.toLowerCase());
        if (versions.length === 0) {
          const names = [...new Set(all.map((a) => a.name))];
          throw new ToolFailure(
            names.length > 0
              ? `There's no ${name} saved with ${scope.label}. Saved: ${names.join(', ')}.`
              : `Nothing is saved with ${scope.label} yet.`,
          );
        }
        const found = version ? versions.find((a) => a.version === version) : versions[0];
        if (!found) {
          throw new ToolFailure(
            `${name} has no version ${version}. It has ${versions
              .map((a) => a.version)
              .reverse()
              .join(', ')}.`,
          );
        }
        if (!isTextArtifact(found)) {
          return `${found.name} is ${found.mediaType}, ${sizeText(found.size)}: not text, so there's nothing to read.`;
        }
        const lines = this.text(found.id).split('\n');
        const start = Math.min(Math.max(1, fromLine), Math.max(1, lines.length));
        const taken: string[] = [];
        let used = 0;
        for (const line of lines.slice(start - 1)) {
          if (used + line.length + 1 > maxChars && taken.length > 0) break;
          taken.push(line);
          used += line.length + 1;
        }
        const end = start - 1 + taken.length;
        const header = `${found.name}, version ${found.version}${versions.length > 1 ? ` of ${versions.length}` : ''}`;
        return [
          end < lines.length || start > 1
            ? `${header}, lines ${start} to ${end} of ${lines.length}:`
            : `${header}:`,
          '',
          taken.join('\n'),
          ...(end < lines.length ? ['', `[More below: read on with from_line ${end + 1}.]`] : []),
        ].join('\n');
      },
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const hash = (data: Uint8Array) => createHash('sha1').update(data).digest('hex');
  return hash(a) === hash(b);
}

/** 1536 as "1.5 kB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} kB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}
