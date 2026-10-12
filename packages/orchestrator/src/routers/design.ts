import { conversationIdSchema, pinSchema, projectIdSchema } from '@clanks/core';
import {
  DEFAULT_DESIGN,
  DESIGN_DIR,
  DesignFileError,
  type Studio,
  TOKEN_EXPORTS,
  TOKENS_FILE,
  emptyDesign,
  emptyTokens,
  opSchema,
  parseDesign,
  parseTokens,
} from '@clanks/design';
import { git, runGit } from '@clanks/workspace';
import { relative } from 'node:path';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDesigns, readLanguage } from '../design/files';
import { DesignError, type DesignSnapshot, FRAME_EXPORTS } from '../design/service';
import { userProcedure } from '../procedures';
import { type OrchestratorContext, publicProcedure, router } from '../trpc';
import { snapshots } from './live';

/** Where a design is: a run's worktree, or a project's own folder. */
const sourceSchema = z.union([
  z.object({ conversationId: conversationIdSchema }),
  z.object({ projectId: projectIdSchema }),
]);

export type DesignSource = z.infer<typeof sourceSchema>;

const fileSchema = z.string().trim().min(1).max(200).optional();

/** The folder a source's design is in. Null for a run that has no worktree yet. */
function dirOf(
  ctx: OrchestratorContext,
  source: DesignSource,
): { dir: string | null; conversationId: string | null } {
  if ('conversationId' in source) {
    return {
      dir: ctx.workspace.run(source.conversationId)?.cwd ?? null,
      conversationId: source.conversationId,
    };
  }
  return { dir: ctx.projects.get(source.projectId).folder, conversationId: null };
}

function requireDir(ctx: OrchestratorContext, source: DesignSource) {
  const found = dirOf(ctx, source);
  if (!found.dir) throw new DesignError("This chat has no workspace yet, so there's no design.");
  return { dir: found.dir, conversationId: found.conversationId };
}

const NOTHING: DesignSnapshot = {
  files: [],
  file: DEFAULT_DESIGN,
  design: null,
  tokens: emptyTokens(),
  rev: 'none',
  problems: [],
  language: false,
  assets: [],
};

/** A run whose design Studio can show: a design ticket's, or any with design files. */
export interface DesignRun {
  conversationId: string;
  clankId: string;
  title: string;
  role: string | null;
  ticketKey: string | null;
  replying: boolean;
  updatedAt: Date;
}

