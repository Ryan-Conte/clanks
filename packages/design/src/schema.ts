import { z } from 'zod';

/** The design file format's version. Older files are migrated when they're read. */
export const DESIGN_VERSION = 1;

/** A reference to a design token, written in braces: `{color.brand}`. */
export type TokenRef = `{${string}}`;

const REF = /^\{[A-Za-z0-9_][A-Za-z0-9_.-]*\}$/;

export function isRef(value: unknown): value is TokenRef {
  return typeof value === 'string' && REF.test(value);
}

/** The token a reference names: `color.brand` for `{color.brand}`. */
export function refPath(ref: string): string {
  return ref.slice(1, -1);
}

export function toRef(path: string): TokenRef {
  return `{${path}}`;
}

const refSchema = z.string().regex(REF) as unknown as z.ZodType<TokenRef>;
/** A CSS colour, or a colour token. */
const colourSchema = z.string().trim().min(1).max(200);
/** Pixels, or a dimension token. */
const lengthSchema = z.union([z.number().min(-100_000).max(100_000), refSchema]);
/** A fixed size in pixels, a token, `hug` to fit what's inside, or `fill` to take the room left. */
const sizeSchema = z.union([
  z.number().min(0).max(100_000),
  refSchema,
  z.literal('hug'),
  z.literal('fill'),
]);

export type Length = z.infer<typeof lengthSchema>;
export type Size = z.infer<typeof sizeSchema>;

const idSchema = z.string().regex(/^[a-z][a-z0-9]{0,23}$/);
const nameSchema = z.string().max(200);

const base = {
  id: idSchema,
  name: nameSchema,
  /** Where it is on the page, or in its frame when `absolute`. */
  x: z.number().optional(),
  y: z.number().optional(),
  w: sizeSchema.optional(),
  h: sizeSchema.optional(),
  /** Out of its frame's auto layout, placed by `x` and `y`. */
  absolute: z.boolean().optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  opacity: z.union([z.number().min(0).max(1), refSchema]).optional(),
  /** In a component: the boolean property that shows it. */
  showIf: z.string().max(60).optional(),
};

const box = {
  fill: colourSchema.optional(),
  stroke: colourSchema.optional(),
  strokeWidth: lengthSchema.optional(),
  radius: lengthSchema.optional(),
  /** A shadow token, or a CSS box-shadow. */
  shadow: z.string().max(400).optional(),
};

const padSchema = z.union([
  lengthSchema,
  z.tuple([lengthSchema, lengthSchema, lengthSchema, lengthSchema]),
]);

export type Padding = z.infer<typeof padSchema>;

export const LAYOUTS = ['none', 'row', 'col'] as const;
export const ALIGNS = ['start', 'center', 'end', 'stretch'] as const;
export const JUSTIFIES = ['start', 'center', 'end', 'between'] as const;
export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export const IMAGE_FITS = ['cover', 'contain'] as const;

export interface FrameNode extends z.infer<typeof frameShape> {
  children: Node[];
}

const frameShape = z.object({
  ...base,
  ...box,
  type: z.literal('frame'),
  /** Auto layout: a row or a column, as CSS flexbox. `none` places children by x and y. */
  layout: z.enum(LAYOUTS).optional(),
  gap: lengthSchema.optional(),
  /** One value for every side, or top, right, bottom, left. */
  pad: padSchema.optional(),
  /** Across the layout's direction. */
  align: z.enum(ALIGNS).optional(),
  /** Along the layout's direction. */
  justify: z.enum(JUSTIFIES).optional(),
  wrap: z.boolean().optional(),
  /** Hide what goes past its edges. */
  clip: z.boolean().optional(),
});

