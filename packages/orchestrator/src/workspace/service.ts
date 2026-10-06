import type {
  ChangedFile,
  Checkpoint,
  DiffSide,
  FileVersions,
  Hunk,
  ReviewNote,
  RunInfo,
  WorkspaceState,
  WorkspaceStatus,
} from '@clanks/core';
import {
  GitError,
  PathError,
  ShadowRepo,
  addWorktree,
  changedRanges,
  computeHunks,
  excerptOf,
  git,
  gitVersion,
  initRepo,
  isBinary,
  removeWorktree,
  repoInfo,
  resolveInside,
  revertHunk,
  sameHunk,
  sha256,
  splitLines,
  subfolderOf,
} from '@clanks/workspace';
import { and, asc, desc, eq, gt, gte, isNull, ne, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { checkpoint as checkpointTable, reviewNote, run as runTable } from '../store/schema';
import type { Db } from '../store/store';

/** A workspace problem worded for the user. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** Files bigger than this aren't shown in the diff editor. */
const MAX_SHOWN_BYTES = 2 * 1024 * 1024;
/** A live file's hash when it doesn't exist. */
const ABSENT = 'absent';

export interface WorkspaceServiceOptions {
  db: Db;
  /** `<app data>/worktrees`. */
  worktreesDir: string;
  /** `<app data>/checkpoints`. */
  checkpointsDir: string;
  /** The chat a run belongs to: its folder, clank and last message. */
  conversations: {
    get(
      id: string,
    ): { id: string; clankId: string; folder: string | null; title: string } | undefined;
    lastMessageId(id: string): string | null;
  };
  /** The name a run's worktree and branch get, such as a ticket's key. Chats get `chat-<id>`. */
  workName?: (conversationId: string) => string | null;
  now?: () => Date;
}

type RunRow = typeof runTable.$inferSelect;

/**
 * Each chat's copy of the repository it's about: a git worktree on a branch of its own, with a
 * checkpoint after every change. Emits `change` with a chat's id when its workspace changes.
 */
export class WorkspaceService extends EventEmitter<{ change: [conversationId: string] }> {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly creating = new Map<string, Promise<RunInfo | null>>();

  constructor(private readonly options: WorkspaceServiceOptions) {
    super();
    this.setMaxListeners(100);
  }

  /** What the workbench shows: whether there's a workspace, and its checkpoints and notes. */
  async state(conversationId: string): Promise<WorkspaceState> {
    const conversation = this.options.conversations.get(conversationId);
    const empty = { run: null, checkpoints: [], notes: [], error: null };
    if (!conversation?.folder) return { status: 'none', folder: null, ...empty };
    const row = this.row(conversationId);
    if (row && row.folder === conversation.folder) {
      return {
        status: 'ready',
        folder: conversation.folder,
        run: toRun(row),
        checkpoints: this.checkpoints(row.id),
        notes: this.notes(row.id),
        error: null,
      };
    }
    const { status, error } = await this.check(conversation.folder);
    return { status, folder: conversation.folder, ...empty, error };
  }

  /** The run for a chat, if it has one already. */
  run(conversationId: string): RunInfo | null {
    const row = this.row(conversationId);
    return row ? toRun(row) : null;
  }

  /**
   * The chat's run, making its worktree if it has none yet. Null when the chat isn't about a
   * folder in a repository; `state` says why.
   */
  async ensure(conversationId: string): Promise<RunInfo | null> {
    const pending = this.creating.get(conversationId);
    if (pending) return pending;
    const work = this.create(conversationId).finally(() => this.creating.delete(conversationId));
    this.creating.set(conversationId, work);
    return work;
  }

  private async create(conversationId: string): Promise<RunInfo | null> {
    const conversation = this.options.conversations.get(conversationId);
    if (!conversation?.folder) return null;
    const folder = conversation.folder;
    const existing = this.row(conversationId);
    if (existing && existing.folder === folder) {
      await this.repair(existing);
      return toRun(existing);
    }
    if (existing) await this.remove(conversationId);

    const { status } = await this.check(folder);
    if (status !== 'ready') return null;
    const info = (await repoInfo(folder))!;
    const id = randomUUID();
    const name = this.options.workName?.(conversationId) ?? `chat-${conversationId.slice(0, 8)}`;
    const worktree = join(this.options.worktreesDir, repoKey(info.root), name);
    const branch = `clanks/${name}`;
    try {
      await addWorktree({ repoRoot: info.root, path: worktree, branch, base: info.head! });
      const row: RunRow = {
        id,
        conversationId,
        clankId: conversation.clankId,
        folder,
        repoRoot: info.root,
        worktree,
        branch,
        baseCommit: info.head!,
        checkpointsDir: join(this.options.checkpointsDir, `${id}.git`),
        createdAt: this.now(),
      };
      const shadow = new ShadowRepo(row.checkpointsDir, worktree);
      const exclude = readText(join(info.commonDir, 'info', 'exclude'));
      const base = await shadow.init(info.head!, join(info.commonDir, 'objects'), exclude);
      this.options.db.transaction((tx) => {
        tx.insert(runTable).values(row).run();
        tx.insert(checkpointTable)
          .values({
            id: randomUUID(),
            runId: id,
            seq: 0,
            commit: base,
            author: 'base',
            label: `Started from ${info.head!.slice(0, 7)}`,
            messageId: null,
            toolCallId: null,
            // Rewinding to the start keeps the chat up to the message that began the work.
            afterMessageId: this.options.conversations.lastMessageId(conversationId),
            files: [],
            head: info.head,
            rewound: false,
            createdAt: row.createdAt,
          })
          .run();
      });
      this.emit('change', conversationId);
      return toRun(row);
    } catch (error) {
      throw new WorkspaceError(
        `Couldn't make a workspace for ${folder}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A worktree deleted from outside the app is made again from its branch. */
  private async repair(row: RunRow): Promise<void> {
    if (existsSync(join(row.worktree, '.git'))) return;
    await addWorktree({
      repoRoot: row.repoRoot,
      path: row.worktree,
      branch: row.branch,
      base: row.baseCommit,
    });
  }

  /** Why a folder can or can't have a workspace. */
  private async check(folder: string): Promise<{ status: WorkspaceStatus; error: string | null }> {
    if (!existsSync(folder)) return { status: 'error', error: `${folder} isn't there any more` };
    if (!(await gitVersion())) return { status: 'no_git', error: null };
    try {
      const info = await repoInfo(folder);
      if (!info) return { status: 'not_repo', error: null };
      if (!info.head) return { status: 'no_commits', error: null };
      return { status: 'ready', error: null };
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Makes the chat's folder a git repository, with everything in it committed, then a workspace. */
  async setupGit(conversationId: string): Promise<RunInfo | null> {
    const folder = this.options.conversations.get(conversationId)?.folder;
    if (!folder) throw new WorkspaceError('This chat is not about a folder');
    const info = await repoInfo(folder);
    if (info?.head) return this.ensure(conversationId);
    try {
      if (info) {
        await git(['add', '-A'], { cwd: info.root });
        await git(['commit', '--allow-empty', '-m', 'Initial commit'], {
          cwd: info.root,
          env: { GIT_AUTHOR_NAME: 'clanks', GIT_AUTHOR_EMAIL: 'clanks@localhost' },
        });
      } else {
        await initRepo(folder);
      }
    } catch (error) {
      throw new WorkspaceError(
        `Couldn't set up git in ${folder}: ${error instanceof GitError ? error.stderr || error.message : String(error)}`,
      );
    }
    this.emit('change', conversationId);
    return this.ensure(conversationId);
  }

  /**
   * Removes a chat's worktree. Work left in it is committed to its branch first, and the branch
   * stays, so nothing a clank did is lost.
   */
  async remove(conversationId: string): Promise<void> {
    const row = this.row(conversationId);
    if (!row) return;
    await this.lock(row.id, async () => {
      const title = this.options.conversations.get(conversationId)?.title ?? 'a chat';
      await removeWorktree({
        repoRoot: row.repoRoot,
        path: row.worktree,
        message: `Work left in "${title}"`,
      }).catch((error: unknown) => console.error('Removing a worktree failed', error));
      rmSync(row.checkpointsDir, { recursive: true, force: true, maxRetries: 3 });
      this.options.db.delete(runTable).where(eq(runTable.id, row.id)).run();
    });
    this.emit('change', conversationId);
  }

  /**
   * Records the worktree as a checkpoint if it changed since the last one. Clank checkpoints name
   * the reply and tool call that made them; user checkpoints, the chat's last message.
   */
  async checkpoint(
    conversationId: string,
    meta: { author: 'clank' | 'user'; label: string; messageId?: string; toolCallId?: string },
  ): Promise<Checkpoint | null> {
    const row = this.row(conversationId);
    if (!row) return null;
    const made = await this.lock(row.id, () => this.snapshot(row, meta));
    if (made) this.emit('change', conversationId);
    return made;
  }

  /** Takes a checkpoint. Call with the run's lock held. */
  private async snapshot(
    row: RunRow,
    meta: { author: 'clank' | 'user'; label: string; messageId?: string; toolCallId?: string },
  ): Promise<Checkpoint | null> {
    const shadow = this.shadow(row);
    const commit = await shadow.snapshot(meta.label);
    if (!commit) return null;
    const previous = this.latest(row.id);
    const files = previous ? await shadow.changes(previous.commit, commit) : [];
    const head = await git(['rev-parse', 'HEAD'], { cwd: row.worktree }).catch(() => null);
    const last = this.options.db
      .select({ seq: checkpointTable.seq })
      .from(checkpointTable)
      .where(eq(checkpointTable.runId, row.id))
      .orderBy(desc(checkpointTable.seq))
      .limit(1)
      .get();
    const value = {
      id: randomUUID(),
      runId: row.id,
      seq: (last?.seq ?? 0) + 1,
      commit,
      author: meta.author,
      label: meta.label,
      messageId: meta.messageId ?? null,
      toolCallId: meta.toolCallId ?? null,
      afterMessageId:
        meta.author === 'user'
          ? this.options.conversations.lastMessageId(row.conversationId)
          : null,
      files,
      head,
      rewound: false,
      createdAt: this.now(),
    };
    this.options.db.insert(checkpointTable).values(value).run();
    return value;
  }

  /** What changed between two checkpoints, or a checkpoint and the worktree now. */
  async files(conversationId: string, from: DiffSide, to: DiffSide): Promise<ChangedFile[]> {
    const row = this.require(conversationId);
    return this.lock(row.id, async () => {
      const shadow = this.shadow(row);
      return shadow.changes(await this.treeish(row, from), await this.treeish(row, to));
    });
  }

  /** One file on both sides of a comparison, for the diff editor. */
  async file(
    conversationId: string,
    input: { path: string; oldPath?: string | null; from: DiffSide; to: DiffSide },
  ): Promise<FileVersions> {
    const row = this.require(conversationId);
    return this.lock(row.id, async () => {
      const shadow = this.shadow(row);
      const fromTree = await this.treeish(row, input.from);
      const originalPath = input.oldPath ?? input.path;
      const [originalSize, original] = await Promise.all([
        shadow.size(fromTree, originalPath),
        shadow
          .read(fromTree, originalPath)
          .then((b) => (b && b.length <= MAX_SHOWN_BYTES ? b : null)),
      ]);
      let modified: Buffer | null;
      let modifiedSize: number | null;
      if (input.to === 'live') {
        const full = this.inside(row, input.path);
        modified = existsSync(full) && statSync(full).isFile() ? readFileSync(full) : null;
        modifiedSize = modified?.length ?? null;
      } else {
        const toTree = await this.treeish(row, input.to);
        modifiedSize = await shadow.size(toTree, input.path);
        modified = await shadow.read(toTree, input.path);
      }
      const tooLarge =
        (originalSize ?? 0) > MAX_SHOWN_BYTES || (modifiedSize ?? 0) > MAX_SHOWN_BYTES;
      const binary = [original, modified].some((b) => b !== null && isBinary(b));
      const shown = !tooLarge && !binary;
      const originalText = shown && original ? original.toString('utf8') : null;
      const modifiedText = shown && modified && !tooLarge ? modified.toString('utf8') : null;
      const live = input.to === 'live';
      return {
        path: input.path,
        original: originalText,
        modified: modifiedText,
        binary,
        tooLarge,
        hunks: live && shown ? computeHunks(originalText ?? '', modifiedText ?? '') : [],
        hash: live ? (modified ? sha256(modified) : ABSENT) : null,
      };
    });
  }

  /**
   * Puts one changed run of lines back as it was at `from`, records it as the user's checkpoint
   * and leaves a note for the clank.
   */
  async rejectHunk(input: {
    conversationId: string;
    path: string;
    from: string;
    hunk: Hunk;
    hash: string;
    comment: string;
  }): Promise<ReviewNote> {
    const row = this.require(input.conversationId);
    const note = await this.lock(row.id, async () => {
      const full = this.inside(row, input.path);
      const current = this.liveText(full, input.hash, input.path);
      const originalBuffer = await this.shadow(row).read(
        await this.treeish(row, input.from),
        input.path,
      );
      const original = originalBuffer?.toString('utf8') ?? '';
      const hunks = computeHunks(original, current ?? '');
      if (!hunks.some((h) => sameHunk(h, input.hunk))) {
        throw new WorkspaceError(
          `${input.path} changed since you looked. Look again, then reject.`,
        );
      }
      const rejected = splitLines(current ?? '')
        .slice(
          input.hunk.modifiedCount ? input.hunk.modifiedStart - 1 : 0,
          input.hunk.modifiedCount ? input.hunk.modifiedStart - 1 + input.hunk.modifiedCount : 0,
        )
        .join('');
      const next = revertHunk(original, current ?? '', input.hunk);
      if (originalBuffer === null && next === '') {
        if (existsSync(full)) unlinkSync(full);
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, next);
      }
      const made = await this.snapshot(row, {
        author: 'user',
        label: `You rejected a change in ${input.path}`,
      });
      // Where the restored lines are now: where the rejected ones started.
      const { modifiedStart, modifiedCount, originalCount } = input.hunk;
      const start = Math.max(1, modifiedCount ? modifiedStart : modifiedStart + 1);
      const end = originalCount ? start + originalCount - 1 : start;
      return this.addNote(row, {
        kind: 'reject',
        path: input.path,
        startLine: start,
        endLine: end,
        body: input.comment,
        excerpt: excerptOf(rejected, 1, splitLines(rejected).length, 12),
        checkpointId: made?.id ?? null,
      });
    });
    this.emit('change', input.conversationId);
    return note;
  }

  /** Saves the user's edit of a file from the diff editor. */
  async saveFile(input: {
    conversationId: string;
    path: string;
    content: string;
    hash: string | null;
  }): Promise<ReviewNote | null> {
    const row = this.require(input.conversationId);
    const note = await this.lock(row.id, async () => {
      const full = this.inside(row, input.path);
      const before = input.hash === null ? null : this.liveText(full, input.hash, input.path);
      if (before === input.content) return null;
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, input.content);
      const made = await this.snapshot(row, { author: 'user', label: `You edited ${input.path}` });
      const ranges = changedRanges(before ?? '', input.content);
      const start = ranges[0]?.start ?? 1;
      const end = ranges.at(-1)?.end ?? start;
      return this.addNote(row, {
        kind: 'edit',
        path: input.path,
        startLine: start,
        endLine: end,
        body: ranges
          .map((r) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`))
          .join(', '),
        excerpt: excerptOf(input.content, start, end, 12),
        checkpointId: made?.id ?? null,
      });
    });
    this.emit('change', input.conversationId);
    return note;
  }

  /** A comment on some lines, for the clank. Changes nothing. */
  comment(input: {
    conversationId: string;
    path: string;
    startLine: number;
    endLine: number;
    body: string;
  }): ReviewNote {
    const row = this.require(input.conversationId);
    const full = this.inside(row, input.path);
    const text = existsSync(full) ? readFileSync(full, 'utf8') : '';
    const start = Math.min(input.startLine, input.endLine);
    const end = Math.max(input.startLine, input.endLine);
    const note = this.addNote(row, {
      kind: 'comment',
      path: input.path,
      startLine: start,
      endLine: end,
      body: input.body,
      excerpt: excerptOf(text, start, end, 12),
      checkpointId: null,
    });
    this.emit('change', input.conversationId);
    return note;
  }

  deleteNote(conversationId: string, id: string): void {
    const row = this.require(conversationId);
    this.options.db
      .delete(reviewNote)
      .where(
        and(eq(reviewNote.id, id), eq(reviewNote.runId, row.id), eq(reviewNote.status, 'pending')),
      )
      .run();
    this.emit('change', conversationId);
  }

  /** Notes the clank hasn't had yet, oldest first. */
  pendingNotes(conversationId: string): ReviewNote[] {
    const row = this.row(conversationId);
    return row ? this.notes(row.id).filter((n) => n.status === 'pending') : [];
  }

  markSent(conversationId: string, ids: string[]): void {
    if (ids.length === 0) return;
    const sentAt = this.now();
    for (const id of ids) {
      this.options.db
        .update(reviewNote)
        .set({ status: 'sent', sentAt })
        .where(eq(reviewNote.id, id))
        .run();
    }
    this.emit('change', conversationId);
  }

  /**
   * Puts the worktree back as it was at a checkpoint. Later checkpoints are marked rewound and
   * notes made since are dropped. Notes made before it but sent after are pending again: the chat
   * that carried them is cut. Returns the checkpoint, so the chat can be cut back to it.
   */
  async rewind(conversationId: string, checkpointId: string): Promise<Checkpoint> {
    const row = this.require(conversationId);
    const target = await this.lock(row.id, async () => {
      const found = this.checkpoints(row.id).find((c) => c.id === checkpointId);
      if (!found || found.rewound) throw new WorkspaceError("That checkpoint isn't there any more");
      const shadow = this.shadow(row);
      await shadow.restore(found.commit);
      await shadow.resetTo(found.commit);
      // Commits the clank made since come off the branch; their changes are already undone.
      const head = await git(['rev-parse', 'HEAD'], { cwd: row.worktree }).catch(() => null);
      if (found.head && head && head !== found.head) {
        await git(['reset', '--quiet', '--mixed', found.head], { cwd: row.worktree });
      }
      this.options.db
        .update(checkpointTable)
        .set({ rewound: true })
        .where(and(eq(checkpointTable.runId, row.id), gt(checkpointTable.seq, found.seq)))
        .run();
      // Notes made since go, but not the one made with the checkpoint, a moment after it.
      this.options.db
        .delete(reviewNote)
        .where(
          and(
            eq(reviewNote.runId, row.id),
            gt(reviewNote.createdAt, found.createdAt),
            or(isNull(reviewNote.checkpointId), ne(reviewNote.checkpointId, found.id)),
          ),
        )
        .run();
      // A note sent in the same millisecond as the checkpoint was still sent after it.
      this.options.db
        .update(reviewNote)
        .set({ status: 'pending', sentAt: null })
        .where(and(eq(reviewNote.runId, row.id), gte(reviewNote.sentAt, found.createdAt)))
        .run();
      return found;
    });
    this.emit('change', conversationId);
    return target;
  }

  checkpoints(runId: string): Checkpoint[] {
    return this.options.db
      .select()
      .from(checkpointTable)
      .where(eq(checkpointTable.runId, runId))
      .orderBy(asc(checkpointTable.seq))
      .all();
  }

  /** The newest checkpoint a rewind hasn't undone. */
  private latest(runId: string): Checkpoint | undefined {
    return this.checkpoints(runId)
      .filter((c) => !c.rewound)
      .at(-1);
  }

  private notes(runId: string): ReviewNote[] {
    return this.options.db
      .select()
      .from(reviewNote)
      .where(eq(reviewNote.runId, runId))
      .orderBy(asc(reviewNote.createdAt))
      .all();
  }

  private addNote(
    row: RunRow,
    note: Omit<ReviewNote, 'id' | 'runId' | 'status' | 'sentAt' | 'createdAt'>,
  ): ReviewNote {
    const value: ReviewNote = {
      ...note,
      id: randomUUID(),
      runId: row.id,
      status: 'pending',
      sentAt: null,
      createdAt: this.now(),
    };
    this.options.db.insert(reviewNote).values(value).run();
    return value;
  }

  /** The live file's text, checked against the hash the user's view was made from. */
  private liveText(full: string, hash: string, path: string): string | null {
    const exists = existsSync(full) && statSync(full).isFile();
    const buffer = exists ? readFileSync(full) : null;
    const actual = buffer ? sha256(buffer) : ABSENT;
    if (actual !== hash) {
      throw new WorkspaceError(`${path} changed since you looked. Look again, then try once more.`);
    }
    return buffer?.toString('utf8') ?? null;
  }

  private inside(row: RunRow, path: string): string {
    try {
      return resolveInside(row.worktree, row.worktree, path);
    } catch (error) {
      if (error instanceof PathError) throw new WorkspaceError(error.message);
      throw error;
    }
  }

  private async treeish(row: RunRow, side: DiffSide): Promise<string> {
    if (side === 'live') return this.shadow(row).tree();
    const found = this.options.db
      .select({ commit: checkpointTable.commit })
      .from(checkpointTable)
      .where(and(eq(checkpointTable.id, side), eq(checkpointTable.runId, row.id)))
      .get();
    if (!found) throw new WorkspaceError("That checkpoint isn't there any more");
    return found.commit;
  }

  private shadow(row: RunRow): ShadowRepo {
    return new ShadowRepo(row.checkpointsDir, row.worktree);
  }

  private row(conversationId: string): RunRow | undefined {
    return this.options.db
      .select()
      .from(runTable)
      .where(eq(runTable.conversationId, conversationId))
      .get();
  }

  private require(conversationId: string): RunRow {
    const row = this.row(conversationId);
    if (!row) throw new WorkspaceError('This chat has no workspace yet');
    return row;
  }

  /** Runs one job at a time per run, so git never meets its own lock file. */
  private lock<T>(runId: string, job: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(runId) ?? Promise.resolve();
    const next = previous.then(job, job);
    const settled = next.catch(() => {});
    this.locks.set(runId, settled);
    void settled.then(() => {
      if (this.locks.get(runId) === settled) this.locks.delete(runId);
    });
    return next;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function toRun(row: RunRow): RunInfo {
  const sub = subfolderOf(row.repoRoot, row.folder);
  return {
    id: row.id,
    conversationId: row.conversationId,
    folder: row.folder,
    repoRoot: row.repoRoot,
    worktree: row.worktree,
    cwd: sub && !sub.startsWith('..') ? join(row.worktree, sub) : row.worktree,
    branch: row.branch,
    baseCommit: row.baseCommit,
    createdAt: row.createdAt,
  };
}

/** A folder name for a repository's worktrees: its name, and a hash so two `app`s don't meet. */
function repoKey(root: string): string {
  const name =
    basename(root)
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 40) || 'repo';
  return `${name}-${sha256(root.toLowerCase()).slice(0, 8)}`;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
