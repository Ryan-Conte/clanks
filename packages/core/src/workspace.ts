import { z } from 'zod';
import { conversationIdSchema } from './conversations';

/**
 * Where a chat's files are. A chat about a folder in a git repository works on its own worktree of
 * it, so the user's checkout is never touched.
 */
export type WorkspaceStatus =
  /** The chat isn't about a folder, so there are no files to work on. */
  | 'none'
  /** git isn't installed, and worktrees need it. */
  | 'no_git'
  /** The folder isn't in a git repository. The user can make it one. */
  | 'not_repo'
  /** A repository with nothing committed yet, so there's nothing to branch from. */
  | 'no_commits'
  /** The chat has a worktree, or will make one on its next reply. */
  | 'ready'
  | 'error';

/** One clank's run on a copy of a repository: its worktree and branch. */
export interface RunInfo {
  id: string;
  conversationId: string;
  /** The folder the chat is about. */
  folder: string;
  /** The root of the repository it's in. */
  repoRoot: string;
  /** The run's own checkout. */
  worktree: string;
  /** Where in the worktree the folder is: the worktree itself unless the folder is a subfolder. */
  cwd: string;
  /** `clanks/chat-<id>`. */
  branch: string;
  /** The commit the branch started from. */
  baseCommit: string;
  createdAt: Date;
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  /** Relative to the worktree, with forward slashes. */
  path: string;
  /** For renames: where it was. */
  oldPath: string | null;
  status: FileChangeStatus;
  added: number;
  removed: number;
  binary: boolean;
}

/** The worktree as it was after a tool call or a user edit that changed files. */
export interface Checkpoint {
  id: string;
  runId: string;
  /** 0 is the base; each checkpoint after it counts up. */
  seq: number;
  /** In the run's shadow repository, never the user's. */
  commit: string;
  author: 'base' | 'clank' | 'user';
  label: string;
  /** The reply and the tool call that made it, for clank checkpoints. */
  messageId: string | null;
  toolCallId: string | null;
  /** The chat's last message when the user made it, for user checkpoints. */
  afterMessageId: string | null;
  /** What changed since the checkpoint before. */
  files: ChangedFile[];
  /** The run branch's commit at the time, so a rewind can put it back. */
  head: string | null;
  /** A later rewind went back past it. */
  rewound: boolean;
  createdAt: Date;
}

/** Feedback for the clank from the diff editor, sent with the user's next message. */
export type ReviewNoteKind = 'reject' | 'comment' | 'edit';

export interface ReviewNote {
  id: string;
  runId: string;
  kind: ReviewNoteKind;
  path: string;
  /** Lines in the file as it is now, 1-based and inclusive. Null for a whole-file note. */
  startLine: number | null;
  endLine: number | null;
  /** The user's words. Empty for an edit or a rejection they didn't explain. */
  body: string;
  /** The lines the note is about, so the clank can find them. */
  excerpt: string;
  checkpointId: string | null;
  /** Sent notes went to the clank, inside a reply or with a message. */
  status: 'pending' | 'sent';
  sentAt: Date | null;
  createdAt: Date;
}

export interface WorkspaceState {
  status: WorkspaceStatus;
  /** Why, for `error`. */
  error: string | null;
  folder: string | null;
  run: RunInfo | null;
  checkpoints: Checkpoint[];
  notes: ReviewNote[];
}

/** A run of changed lines between two versions of a file. Lines are 1-based. */
export interface Hunk {
  /** The first changed line in the original, or the line before an insertion (0 at the top). */
  originalStart: number;
  originalCount: number;
  /** The first changed line in the modified file, or the line before a deletion. */
  modifiedStart: number;
  modifiedCount: number;
}

/** Two versions of one file, for the diff editor. */
export interface FileVersions {
  path: string;
  /** Null when the file didn't exist on that side. */
  original: string | null;
  modified: string | null;
  binary: boolean;
  /** Too big to show; the sizes are still known. */
  tooLarge: boolean;
  /** The changed runs, when the modified side is the live worktree and can be edited. */
  hunks: Hunk[];
  /** A hash of the live file, so an edit or rejection can't overwrite a change it never saw. */
  hash: string | null;
}

/** A side of a comparison: a checkpoint's id, or the worktree as it is now. */
export const diffSideSchema = z.union([z.literal('live'), z.uuid()]);

export type DiffSide = z.infer<typeof diffSideSchema>;

const relativePathSchema = z.string().trim().min(1).max(1000);

const hunkSchema = z.object({
  originalStart: z.number().int().min(0),
  originalCount: z.number().int().min(0),
  modifiedStart: z.number().int().min(0),
  modifiedCount: z.number().int().min(0),
});

export const rejectHunkSchema = z.object({
  conversationId: conversationIdSchema,
  path: relativePathSchema,
  /** The checkpoint the diff compared against, whose lines come back. */
  from: z.uuid(),
  hunk: hunkSchema,
  hash: z.string().min(1),
  comment: z.string().trim().max(4000).default(''),
});

export const saveFileSchema = z.object({
  conversationId: conversationIdSchema,
  path: relativePathSchema,
  content: z.string().max(5_000_000),
  hash: z.string().nullable(),
});

export const commentSchema = z.object({
  conversationId: conversationIdSchema,
  path: relativePathSchema,
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  body: z.string().trim().min(1).max(4000),
});

/** A command a clank ran, or the user's own shell. */
export interface TerminalSession {
  id: string;
  conversationId: string;
  kind: 'clank' | 'user';
  /** The command, or "Your shell". */
  title: string;
  cwd: string;
  state: 'running' | 'exited' | 'stopped' | 'failed';
  exitCode: number | null;
  /** Started with `shell_start`, so it keeps running after its tool call. */
  background: boolean;
  toolCallId: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

export type TerminalLiveEvent =
  | { type: 'sessions'; sessions: TerminalSession[] }
  | { type: 'output'; sessionId: string; data: string };

export type ActivityKind = 'model' | 'tool' | 'checkpoint' | 'review' | 'rewind' | 'workspace';

/** One step on a chat's activity timeline. */
export interface ActivityEvent {
  id: number;
  conversationId: string;
  messageId: string | null;
  kind: ActivityKind;
  title: string;
  /** What went in: a tool's arguments, a model call's summary. */
  input: string | null;
  /** What came out. */
  output: string | null;
  status: 'ok' | 'error' | 'denied' | 'cancelled' | null;
  toolCallId: string | null;
  checkpointId: string | null;
  sessionId: string | null;
  startedAt: Date;
  durationMs: number | null;
}
