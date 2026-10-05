import {
  type ActivityEvent,
  type TerminalLiveEvent,
  type TerminalSession,
  type WorkspaceState,
  commentSchema,
  conversationIdSchema,
  diffSideSchema,
  rejectHunkSchema,
  saveFileSchema,
} from '@clanks/core';
import { z } from 'zod';
import { userProcedure } from '../procedures';
import { publicProcedure, router } from '../trpc';
import { WorkspaceError } from '../workspace/service';
import { snapshots, stream } from './live';

/** The workbench beside a chat: its workspace and diffs, its terminal and its activity. */
export const workspaceRouter = router({
  state: userProcedure
    .input(conversationIdSchema)
    .query(({ ctx, input }) => ctx.workspace.state(input)),

  /** The chat's workspace, sent again whenever a checkpoint or a note is added. */
  live: publicProcedure.input(conversationIdSchema).subscription(async function* ({
    ctx,
    input,
    signal,
  }): AsyncGenerator<WorkspaceState> {
    yield* snapshots({
      signal,
      intervalMs: 150,
      subscribe: (onChange) => {
        const onWorkspace = (id: string) => id === input && onChange();
        // The chat's folder lives on the chat.
        const onLive = (id: string, event: { type: string }) =>
          id === input && event.type === 'conversation' && onChange();
        ctx.workspace.on('change', onWorkspace);
        ctx.chat.on('live', onLive);
        return () => {
          ctx.workspace.off('change', onWorkspace);
          ctx.chat.off('live', onLive);
        };
      },
      snapshot: () => ctx.workspace.state(input),
    });
  }),

  files: userProcedure
    .input(
      z.object({ conversationId: conversationIdSchema, from: diffSideSchema, to: diffSideSchema }),
    )
    .query(({ ctx, input }) => ctx.workspace.files(input.conversationId, input.from, input.to)),

  file: userProcedure
    .input(
      z.object({
        conversationId: conversationIdSchema,
        path: z.string().min(1).max(1000),
        oldPath: z.string().min(1).max(1000).nullable().optional(),
        from: diffSideSchema,
        to: diffSideSchema,
      }),
    )
    .query(({ ctx, input }) => ctx.workspace.file(input.conversationId, input)),

  rejectHunk: userProcedure
    .input(rejectHunkSchema)
    .mutation(({ ctx, input }) => ctx.workspace.rejectHunk(input)),

  saveFile: userProcedure
    .input(saveFileSchema)
    .mutation(({ ctx, input }) => ctx.workspace.saveFile(input)),

  comment: userProcedure
    .input(commentSchema)
    .mutation(({ ctx, input }) => ctx.workspace.comment(input)),

  deleteNote: userProcedure
    .input(z.object({ conversationId: conversationIdSchema, id: z.uuid() }))
    .mutation(({ ctx, input }) => ctx.workspace.deleteNote(input.conversationId, input.id)),

  /** Puts the files back as they were at a checkpoint and cuts the chat back to it. */
  rewind: userProcedure
    .input(z.object({ conversationId: conversationIdSchema, checkpointId: z.uuid() }))
    .mutation(({ ctx, input }) => ctx.chat.rewind(input.conversationId, input.checkpointId)),

  /** Makes the chat's folder a git repository, so the clank can work on a copy of it. */
  setupGit: userProcedure.input(conversationIdSchema).mutation(async ({ ctx, input }) => {
    await ctx.workspace.setupGit(input);
  }),

  /** Opens the chat's worktree in the system file manager. */
  openFolder: userProcedure.input(conversationIdSchema).mutation(async ({ ctx, input }) => {
    const run = ctx.workspace.run(input);
    if (!run) throw new WorkspaceError('This chat has no workspace yet');
    await ctx.host?.openFolder(run.cwd);
  }),

  terminal: router({
    /** The chat's commands and shells, sent again whenever one starts or ends. */
    sessions: publicProcedure.input(conversationIdSchema).subscription(async function* ({
      ctx,
      input,
      signal,
    }): AsyncGenerator<TerminalSession[]> {
      yield* snapshots({
        signal,
        intervalMs: 100,
        subscribe: (onChange) => {
          const handler = (id: string) => id === input && onChange();
          ctx.terminal.on('sessions', handler);
          return () => ctx.terminal.off('sessions', handler);
        },
        snapshot: () => ctx.terminal.list(input),
      });
    }),

    /** One session's output: everything kept so far, then each new piece as it prints. */
    output: publicProcedure.input(z.uuid()).subscription(async function* ({
      ctx,
      input,
      signal,
    }): AsyncGenerator<Extract<TerminalLiveEvent, { type: 'output' }>> {
      yield* stream<Extract<TerminalLiveEvent, { type: 'output' }>>({
        signal,
        subscribe: (push) => {
          const handler = (_conversationId: string, sessionId: string, data: string) => {
            if (sessionId === input) push({ type: 'output', sessionId, data });
          };
          ctx.terminal.on('output', handler);
          return () => ctx.terminal.off('output', handler);
        },
        start: () => [{ type: 'output', sessionId: input, data: ctx.terminal.output(input) }],
        merge: (last, next) => {
          last.data += next.data;
          return true;
        },
      });
    }),

    /** Opens the user's own shell in the chat's worktree. */
    open: userProcedure
      .input(
        z.object({
          conversationId: conversationIdSchema,
          cols: z.number().int().min(2).max(1000),
          rows: z.number().int().min(1).max(500),
        }),
      )
      .mutation(({ ctx, input }) => {
        const run = ctx.workspace.run(input.conversationId);
        if (!run) throw new WorkspaceError('This chat has no workspace yet');
        return ctx.terminal.openShell({ ...input, cwd: run.cwd });
      }),

    input: publicProcedure
      .input(z.object({ sessionId: z.uuid(), data: z.string().max(65_536) }))
      .mutation(({ ctx, input }) => ctx.terminal.input(input.sessionId, input.data)),

    resize: publicProcedure
      .input(
        z.object({
          sessionId: z.uuid(),
          cols: z.number().int().min(2).max(1000),
          rows: z.number().int().min(1).max(500),
        }),
      )
      .mutation(({ ctx, input }) => ctx.terminal.resize(input.sessionId, input.cols, input.rows)),

    stop: publicProcedure.input(z.uuid()).mutation(({ ctx, input }) => ctx.terminal.stop(input)),

    clear: publicProcedure
      .input(conversationIdSchema)
      .mutation(({ ctx, input }) => ctx.terminal.clear(input)),
  }),

  /** The chat's activity: everything so far, then each step as it happens. */
  activity: publicProcedure.input(conversationIdSchema).subscription(async function* ({
    ctx,
    input,
    signal,
  }): AsyncGenerator<ActivityEvent[]> {
    yield* stream<ActivityEvent[]>({
      signal,
      subscribe: (push) => {
        const handler = (event: ActivityEvent) => {
          if (event.conversationId === input) push([event]);
        };
        ctx.activity.on('event', handler);
        return () => ctx.activity.off('event', handler);
      },
      start: () => [ctx.activity.list(input)],
      merge: (last, next) => {
        last.push(...next);
        return true;
      },
    });
  }),
});
