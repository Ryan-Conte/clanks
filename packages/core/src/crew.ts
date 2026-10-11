import { z } from 'zod';
import { modelTagSchema } from './models';
import { type ModelChoice, modelChoiceSchema } from './providers';
import { type ToolOverrides, toolOverridesSchema } from './tools';

/** What a ticket produces. A maker's `outputs` lists the ones it makes. */
export const outputTypeSchema = z.enum([
  'spec',
  'design',
  'pr',
  'copy',
  'doc',
  'email',
  'research',
  'campaign',
  'other',
]);

export type OutputType = z.infer<typeof outputTypeSchema>;

/** A clank's colour, from the clanks.si palette. Its avatar is a gradient of it. */
export const avatarSchema = z.enum([
  'violet',
  'rose',
  'fuchsia',
  'amber',
  'lime',
  'emerald',
  'sky',
  'yellow',
  'orange',
  'cyan',
  'red',
  'slate',
]);

export type Avatar = z.infer<typeof avatarSchema>;

export const clankIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'Use lowercase letters, digits and "-", starting with a letter');

export type ClankId = z.infer<typeof clankIdSchema>;

/** The built-in stages, in order. Custom checkers add their own after one of these. */
export const STAGES = ['spec', 'design', 'build', 'qa', 'signoff'] as const;

const stageSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, 'Use a lowercase stage name');

const capabilitySchema = z.enum(['tools', 'vision']);

/**
 * A priming doc's frontmatter: configuration for the app, never shown to the model. The format is
 * in crew/README.md, and its field names are kept as they're written there.
 */
export const clankFrontmatterSchema = z
  .object({
    id: clankIdSchema,
    name: z.string().trim().min(1).max(40),
    role: z.string().trim().min(1).max(40),
    summary: z.string().trim().min(1).max(240),
    avatar: avatarSchema.optional(),
    outputs: z.array(outputTypeSchema),
    workflow: z
      .object({
        kind: z.enum(['maker', 'checker']),
        stage: stageSchema,
        after: stageSchema.optional(),
        applies_to: z.array(z.union([outputTypeSchema, z.literal('all')])).optional(),
        /** Clank ids, `maker` for the ticket's maker, or `all`. */
        bounce_to: z.array(z.string()).optional(),
      })
      .strict(),
    integrations: z.array(z.string()).optional(),
    model: z
      .object({
        tags: z.array(modelTagSchema).min(1),
        needs: z.array(capabilitySchema),
        prefers: z.array(capabilitySchema),
        min_context: z.number().int().min(2048),
        temperature: z.number().min(0).max(2),
      })
      .strict(),
    tools: z
      .object({
        allow: z.array(z.string()).default([]),
        ask: z.array(z.string()).default([]),
        deny: z.array(z.string()).default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const { kind, stage, after, applies_to } = doc.workflow;
    const builtin = (STAGES as readonly string[]).includes(stage);
    if (kind === 'maker') {
      if (doc.outputs.length === 0)
        ctx.addIssue({ code: 'custom', path: ['outputs'], message: 'A maker makes something' });
      if (!['spec', 'design', 'build'].includes(stage))
        ctx.addIssue({
          code: 'custom',
          path: ['workflow', 'stage'],
          message: 'A maker works in the spec, design or build stage',
        });
    } else {
      if (!applies_to?.length)
        ctx.addIssue({
          code: 'custom',
          path: ['workflow', 'applies_to'],
          message: 'A checker reviews at least one ticket type',
        });
      if (!builtin && !after)
        ctx.addIssue({
          code: 'custom',
          path: ['workflow', 'after'],
          message: 'A custom stage says which stage it follows',
        });
    }
  });

export type ClankFrontmatter = z.infer<typeof clankFrontmatterSchema>;

const sitePatternsSchema = z.array(z.string().trim().min(1).max(300)).max(200);

/** How a clank browses, as the user set it on its profile. */
export const clankBrowserSchema = z.object({
  /** Sites it may open. Empty allows any site that `deny` doesn't name. */
  allow: sitePatternsSchema,
  /** Sites it may never open. Wins over `allow`. */
  deny: sitePatternsSchema,
  /**
   * Keep its cookies and storage on disk, across chats and restarts, so it stays signed in to
   * sites. Otherwise each chat starts with a fresh, empty browser.
   */
  persistent: z.boolean(),
});

export type ClankBrowser = z.infer<typeof clankBrowserSchema>;

export const defaultClankBrowser: ClankBrowser = { allow: [], deny: [], persistent: false };

/** What the user changed about a clank in the app. Null keeps what its doc says. */
export interface ClankOverrides {
  name: string | null;
  avatar: Avatar | null;
  /** Null runs it on the crew's model. */
  model: ModelChoice | null;
  /** Tool policies that win over the doc's. */
  tools: ToolOverrides;
  browser: ClankBrowser;
}

export const clankProfilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(40).nullable(),
    avatar: avatarSchema.nullable(),
    model: modelChoiceSchema.nullable(),
    tools: toolOverridesSchema,
    browser: clankBrowserSchema,
  })
  .partial()
  .strict();

export type ClankProfilePatch = z.infer<typeof clankProfilePatchSchema>;