const textSchema = z.object({
  ...base,
  type: z.literal('text'),
  text: z.string().max(20_000),
  /** A typography token, such as `{type.display}`. */
  style: refSchema.optional(),
  font: z.string().max(200).optional(),
  size: lengthSchema.optional(),
  weight: z.union([z.number().min(1).max(1000), refSchema]).optional(),
  lineHeight: z.union([z.number().min(0).max(10), refSchema]).optional(),
  letterSpacing: lengthSchema.optional(),
  color: colourSchema.optional(),
  textAlign: z.enum(TEXT_ALIGNS).optional(),
  /** In a component: the text property that fills it. */
  bind: z.string().max(60).optional(),
});

const rectSchema = z.object({ ...base, ...box, type: z.literal('rect') });
const ellipseSchema = z.object({ ...base, ...box, type: z.literal('ellipse') });

const lineSchema = z.object({
  ...base,
  type: z.literal('line'),
  stroke: colourSchema.optional(),
  strokeWidth: lengthSchema.optional(),
  /** Top to bottom rather than left to right. */
  vertical: z.boolean().optional(),
});

const imageSchema = z.object({
  ...base,
  type: z.literal('image'),
  /** A file in the project, such as `design/assets/hero.jpg`. Without one it's a placeholder. */
  src: z.string().max(1000).optional(),
  /** What the image shows, or should show. */
  alt: z.string().max(1000).optional(),
  fit: z.enum(IMAGE_FITS).optional(),
  radius: lengthSchema.optional(),
});

const vectorSchema = z.object({
  ...base,
  type: z.literal('vector'),
  /** An SVG document. Drawn as an image, so nothing in it runs. */
  svg: z.string().max(400_000),
});

const iconSchema = z.object({
  ...base,
  type: z.literal('icon'),
  /** A Lucide icon's name, such as `shopping-cart`. */
  icon: z.string().max(80),
  color: colourSchema.optional(),
  size: lengthSchema.optional(),
});

const instanceSchema = z.object({
  ...base,
  type: z.literal('instance'),
  /** The component's id. */
  component: idSchema,
  variant: z.string().max(120).optional(),
  /** Values for the component's properties. */
  props: z.record(z.string().max(60), z.union([z.string().max(20_000), z.boolean()])).optional(),
});

export type TextNode = z.infer<typeof textSchema>;
export type RectNode = z.infer<typeof rectSchema>;
export type EllipseNode = z.infer<typeof ellipseSchema>;
export type LineNode = z.infer<typeof lineSchema>;
export type ImageNode = z.infer<typeof imageSchema>;
export type VectorNode = z.infer<typeof vectorSchema>;
export type IconNode = z.infer<typeof iconSchema>;
export type InstanceNode = z.infer<typeof instanceSchema>;

/** A layer in a design: a frame of other layers, or a leaf. */
export type Node =
  | FrameNode
  | TextNode
  | RectNode
  | EllipseNode
  | LineNode
  | ImageNode
  | VectorNode
  | IconNode
  | InstanceNode;

export type NodeType = Node['type'];

export const NODE_TYPES: readonly NodeType[] = [
  'frame',
  'text',
  'rect',
  'ellipse',
  'line',
  'image',
  'vector',
  'icon',
  'instance',
];

export const nodeSchema: z.ZodType<Node> = z.lazy(() =>
  z.discriminatedUnion('type', [
    frameShape.extend({ children: z.array(nodeSchema).max(5000) }),
    textSchema,
    rectSchema,
    ellipseSchema,
    lineSchema,
    imageSchema,
    vectorSchema,
    iconSchema,
    instanceSchema,
  ]),
);

/** A page of a design: frames and loose layers on an endless canvas. */
export interface Page {
  id: string;
  name: string;
  children: Node[];
}

export const pageSchema: z.ZodType<Page> = z.object({
  id: idSchema,
  name: nameSchema,
  children: z.array(nodeSchema).max(5000),
});

/** Something an instance of a component can set. */
export interface ComponentProp {
  name: string;
  /** Text fills the layers bound to it; a boolean shows or hides the layers that name it. */
  type: 'text' | 'boolean';
  default: string | boolean;
}

