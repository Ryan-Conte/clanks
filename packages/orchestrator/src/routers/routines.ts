import {
  type RoutinesOverview,
  type RoutinesSnapshot,
  projectIdSchema,
  routineIdSchema,
  ticketIdSchema,
} from '@clanks/core';
import { z } from 'zod';
import { userProcedure } from '../procedures';
import { RoutineError } from '../routines/service';
import { publicProcedure, router } from '../trpc';
import { snapshots } from './live';

const inputsSchema = z.record(z.string().max(40), z.string().max(2000));

/** A routine as the editor sends it. The service reads it against the schema and says what's wrong. */
const definitionSchema = z.record(z.string(), z.unknown());

// Routines are made, changed and turned on only from here, by the user. Clanks get tools that
// read and draft, and nothing a scheduled action sends is ever built or changed by a model.
export const routinesRouter = router({
  snapshot: userProcedure
    .input(projectIdSchema)
    .query(({ ctx, input }) => ctx.routines.snapshot(input)),

  /** A project's routines, runs and scheduled actions, sent again when they change. */
  live: publicProcedure.input(projectIdSchema).subscription(async function* ({
    ctx,
    input,
    signal,
  }): AsyncGenerator<RoutinesSnapshot> {
    yield* snapshots({
      signal,
      intervalMs: 200,
      subscribe: (onChange) => {
        const changed = (projectId: string) => {
          if (projectId === input) onChange();
        };
        ctx.routines.on('change', changed);
        ctx.board.on('change', changed);
        ctx.integrations.on('change', onChange);
        ctx.marketplace.on('change', onChange);
        return () => {
          ctx.routines.off('change', changed);
          ctx.board.off('change', changed);
          ctx.integrations.off('change', onChange);
          ctx.marketplace.off('change', onChange);
        };
      },
      snapshot: () => ctx.routines.snapshot(input),
    });
  }),

  /** What's coming up and what needs the user, across every project, for Home. */
  overview: publicProcedure.subscription(async function* ({
    ctx,
    signal,
  }): AsyncGenerator<RoutinesOverview> {
    yield* snapshots({
      signal,
      intervalMs: 1000,
      subscribe: (onChange) => {
        ctx.routines.on('change', onChange);
        ctx.settings.on('change', onChange);
        return () => {
          ctx.routines.off('change', onChange);
          ctx.settings.off('change', onChange);
        };
      },
      snapshot: () => ctx.routines.overview(),
    });
  }),

  /** A schedule typed in words, read back as a trigger with its next five times. */
  previewSchedule: userProcedure
    .input(z.object({ words: z.string().max(300), zone: z.string().max(64) }))
    .query(({ ctx, input }) => ctx.routines.previewSchedule(input.words, input.zone)),

  /** A routine as the editor has it, checked before it's saved: its times, and what's wrong. */
  check: userProcedure
    .input(z.object({ projectId: projectIdSchema, definition: definitionSchema }))
    .query(({ ctx, input }) => ctx.routines.checkDraft(input.projectId, input.definition)),

  create: userProcedure
    .input(z.object({ projectId: projectIdSchema, definition: definitionSchema }))
    .mutation(({ ctx, input }) => ctx.routines.create(input.projectId, input.definition)),

  update: userProcedure
    .input(z.object({ id: routineIdSchema, definition: definitionSchema }))
    .mutation(({ ctx, input }) => ctx.routines.update(input.id, input.definition)),

  activate: userProcedure
    .input(routineIdSchema)
    .mutation(({ ctx, input }) => ctx.routines.activate(input)),

  pause: userProcedure
    .input(routineIdSchema)
    .mutation(({ ctx, input }) => ctx.routines.pause(input)),

  remove: userProcedure
    .input(routineIdSchema)
    .mutation(({ ctx, input }) => ctx.routines.remove(input)),

  duplicate: userProcedure
    .input(routineIdSchema)
    .mutation(({ ctx, input }) => ctx.routines.duplicate(input)),

  runNow: userProcedure
    .input(z.object({ id: routineIdSchema, inputs: inputsSchema.default({}) }))
    .mutation(({ ctx, input }) => ctx.routines.runNow(input.id, input.inputs)),

  /** Sets the inputs one upcoming run uses, in place of the routine's defaults. */
  planRun: userProcedure
    .input(z.object({ id: routineIdSchema, at: z.date(), inputs: inputsSchema }))
    .mutation(({ ctx, input }) => ctx.routines.planRun(input.id, input.at, input.inputs)),

  /** The routine as YAML, in the window, to copy. */
  yaml: userProcedure
    .input(routineIdSchema)
    .query(({ ctx, input }) => ctx.routines.exportYaml(input)),

  /** Asks where to save a routine's YAML, and saves it there. */
  export: userProcedure.input(routineIdSchema).mutation(async ({ ctx, input }) => {
    if (!ctx.host) throw new RoutineError("Saving a file needs the app's file dialog");
    const { name, yaml } = ctx.routines.exportYaml(input);
    const file =
      name
        .replace(/[^\w -]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase() || 'routine';
    return ctx.host.saveFile(
      { title: 'Export the routine', defaultName: `${file}.yaml`, extensions: ['yaml'] },
      Buffer.from(yaml, 'utf8'),
    );
  }),

  /** A routine from YAML someone pasted, as an inactive draft. */
  import: userProcedure
    .input(z.object({ projectId: projectIdSchema, yaml: z.string().min(1).max(200_000) }))
    .mutation(({ ctx, input }) => ctx.routines.importYaml(input.projectId, input.yaml)),

  fromTemplate: userProcedure
    .input(z.object({ projectId: projectIdSchema, templateId: z.string().max(64) }))
    .mutation(({ ctx, input }) => ctx.routines.fromTemplate(input.projectId, input.templateId)),

  answerMissed: userProcedure
    .input(z.object({ runId: z.uuid(), answer: z.enum(['run', 'skip']) }))
    .mutation(({ ctx, input }) => ctx.routines.answerMissed(input.runId, input.answer)),

  cancelRun: userProcedure
    .input(z.uuid())
    .mutation(({ ctx, input }) => ctx.routines.cancelRun(input)),

  refreshRun: userProcedure
    .input(z.uuid())
    .mutation(({ ctx, input }) => ctx.routines.refreshRun(input)),

  /** Approves what a run sends: all of it, or the actions named. The window shows each in full first. */
  approveRun: userProcedure
    .input(z.object({ runId: z.uuid(), actionIds: z.array(z.uuid()).max(50).optional() }))
    .mutation(({ ctx, input }) => ctx.routines.approveRun(input.runId, input.actionIds)),

  approveAction: userProcedure
    .input(z.uuid())
    .mutation(({ ctx, input }) => ctx.routines.approveAction(input)),

  /** Changes an action's words or its time, which asks for approval again. */
  editAction: userProcedure
    .input(
      z.object({
        id: z.uuid(),
        text: z.string().max(20_000).optional(),
        executeAt: z.date().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.routines.editAction(input.id, {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.executeAt ? { executeAt: input.executeAt } : {}),
      }),
    ),

  postNow: userProcedure.input(z.uuid()).mutation(({ ctx, input }) => ctx.routines.postNow(input)),

  reschedule: userProcedure
    .input(z.object({ id: z.uuid(), at: z.date() }))
    .mutation(({ ctx, input }) => ctx.routines.reschedule(input.id, input.at)),

  cancelAction: userProcedure
    .input(z.uuid())
    .mutation(({ ctx, input }) => ctx.routines.cancelAction(input)),

  decideUnknown: userProcedure
    .input(z.object({ id: z.uuid(), decision: z.enum(['sent', 'send', 'drop']) }))
    .mutation(({ ctx, input }) => ctx.routines.decideUnknown(input.id, input.decision)),

  /** A file an action sends, as a picture for its card. */
  media: userProcedure
    .input(z.object({ actionId: z.uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
    .query(({ ctx, input }) => ctx.routines.media(input.actionId, input.sha256)),

  /** A campaign's posts as they'd be scheduled, with what's missing for each. */
  campaignPlan: userProcedure
    .input(ticketIdSchema)
    .query(({ ctx, input }) => ctx.routines.campaignPlan(input)),

  /** Schedules the posts picked. The window shows each in full first: this is their approval. */
  scheduleCampaign: userProcedure
    .input(z.object({ ticketId: ticketIdSchema, posts: z.array(z.number().int().min(0)).max(100) }))
    .mutation(({ ctx, input }) => ctx.routines.scheduleCampaign(input.ticketId, input.posts)),

  setPaused: userProcedure
    .input(z.boolean())
    .mutation(({ ctx, input }) => ctx.settings.update({ routinesPaused: input })),
});
