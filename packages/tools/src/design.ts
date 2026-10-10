import { z } from 'zod';
import { LOW_RISK } from './risk';
import { type DesignAccess, type ToolContext, ToolFailure, defineTool, short } from './spec';

function designOf(ctx: ToolContext): DesignAccess {
  if (!ctx.design) {
    throw new ToolFailure("This chat has no workspace, so there's no design to work on.");
  }
  return ctx.design;
}

/** Design tools change design files in the clank's own worktree, where the user watches. */
const anyCall = (subject: string) => ({ kind: 'tool' as const, subject, pattern: '*' });

const fileArg = z
  .string()
  .trim()
  .max(200)
  .optional()
  .describe('The design file, such as design/site.design. Leave out when there is only one');
const idArg = z.string().trim().min(1).max(200);
const layerArg = idArg.describe('A layer id from design_read, such as n12');

/** The name of the first layer in some markup, for a label. */
function firstName(markup: string): string | null {
  return /\bname\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(markup)?.slice(1).find(Boolean) ?? null;
}

export const designRead = defineTool({
  name: 'design_read',
  description:
    'Reads the design as text: pages, frames and layers as [id] Type "name" with their properties, and the components. Pass node to read one frame, layer or component in full, or tokens to list every token. Read before you change anything, and again after the user has edited.',
  schema: z.object({
    node: idArg.optional().describe('A layer id such as n12, or the name of a frame or component'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe('How many levels of layers to show. Default 3, or all of them with node'),
    tokens: z
      .union([z.boolean(), z.enum(['css', 'tailwind', 'json'])])
      .optional()
      .describe(
        'true lists the tokens. "css", "tailwind" or "json" exports them in that form instead',
      ),
    file: fileArg,
  }),
  needs: ['workspace'],
  mutates: false,
  label: (args) =>
    args.tokens
      ? 'Reading the tokens'
      : args.node
        ? `Reading \`${short(args.node, 40)}\``
        : 'Reading the design',
  approval: () => anyCall('Read the design'),
  risk: () => LOW_RISK,
  run: async (args, ctx) => ({ content: await designOf(ctx).read(args) }),
});

export const designCreate = defineTool({
  name: 'design_create',
  description:
    'Adds layers to the design from markup and returns their ids. Tags: Frame, Text, Rect, Ellipse, Line, Image, Icon, Instance. Attributes: name, w and h (pixels, fill or hug), layout (row, col, none), gap, pad, align, justify, fill, stroke, radius, shadow; on Text: style, color; on Icon: icon; on Image: src, alt; on Instance: of, variant and its properties. Braces name tokens: fill={color.bg}. Build a whole screen or section in one call.',
  schema: z.object({
    markup: z
      .string()
      .min(1)
      .max(200_000)
      .describe('The layers, such as <Frame name="Home / Desktop" w=1440 layout=col>…</Frame>'),
    parent: idArg
      .optional()
      .describe(
        'The frame to add them to, by id, or a page by name. Leave out to add frames to the first page; a page name that is new makes that page',
      ),
    index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Where among the layers already there, from 0. Default: at the end'),
    file: fileArg,
  }),
  needs: ['workspace'],
  mutates: true,
  label: (args) => {
    const name = firstName(args.markup);
    return name ? `Designing \`${short(name, 50)}\`` : 'Adding to the design';
  },
  approval: () => anyCall('Add layers to the design'),
  risk: () => LOW_RISK,
  run: async (args, ctx) => ({ content: await designOf(ctx).create(args) }),
});

const updateShape = {
  id: layerArg,
  set: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Properties to change, named as in markup: { "fill": "{color.brand}", "text": "Buy now", "w": "fill" }. null removes one',
    ),
  parent: idArg.optional().describe('Move it into this frame, by id, or this page, by name'),
  index: z.number().int().min(0).optional().describe('Its place among the layers there, from 0'),
};