/** A clank as the window shows it: its doc with the user's changes applied. */
export interface ClankSummary {
  id: ClankId;
  name: string;
  role: string;
  summary: string;
  avatar: Avatar;
  kind: 'maker' | 'checker';
  stage: string;
  /** For a checker, the ticket types it checks. */
  appliesTo: (OutputType | 'all')[];
  outputs: OutputType[];
  /** Its own model, or null when it runs on the crew's. */
  model: ModelChoice | null;
  /** Whether the priming doc is the one that ships with the app or the user's edited copy. */
  doc: 'bundled' | 'edited';
  /** The user made it, so it has no doc shipped with the app to go back to. */
  custom: boolean;
  /**
   * It was installed from a marketplace. Whatever its doc says, nothing above read starts higher
   * than ask.
   */
  marketplace: boolean;
  /** The edited copy doesn't parse, so the bundled doc is used until it's fixed. */
  docError: string | null;
  /** Context the doc asks for, in tokens. */
  minContext: number;
  needs: ('tools' | 'vision')[];
  browser: ClankBrowser;
}

/** The parts of a priming doc: frontmatter for the app, a body for the model. */
export interface ClankDocText {
  id: ClankId;
  /** The doc as it's stored, frontmatter and all. */
  text: string;
  /** The doc that ships with the app, for comparing and resetting. Empty for a custom clank. */
  bundled: string;
  edited: boolean;
  custom: boolean;
}

/** Names a clank can't take, because the workflow uses them for something else. */
export const RESERVED_CLANK_IDS = ['user', 'app', 'maker', 'all', 'open', 'none', 'custom'];

/** A clank's id from its name: "Sentinel" is `sentinel`, "Legal Eagle" is `legal-eagle`. */
export function suggestClankId(name: string): string {
  const id = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return id || 'clank';
}

/**
 * A custom clank as the app's form takes it: what the frontmatter of its priming doc says, and the
 * prompt under it. The form writes the same file format as the docs that ship with the app.
 */
export const customClankSchema = z.object({
  id: clankIdSchema,
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(240),
  avatar: avatarSchema,
  kind: z.enum(['maker', 'checker']),
  /** A maker's output types. */
  outputs: z.array(outputTypeSchema).max(9),
  /** A maker's stage (spec, design or build), or a checker's own, such as `security`. */
  stage: stageSchema,
  /** For a checker with a stage of its own: the stage it follows. */
  after: stageSchema.nullable(),
  /** For a checker: the ticket types it reviews. */
  appliesTo: z.array(z.union([outputTypeSchema, z.literal('all')])).max(10),
  /** Who it can send work back to: clank ids, or `maker`. */
  bounceTo: z.array(z.string().trim().min(1).max(40)).max(20),
  /** Tools it uses without asking, and tools it asks before using. */
  allow: z.array(z.string().trim().min(1).max(64)).max(80),
  ask: z.array(z.string().trim().min(1).max(64)).max(80),
  tags: z.array(modelTagSchema).min(1).max(6),
  vision: z.boolean(),
  minContext: z.number().int().min(2048).max(1_048_576),
  temperature: z.number().min(0).max(2),
  /** The prompt: what the clank is told, written to it. */
  prompt: z.string().trim().min(1).max(40_000),
});

export type CustomClank = z.infer<typeof customClankSchema>;

const yamlList = (items: readonly string[]) => `[${items.join(', ')}]`;

/** A custom clank's priming doc, as the form's fields say it: frontmatter, then the prompt. */
export function customClankDoc(clank: CustomClank): string {
  const checker = clank.kind === 'checker';
  const lines = [
    '---',
    `id: ${clank.id}`,
    `name: ${JSON.stringify(clank.name)}`,
    `role: ${JSON.stringify(clank.role)}`,
    `summary: ${JSON.stringify(clank.summary)}`,
    `avatar: ${clank.avatar}`,
    `outputs: ${yamlList(checker ? [] : clank.outputs)}`,
    'workflow:',
    `  kind: ${clank.kind}`,
    `  stage: ${clank.stage}`,
    ...(checker && clank.after ? [`  after: ${clank.after}`] : []),
    ...(checker ? [`  applies_to: ${yamlList(clank.appliesTo)}`] : []),
    `  bounce_to: ${yamlList(clank.bounceTo)}`,
    'model:',
    `  tags: ${yamlList(clank.tags)}`,
    '  needs: [tools]',
    `  prefers: ${yamlList(clank.vision ? ['vision'] : [])}`,
    `  min_context: ${clank.minContext}`,
    `  temperature: ${clank.temperature}`,
    'tools:',
    `  allow: ${yamlList(clank.allow)}`,
    `  ask: ${yamlList(clank.ask)}`,
    '---',
    '',
    clank.prompt.trim(),
    '',
  ];
  return lines.join('\n');
}

/**
 * The stages in order: the built-in ones, with each custom checker's stage after the stage it
 * follows, in roster order. One whose stage to follow nobody uses still runs, just before sign-off.
 */
export function orderStages(workflows: { stage: string; after?: string | undefined }[]): string[] {
  const builtin = (stage: string) => (STAGES as readonly string[]).includes(stage);
  const order: string[] = [...STAGES];
  // One custom stage may follow another, so place them in rounds.
  let pending = workflows.filter((w) => !builtin(w.stage));
  for (;;) {
    const ready = pending.filter((w) => order.includes(w.after ?? ''));
    if (ready.length === 0) break;
    for (const workflow of ready) {
      if (order.includes(workflow.stage)) continue;
      // Behind any custom stage already placed there, so roster order holds.
      let at = order.indexOf(workflow.after!) + 1;
      while (at < order.length && !builtin(order[at]!)) at++;
      order.splice(at, 0, workflow.stage);
    }
    pending = pending.filter((w) => !order.includes(w.stage));
  }
  for (const workflow of pending) {
    if (!order.includes(workflow.stage)) order.splice(order.indexOf('signoff'), 0, workflow.stage);
  }
  return order;
}

/** Rough tokens in a piece of text: about four characters each, erring high. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
