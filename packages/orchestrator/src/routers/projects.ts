import {
  type BoardSnapshot,
  type ProjectSummary,
  TICKET_COLUMNS,
  clankIdSchema,
  modelChoiceSchema,
  newProjectSchema,
  newTicketSchema,
  projectIdSchema,
  projectPatchSchema,
  specVersionSchema,
  ticketIdSchema,
  ticketPatchSchema,
} from '@clanks/core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ProjectError } from '../projects/service';
import { userProcedure } from '../procedures';
import { publicProcedure, router } from '../trpc';
import { snapshots } from './live';

/** Lists and boards are sent again at most this often, however busy the crew is. */
const INTERVAL_MS = 150;

const folderSchema = z.string().min(1).max(4096);

export const projectsRouter = router({
  list: publicProcedure.query(({ ctx }) => ctx.board.summaries()),

  /** Every project with its counts, sent again whenever one changes. */
  live: publicProcedure.subscription(async function* ({
    ctx,
    signal,
  }): AsyncGenerator<ProjectSummary[]> {
    yield* snapshots({
      signal,
      intervalMs: INTERVAL_MS,
      subscribe: (onChange) => {
        ctx.board.on('change', onChange);
        ctx.chat.on('list', onChange);
        return () => {
          ctx.board.off('change', onChange);
          ctx.chat.off('list', onChange);
        };
      },
      snapshot: () => ctx.board.summaries(),
    });
  }),

  /** Whether a folder can be a workspace as it is, or needs git set up first. */
  checkFolder: userProcedure
    .input(folderSchema)
    .query(({ ctx, input }) => ctx.projects.checkFolder(input)),

  /** Asks for a folder to be a project's workspace. Resolves null if the user cancels. */
  chooseFolder: userProcedure
    .input(z.object({ title: z.string().max(100), defaultPath: folderSchema.optional() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.host) throw new ProjectError("Picking a folder needs the app's file dialog");
      return ctx.host.pickFolder(input);
    }),

  /** Where a clone of a repository would go by default: a free folder under ~/clanks. */
  cloneFolder: publicProcedure.input(z.string().min(1).max(100)).query(({ input }) => {
    const name = input.replace(/[^\w.-]+/g, '-');
    const base = join(homedir(), 'clanks', name);
    let path = base;
    for (let i = 2; existsSync(path); i++) path = `${base}-${i}`;
    return path;
  }),

  create: userProcedure
    .input(newProjectSchema)
    .mutation(({ ctx, input }) => ctx.projects.create(input)),

  update: userProcedure
    .input(z.object({ id: projectIdSchema, patch: projectPatchSchema }))
    .mutation(({ ctx, input }) => ctx.projects.update(input.id, input.patch)),

  /** Adds a clank to the crew, or takes one out. */
  setMember: userProcedure
    .input(z.object({ id: projectIdSchema, clankId: clankIdSchema, included: z.boolean() }))
    .mutation(({ ctx, input }) => ctx.projects.setMember(input.id, input.clankId, input.included)),

  setMemberModel: userProcedure
    .input(
      z.object({
        id: projectIdSchema,
        clankId: clankIdSchema,
        model: modelChoiceSchema.nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.projects.setMemberModel(input.id, input.clankId, input.model),
    ),

  /** Deletes a project, its chats and runs. Its folder and branches stay. */
  delete: userProcedure
    .input(projectIdSchema)
    .mutation(({ ctx, input }) => ctx.board.deleteProject(input)),

  openFolder: userProcedure.input(projectIdSchema).mutation(async ({ ctx, input }) => {
    await ctx.host?.openFolder(ctx.projects.get(input).folder);
  }),
});

export const boardRouter = router({
  /** A project's board, sent again whenever it changes. */
  live: publicProcedure.input(projectIdSchema).subscription(async function* ({
    ctx,
    input,
    signal,
  }): AsyncGenerator<BoardSnapshot> {
    yield* snapshots({
      signal,
      intervalMs: INTERVAL_MS,
      subscribe: (onChange) => {
        const onBoard = (projectId: string) => {
          if (projectId === input) onChange();
        };
        ctx.board.on('change', onBoard);
        // Runs starting and ending change who's working.
        ctx.chat.on('list', onChange);
        return () => {
          ctx.board.off('change', onBoard);
          ctx.chat.off('list', onChange);
        };
      },
      snapshot: () => ctx.board.snapshot(input),
    });
  }),

  snapshot: userProcedure
    .input(projectIdSchema)
    .query(({ ctx, input }) => ctx.board.snapshot(input)),

  /** A card the user adds to the backlog. */
  add: userProcedure
    .input(newTicketSchema)
    .mutation(({ ctx, input }) => ctx.board.addTicket(input)),

  edit: userProcedure
    .input(z.object({ id: ticketIdSchema, patch: ticketPatchSchema }))
    .mutation(({ ctx, input }) => ctx.board.editTicket(input.id, input.patch)),

  assign: userProcedure
    .input(z.object({ id: ticketIdSchema, clankId: clankIdSchema.nullable() }))
    .mutation(({ ctx, input }) => ctx.board.assignTicket(input.id, input.clankId)),

  link: userProcedure
    .input(z.object({ id: ticketIdSchema, dependsOn: ticketIdSchema, remove: z.boolean() }))
    .mutation(({ ctx, input }) => ctx.board.linkTickets(input.id, input.dependsOn, input.remove)),

  /** Puts a backlog card before another, or last. */
  reorder: userProcedure
    .input(z.object({ id: ticketIdSchema, before: ticketIdSchema.nullable() }))
    .mutation(({ ctx, input }) => ctx.board.reorder(input.id, input.before)),

  /** A drag to another column, which the workflow may refuse. */
  move: userProcedure
    .input(z.object({ id: ticketIdSchema, column: z.enum(TICKET_COLUMNS) }))
    .mutation(({ ctx, input }) => ctx.board.move(input.id, input.column)),

  remove: userProcedure
    .input(ticketIdSchema)
    .mutation(({ ctx, input }) => ctx.board.removeTicket(input)),

  accept: userProcedure.input(ticketIdSchema).mutation(({ ctx, input }) => ctx.board.accept(input)),

  approve: userProcedure
    .input(ticketIdSchema)
    .mutation(({ ctx, input }) => ctx.board.approve(input)),

  requestChanges: userProcedure
    .input(z.object({ id: ticketIdSchema, comment: z.string().trim().min(1).max(8000) }))
    .mutation(({ ctx, input }) => ctx.board.requestChanges(input.id, input.comment)),

  retry: userProcedure
    .input(z.object({ id: ticketIdSchema, note: z.string().trim().max(8000).default('') }))
    .mutation(({ ctx, input }) => ctx.board.retry(input.id, input.note)),

  /** A ticket's lines from the activity feed. */
  events: userProcedure
    .input(ticketIdSchema)
    .query(({ ctx, input }) => ctx.board.ticketEvents(input)),

  /** One version of the spec, in full. */
  spec: userProcedure
    .input(z.object({ projectId: projectIdSchema, version: specVersionSchema }))
    .query(({ ctx, input }) => ctx.board.spec(input.projectId, input.version)),
});