export const designUpdate = defineTool({
  name: 'design_update',
  description:
    "Changes layers' properties by id, or moves them to another frame or place. Give one layer with id and set, or several in updates. Properties the user changed while you worked are kept, and you're told.",
  schema: z
    .object({
      ...updateShape,
      id: layerArg.optional(),
      updates: z
        .array(z.object(updateShape))
        .max(200)
        .optional()
        .describe('Several layers at once'),
      file: fileArg,
    })
    .refine((args) => args.id !== undefined || (args.updates?.length ?? 0) > 0, {
      message: 'Give id and set for one layer, or updates for several',
    }),
  needs: ['workspace'],
  mutates: true,
  label: (args) => {
    const count = (args.updates?.length ?? 0) + (args.id ? 1 : 0);
    return count === 1
      ? `Changing \`${short(args.id ?? args.updates![0]!.id, 30)}\``
      : `Changing ${count} layers`;
  },
  approval: () => anyCall('Change layers in the design'),
  risk: () => LOW_RISK,
  run: async (args, ctx) => {
    const { id, set, parent, index, updates, file } = args;
    const all = [
      ...(id ? [{ id, set: set ?? {}, parent, index }] : []),
      ...(updates ?? []).map((u) => ({ ...u, set: u.set ?? {} })),
    ];
    return { content: await designOf(ctx).update({ file, updates: all }) };
  },
});

export const designDelete = defineTool({
  name: 'design_delete',
  description:
    'Deletes layers by id, with everything inside them. A component is deleted by its name; its instances are left broken, so replace them first.',
  schema: z
    .object({
      ids: z.array(layerArg).max(200).optional().describe('The layers to delete'),
      id: layerArg.optional(),
      file: fileArg,
    })
    .refine((args) => args.id !== undefined || (args.ids?.length ?? 0) > 0, {
      message: 'Give the ids of the layers to delete',
    }),
  needs: ['workspace'],
  mutates: true,
  label: (args) => {
    const ids = [...(args.id ? [args.id] : []), ...(args.ids ?? [])];
    return ids.length === 1
      ? `Deleting \`${short(ids[0]!, 30)}\``
      : `Deleting ${ids.length} layers`;
  },
  approval: () => anyCall('Delete layers from the design'),
  risk: () => LOW_RISK,
  run: async (args, ctx) => ({
    content: await designOf(ctx).remove({
      file: args.file,
      ids: [...(args.id ? [args.id] : []), ...(args.ids ?? [])],
    }),
  }),
});

export const designTokensSet = defineTool({
  name: 'design_tokens_set',
  description:
    'Creates or changes design tokens, the named values every layer uses. Names are groups joined by dots: color.brand, space.4, type.body. A value is a colour, pixels, a font family, a text style such as { "font": "{font.family.sans}", "size": 16, "weight": 400, "lineHeight": 1.5 }, a shadow such as "0 4px 12px rgba(0,0,0,0.15)", or another token in braces. dark gives its value in dark mode. Set primitives before the tokens that refer to them.',
  schema: z.object({
    tokens: z
      .array(
        z.looseObject({
          name: z.string().trim().min(1).max(120).describe('Such as color.brand'),
          value: z
            .unknown()
            .describe(
              'Its value, in light mode when it has modes. A text style is an object: { "font": …, "size": …, "weight": …, "lineHeight": … }',
            ),
          dark: z.unknown().optional().describe('Its value in dark mode, when it differs'),
          type: z
            .enum([
              'color',
              'dimension',
              'number',
              'fontFamily',
              'fontWeight',
              'duration',
              'cubicBezier',
              'shadow',
              'typography',
            ])
            .optional()
            .describe('Only needed when the name and value leave it unclear'),
          description: z.string().max(500).optional().describe('What it is for'),
        }),
      )
      .max(300)
      .default([]),
    remove: z
      .array(z.string().trim().min(1).max(120))
      .max(300)
      .default([])
      .describe('Tokens to delete, by name'),
  }),
  needs: ['workspace'],
  mutates: true,
  label: (args) => {
    const count = args.tokens.length + args.remove.length;
    const first = args.tokens[0]?.name ?? args.remove[0];
    return count === 1 && first
      ? `Setting the token \`${short(first, 40)}\``
      : `Setting ${count} tokens`;
  },
  approval: () => anyCall('Change the design tokens'),
  risk: () => LOW_RISK,
  run: async (args, ctx) => ({
    content: await designOf(ctx).setTokens({
      remove: args.remove,
      tokens: args.tokens.map((token) => {
        const { name, value, type, description, dark, modes } = token as typeof token & {
          modes?: unknown;
        };
        const other: Record<string, unknown> = {
          ...(typeof modes === 'object' && modes !== null
            ? (modes as Record<string, unknown>)
            : {}),
          ...(dark === undefined || dark === null ? {} : { dark }),
        };
        return {
          name,
          value,
          type,
          description,
          ...(Object.keys(other).length > 0 ? { modes: other } : {}),
        };
      }),
    }),
  }),
});