/** Studio: a project's design, or a run's, as it changes; the user's own edits; tokens and review. */
export const designRouter = router({
  /** A design, sent again whenever it changes: by a clank's tools, by the user, or by a rewind. */
  live: publicProcedure
    .input(z.object({ source: sourceSchema, file: fileSchema }))
    .subscription(async function* ({ ctx, input, signal }): AsyncGenerator<DesignSnapshot> {
      const snapshot = () => {
        const { dir } = dirOf(ctx, input.source);
        return dir ? ctx.design.snapshot(dir, input.file) : NOTHING;
      };
      yield* snapshots({
        signal,
        intervalMs: 60,
        subscribe: (onChange) => {
          const onDesign = (dir: string) => {
            if (dir === dirOf(ctx, input.source).dir) onChange();
          };
          // A run's worktree is made, rewound and caught up by the workspace.
          const onWorkspace = (id: string) => {
            if ('conversationId' in input.source && id === input.source.conversationId) onChange();
          };
          ctx.design.on('change', onDesign);
          ctx.workspace.on('change', onWorkspace);
          return () => {
            ctx.design.off('change', onDesign);
            ctx.workspace.off('change', onWorkspace);
          };
        },
        snapshot,
      });
    }),

  snapshot: userProcedure
    .input(z.object({ source: sourceSchema, file: fileSchema }))
    .query(({ ctx, input }) => {
      const { dir } = dirOf(ctx, input.source);
      return dir ? ctx.design.snapshot(dir, input.file) : NOTHING;
    }),

  /** The user's own edit. In a run, its clank is told what they changed. */
  edit: userProcedure
    .input(z.object({ source: sourceSchema, file: fileSchema, ops: z.array(opSchema).max(2000) }))
    .mutation(({ ctx, input }) => {
      const { dir, conversationId } = requireDir(ctx, input.source);
      return ctx.design.applyUser({ dir, file: input.file, ops: input.ops, conversationId });
    }),

  /** An image a design names, as a data URL the canvas can show. */
  asset: userProcedure
    .input(z.object({ source: sourceSchema, src: z.string().min(1).max(1000) }))
    .query(({ ctx, input }) => {
      const { dir } = dirOf(ctx, input.source);
      return dir ? ctx.design.asset(dir, input.src) : null;
    }),

  /** Saves an image the user picked into `design/assets`. */
  addAsset: userProcedure
    .input(
      z.object({
        source: sourceSchema,
        name: z.string().trim().min(1).max(200),
        data: z.instanceof(Uint8Array),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { dir } = requireDir(ctx, input.source);
      return ctx.design.addAsset(dir, input.name, input.data);
    }),

  /** The tokens as CSS, a Tailwind theme or JSON, and saved beside the tokens when asked. */
  exportTokens: userProcedure
    .input(z.object({ source: sourceSchema, format: z.enum(TOKEN_EXPORTS), save: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const { dir } = requireDir(ctx, input.source);
      return ctx.design.exportTokens(dir, input.format, input.save);
    }),

  /** A frame as a PNG, an SVG or a PDF, saved where the user picks. Null if they cancel. */
  exportFrame: userProcedure
    .input(
      z.object({
        source: sourceSchema,
        file: fileSchema,
        frame: z.string().trim().min(1).max(200),
        format: z.enum(FRAME_EXPORTS),
        mode: z.string().trim().max(40).optional(),
        scale: z.number().min(1).max(4).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { dir } = requireDir(ctx, input.source);
      if (!ctx.host) throw new DesignError("Exporting needs the app's file dialog");
      const file = await ctx.design.exportFrame(dir, input);
      return ctx.host.saveFile(
        { title: `Export ${input.frame}`, defaultName: file.name, extensions: [input.format] },
        file.data,
      );
    }),

  /** A component as a React component and its CSS, to read or copy. */
  componentCode: userProcedure
    .input(
      z.object({ source: sourceSchema, file: fileSchema, component: z.string().min(1).max(200) }),
    )
    .query(({ ctx, input }) => {
      const { dir } = requireDir(ctx, input.source);
      return ctx.design.componentCode(dir, input.component, input.file);
    }),

  /** Saves a component's code as two files in a folder the user picks. Null if they cancel. */
  saveComponent: userProcedure
    .input(
      z.object({ source: sourceSchema, file: fileSchema, component: z.string().min(1).max(200) }),
    )
    .mutation(async ({ ctx, input }) => {
      const { dir } = requireDir(ctx, input.source);
      if (!ctx.host) throw new DesignError("Saving needs the app's file dialog");
      const code = ctx.design.componentCode(dir, input.component, input.file);
      const folder = await ctx.host.pickFolder({ title: `Save ${code.name}.tsx and its CSS in` });
      if (!folder) return null;
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${code.name}.tsx`), code.tsx);
      writeFileSync(join(folder, `${code.name}.css`), code.css);
      return folder;
    }),

  /**
   * A frame's picture by its name, wherever the project has it: its own design, or one a clank is
   * still building on a ticket. A campaign's posts name the frames that go with them.
   */
  framePicture: userProcedure
    .input(z.object({ projectId: projectIdSchema, name: z.string().trim().min(1).max(200) }))
    .query(async ({ ctx, input }) => {
      const tickets = ctx.board.tickets(input.projectId);
      const runs = ctx.chat
        .list()
        .filter((c) => c.projectId === input.projectId && c.role === 'maker')
        .filter((c) => tickets.find((t) => t.id === c.ticketId)?.type === 'design')
        .sort((a, b) => +b.updatedAt - +a.updatedAt);
      const dirs = [
        ctx.projects.get(input.projectId).folder,
        ...runs.flatMap((c) => ctx.workspace.run(c.id)?.cwd ?? []),
      ];
      for (const dir of dirs) {
        const picture = await ctx.design.framePicture(dir, input.name).catch(() => null);
        if (!picture) continue;
        return {
          url: `data:image/png;base64,${Buffer.from(picture.png).toString('base64')}`,
          width: picture.width,
          height: picture.height,
        };
      }
      return null;
    }),

  /** What lint finds, with frames measured in a browser. */
  lint: userProcedure
    .input(z.object({ source: sourceSchema, file: fileSchema }))
    .query(async ({ ctx, input }) => {
      const { dir } = requireDir(ctx, input.source);
      const file = ctx.design.resolveFile(dir, input.file);
      const { state, exists } = ctx.design.load(dir, file);
      if (!exists) return { issues: [], frames: 0, measured: false };
      return ctx.design.lint(dir, state);
    }),

  /** `design/DESIGN.md`, the written half of the design language. */
  language: userProcedure.input(sourceSchema).query(({ ctx, input }) => {
    const { dir } = dirOf(ctx, input);
    return dir ? readLanguage(dir) : null;
  }),

  /** A run's design as it was at a checkpoint, to compare with how it is now. */
  at: userProcedure
    .input(
      z.object({ conversationId: conversationIdSchema, checkpointId: z.uuid(), file: fileSchema }),
    )
    .query(async ({ ctx, input }): Promise<Studio> => {
      const run = ctx.workspace.run(input.conversationId);
      if (!run) throw new DesignError('This chat has no workspace yet');
      // Checkpoints hold paths from the worktree's top; the chat's folder may be inside it.
      const sub = relative(run.worktree, run.cwd).replace(/\\/g, '/');
      const top = sub ? `${sub}/` : '';
      const files = await ctx.workspace.filesAt(
        input.conversationId,
        input.checkpointId,
        `${top}${DESIGN_DIR}`,
      );
      const file = ctx.design.resolveFile(run.cwd, input.file);
      const prefix = `${top}${file}/document.json` in files ? `${top}${file}/` : null;
      const tokensPath = `${top}${TOKENS_FILE}` in files ? `${top}${TOKENS_FILE}` : null;
      const tokens = tokensPath
        ? parseTokens(JSON.parse(files[tokensPath]!) as unknown).set
        : emptyTokens();
      if (!prefix) return { design: emptyDesign(), tokens };
      const inside: Record<string, string> = {};
      for (const [path, text] of Object.entries(files)) {
        if (path.startsWith(prefix)) inside[path.slice(prefix.length)] = text;
      }
      try {
        return { design: parseDesign(inside), tokens };
      } catch (error) {
        if (error instanceof DesignFileError) throw new DesignError(error.message);
        throw error;
      }
    }),

  /** A comment pinned to the canvas, for the run's clank. */
  pin: userProcedure.input(pinSchema).mutation(({ ctx, input }) => ctx.workspace.pin(input)),

  /** The runs in a project whose design Studio can show, newest first. */
  runs: userProcedure.input(projectIdSchema).query(({ ctx, input }): DesignRun[] => {
    const tickets = ctx.board.tickets(input);
    return ctx.chat
      .list()
      .filter((c) => c.projectId === input && c.role !== 'planner')
      .flatMap((c) => {
        const run = ctx.workspace.run(c.id);
        const ticket = c.ticketId ? tickets.find((t) => t.id === c.ticketId) : undefined;
        if (!run) return [];
        if (ticket?.type !== 'design' && listDesigns(run.cwd).length === 0) return [];
        // A checker's copy follows the maker's: the maker's is the one to open.
        if (c.role === 'checker' || c.role === 'helper') return [];
        if (ticket?.doneAt) return [];
        return [
          {
            conversationId: c.id,
            clankId: c.clankId,
            title: c.title,
            role: c.role,
            ticketKey: ticket?.key ?? null,
            replying: c.replying,
            updatedAt: c.updatedAt,
          },
        ];
      })
      .sort((a, b) => +b.updatedAt - +a.updatedAt);
  }),

  /** Whether a project's own design has changes that aren't committed, so the crew can't see them. */
  status: userProcedure.input(projectIdSchema).query(async ({ ctx, input }) => {
    const { folder } = ctx.projects.get(input);
    const result = await runGit(['status', '--porcelain', '--', DESIGN_DIR], {
      cwd: folder,
      okCodes: [128],
    }).catch(() => null);
    const changed =
      result?.exitCode === 0
        ? result.stdout.toString('utf8').split('\n').filter(Boolean).length
        : 0;
    return { changed };
  }),

  /**
   * Commits a project's own design to the branch its folder has checked out, as the user, so the
   * crew's next runs start from it.
   */
  commit: userProcedure.input(projectIdSchema).mutation(async ({ ctx, input }) => {
    const { folder } = ctx.projects.get(input);
    try {
      await git(['add', '--', DESIGN_DIR], { cwd: folder });
      await git(['commit', '-m', 'Design: edits from Studio', '--', DESIGN_DIR], { cwd: folder });
    } catch (error) {
      throw new DesignError(
        `Couldn't commit the design: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    ctx.board.pumpAll();
  }),
});
