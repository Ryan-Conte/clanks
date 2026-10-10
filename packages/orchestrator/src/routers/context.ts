import {
  type ContextSnapshot,
  type HomeSnapshot,
  clankIdSchema,
  memoryPatchSchema,
  newNoteSchema,
  notePatchSchema,
  projectIdSchema,
  ticketIdSchema,
} from '@clanks/core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readProjectInstructions } from '../crew/instructions';
import { userProcedure } from '../procedures';
import { type OrchestratorContext, publicProcedure, router } from '../trpc';
import { snapshots } from './live';

const INTERVAL_MS = 250;

/** The most `CLANKS.md` the Context tab saves: it's instructions, in every prompt. */
const MAX_INSTRUCTIONS = 64 * 1024;

function contextSnapshot(ctx: OrchestratorContext, projectId: string): ContextSnapshot {
  const project = ctx.projects.get(projectId);
  return {
    notes: ctx.context.notes(projectId, ['provisional', 'active', 'superseded', 'dropped']),
    memory: ctx.context.memories(projectId),
    instructions: readProjectInstructions(project.folder),
  };
}

export const contextRouter = router({
  /** A project's notes, its clanks' memories and its `CLANKS.md`, sent again when they change. */
  live: publicProcedure.input(projectIdSchema).subscription(async function* ({
    ctx,
    input,
    signal,
  }): AsyncGenerator<ContextSnapshot> {
    yield* snapshots({
      signal,
      intervalMs: INTERVAL_MS,
      subscribe: (onChange) => {
        const on = (projectId: string) => {
          if (projectId === input) onChange();
        };
        ctx.context.on('change', on);
        return () => ctx.context.off('change', on);
      },
      snapshot: () => contextSnapshot(ctx, input),
    });
  }),

  get: userProcedure.input(projectIdSchema).query(({ ctx, input }) => contextSnapshot(ctx, input)),

  /** A note the user writes is active from the start: it's theirs. */
  addNote: userProcedure.input(newNoteSchema).mutation(({ ctx, input }) => {
    ctx.projects.get(input.projectId);
    return ctx.context.addNote({
      ...input,
      author: 'user',
      ticketId: null,
      status: 'active',
    });
  }),

  updateNote: userProcedure
    .input(z.object({ id: z.uuid(), patch: notePatchSchema }))
    .mutation(({ ctx, input }) => ctx.context.updateNote(input.id, input.patch)),

  deleteNote: userProcedure
    .input(z.uuid())
    .mutation(({ ctx, input }) => ctx.context.deleteNote(input)),

  updateMemory: userProcedure
    .input(z.object({ id: z.uuid(), patch: memoryPatchSchema }))
    .mutation(({ ctx, input }) => ctx.context.updateMemory(input.id, input.patch.body)),

  deleteMemory: userProcedure
    .input(z.uuid())
    .mutation(({ ctx, input }) => ctx.context.deleteMemory(input)),

  /**
   * Saves `CLANKS.md` at the root of the project's workspace, where any editor can change it too.
   * The crew picks it up at its next run.
   */
  saveInstructions: userProcedure
    .input(z.object({ projectId: projectIdSchema, text: z.string().max(MAX_INSTRUCTIONS) }))
    .mutation(({ ctx, input }) => {
      const project = ctx.projects.get(input.projectId);
      const existing = readProjectInstructions(project.folder);
      // AGENTS.md stays AGENTS.md when that's what the project has.
      const file = existing?.file ?? 'CLANKS.md';
      writeFileSync(join(project.folder, file), input.text.replace(/\r\n/g, '\n'));
      ctx.context.emit('change', project.id);
      return { file };
    }),

  /** Exactly what a clank would be told on a ticket, or in a chat in the project, layer by layer. */
  preview: userProcedure
    .input(
      z.object({
        projectId: projectIdSchema,
        clankId: clankIdSchema,
        ticketId: ticketIdSchema.nullable(),
      }),
    )
    .query(({ ctx, input }) => {
      let role: 'maker' | 'checker' | null = null;
      if (input.ticketId) {
        const ticket = ctx.board.ticket(input.ticketId);
        role = ticket.route.find((s) => s.clankId === input.clankId)?.role ?? 'maker';
      }
      return ctx.chat.previewTicket(input.projectId, input.clankId, input.ticketId, role);
    }),
});

export const homeRouter = router({
  get: userProcedure.query(({ ctx }) => ctx.board.home()),

  /** Home, sent again whenever any board or the crew's replies change. */
  live: publicProcedure.subscription(async function* ({
    ctx,
    signal,
  }): AsyncGenerator<HomeSnapshot> {
    yield* snapshots({
      signal,
      intervalMs: 500,
      subscribe: (onChange) => {
        ctx.board.on('change', onChange);
        ctx.chat.on('list', onChange);
        return () => {
          ctx.board.off('change', onChange);
          ctx.chat.off('list', onChange);
        };
      },
      snapshot: () => ctx.board.home(),
    });
  }),
});