export const designMakeComponent = defineTool({
  name: 'design_make_component',
  description:
    'Turns a layer into a component, leaving an instance in its place. Its text layers become properties instances can set. With the name of a component that exists, the layer becomes another variant of it, such as "secondary/lg". Reuse it with <Instance of="Name" variant="…" />.',
  schema: z.object({
    node: layerArg.describe('The layer to turn into a component'),
    name: z.string().trim().min(1).max(120).describe('The component, such as Button'),
    variant: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe('This variant, such as primary/lg. Default: default'),
    file: fileArg,
  }),
  needs: ['workspace'],
  mutates: true,
  label: (args) =>
    `Making the component \`${short(args.name, 40)}\`${args.variant ? ` (${short(args.variant, 20)})` : ''}`,
  approval: () => anyCall('Make a component'),
  risk: () => LOW_RISK,
  run: async (args, ctx) => ({ content: await designOf(ctx).makeComponent(args) }),
});

export const designLink = defineTool({
  name: 'design_link',
  description:
    'Links a layer to a frame, so clicking it in the prototype goes there. Link the main flow so the user can click through it. null as the target removes a link.',
  schema: z.object({
    from: layerArg.describe('The layer that is clicked, such as a button'),
    to: idArg.nullable().describe('The frame it goes to, by id or name, or null'),
    file: fileArg,
  }),
  needs: ['workspace'],
  mutates: true,
  label: (args) =>
    args.to
      ? `Linking \`${short(args.from, 20)}\` to \`${short(args.to, 30)}\``
      : 'Removing a link',
  approval: () => anyCall('Link frames in the prototype'),
  risk: () => LOW_RISK,
  run: async (args, ctx) => ({ content: await designOf(ctx).link(args) }),
});

export const designRender = defineTool({
  name: 'design_render',
  description:
    'Draws a frame as a picture, exactly as a browser would, so you can check hierarchy, alignment and spacing by eye, or compare your build against the design. If you cannot see pictures, check with design_lint instead.',
  schema: z.object({
    frame: idArg.describe('The frame, by id or name, such as Home / Desktop'),
    mode: z.string().trim().max(40).optional().describe('light or dark. Default: light'),
    file: fileArg,
  }),
  needs: ['workspace', 'render'],
  mutates: false,
  label: (args) => `Drawing \`${short(args.frame, 50)}\``,
  approval: () => anyCall('Draw a frame'),
  risk: () => LOW_RISK,
  async run(args, ctx) {
    const drawn = await designOf(ctx).render(args);
    return {
      content: drawn.content,
      ...(drawn.error ? { error: true } : {}),
      ...(drawn.image ? { image: drawn.image, showModel: true } : {}),
    };
  },
});

export const designLint = defineTool({
  name: 'design_lint',
  description:
    'Checks the design and lists its problems as text: values that are not tokens, contrast below 4.5:1, text or layers that overflow, tap targets under 44px, broken instances and unnamed layers. Run it on every frame you make and fix every error.',
  schema: z.object({
    frame: idArg.optional().describe('One frame, by id or name. Leave out to check them all'),
    file: fileArg,
  }),
  needs: ['workspace'],
  mutates: false,
  label: (args) => (args.frame ? `Checking \`${short(args.frame, 50)}\`` : 'Checking the design'),
  approval: () => anyCall('Check the design'),
  risk: () => LOW_RISK,
  run: async (args, ctx) => ({ content: await designOf(ctx).lint(args) }),
});

export const DESIGN_TOOLS = [
  designRead,
  designCreate,
  designUpdate,
  designDelete,
  designTokensSet,
  designMakeComponent,
  designLink,
  designRender,
  designLint,
];