/** One version of a component, such as `primary/lg`. */
export interface Variant {
  name: string;
  root: Node;
}

/** A reusable piece of a design, with variants. Layers that use it are instances. */
export interface Component {
  id: string;
  name: string;
  description?: string | undefined;
  props: ComponentProp[];
  variants: Variant[];
}

export const componentSchema: z.ZodType<Component> = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  props: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        type: z.enum(['text', 'boolean']),
        default: z.union([z.string().max(20_000), z.boolean()]),
      }),
    )
    .max(40),
  variants: z
    .array(z.object({ name: z.string().trim().min(1).max(120), root: nodeSchema }))
    .min(1)
    .max(200),
});

/** A prototype link: clicking one layer goes to a frame. */
export interface Link {
  from: string;
  to: string;
}

/** A design file, as it's held in memory: its pages, components and prototype links. */
export interface Design {
  version: number;
  name: string;
  /** The number the next new layer, page or component gets in its id. */
  nextId: number;
  pages: Page[];
  components: Component[];
  links: Link[];
}

export const designSchema: z.ZodType<Design> = z.object({
  version: z.number().int().min(1),
  name: z.string().max(200),
  nextId: z.number().int().min(1),
  pages: z.array(pageSchema).max(200),
  components: z.array(componentSchema).max(1000),
  links: z.array(z.object({ from: idSchema, to: idSchema })).max(5000),
});

/** A new, empty design with one page. */
export function emptyDesign(name = 'Design'): Design {
  return {
    version: DESIGN_VERSION,
    name,
    nextId: 2,
    pages: [{ id: 'p1', name: 'Page 1', children: [] }],
    components: [],
    links: [],
  };
}

/** Sizes to start a frame from: screens, and the social formats posts attach by name. */
export const FRAME_PRESETS: { name: string; group: 'Screens' | 'Social'; w: number; h: number }[] =
  [
    { name: 'Desktop', group: 'Screens', w: 1440, h: 1024 },
    { name: 'Laptop', group: 'Screens', w: 1280, h: 800 },
    { name: 'Tablet', group: 'Screens', w: 768, h: 1024 },
    { name: 'Mobile', group: 'Screens', w: 390, h: 844 },
    { name: 'Square', group: 'Social', w: 1080, h: 1080 },
    { name: 'Portrait', group: 'Social', w: 1080, h: 1350 },
    { name: 'Story', group: 'Social', w: 1080, h: 1920 },
    { name: 'Landscape', group: 'Social', w: 1600, h: 900 },
    { name: 'Link preview', group: 'Social', w: 1200, h: 630 },
  ];

/** What a layer of each type is called until someone names it. */
export const DEFAULT_NAMES: Record<NodeType, string> = {
  frame: 'Frame',
  text: 'Text',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  image: 'Image',
  vector: 'Vector',
  icon: 'Icon',
  instance: 'Instance',
};

/** The properties each type of layer has, besides its id, type and children. */
export const NODE_PROPS: Record<NodeType, readonly string[]> = (() => {
  const common = ['name', 'x', 'y', 'w', 'h', 'absolute', 'hidden', 'locked', 'opacity', 'showIf'];
  const boxProps = ['fill', 'stroke', 'strokeWidth', 'radius', 'shadow'];
  return {
    frame: [...common, ...boxProps, 'layout', 'gap', 'pad', 'align', 'justify', 'wrap', 'clip'],
    text: [
      ...common,
      'text',
      'style',
      'font',
      'size',
      'weight',
      'lineHeight',
      'letterSpacing',
      'color',
      'textAlign',
      'bind',
    ],
    rect: [...common, ...boxProps],
    ellipse: [...common, ...boxProps],
    line: [...common, 'stroke', 'strokeWidth', 'vertical'],
    image: [...common, 'src', 'alt', 'fit', 'radius'],
    vector: [...common, 'svg'],
    icon: [...common, 'icon', 'color', 'size'],
    instance: [...common, 'component', 'variant', 'props'],
  };
})();
