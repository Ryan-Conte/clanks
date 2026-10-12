import {
  ALIGNS,
  type Component,
  type Design,
  IMAGE_FITS,
  JUSTIFIES,
  type Length,
  type Node,
  type NodeType,
  type Padding,
  type Size,
  TEXT_ALIGNS,
  isRef,
} from './schema';
import { type Ids, findComponent } from './tree';

/** Markup that can't be read, worded for whoever wrote it, with the line it's on. */
export class MarkupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkupError';
  }
}

interface Element {
  tag: string;
  attrs: Map<string, { raw: unknown; line: number }>;
  children: (Element | string)[];
  line: number;
  /** For a vector: what was between its tags, as written. */
  raw?: string;
}

/** The tags the markup has, and the layer each makes. */
const TAGS: Record<string, { type: NodeType; layout?: 'row' | 'col' }> = {
  frame: { type: 'frame' },
  box: { type: 'frame' },
  stack: { type: 'frame', layout: 'col' },
  col: { type: 'frame', layout: 'col' },
  column: { type: 'frame', layout: 'col' },
  row: { type: 'frame', layout: 'row' },
  text: { type: 'text' },
  rect: { type: 'rect' },
  rectangle: { type: 'rect' },
  ellipse: { type: 'ellipse' },
  circle: { type: 'ellipse' },
  line: { type: 'line' },
  divider: { type: 'line' },
  image: { type: 'image' },
  img: { type: 'image' },
  icon: { type: 'icon' },
  vector: { type: 'vector' },
  svg: { type: 'vector' },
  instance: { type: 'instance' },
};

export const MARKUP_TAGS = 'Frame, Text, Rect, Ellipse, Line, Image, Icon, Vector, Instance';

/** Other names a property goes by, so markup written from habit still reads. */
const ALIASES: Record<string, string> = {
  width: 'w',
  height: 'h',
  left: 'x',
  top: 'y',
  bg: 'fill',
  background: 'fill',
  backgroundcolor: 'fill',
  border: 'stroke',
  bordercolor: 'stroke',
  borderwidth: 'strokeWidth',
  strokewidth: 'strokeWidth',
  rounded: 'radius',
  borderradius: 'radius',
  cornerradius: 'radius',
  direction: 'layout',
  flexdirection: 'layout',
  spacing: 'gap',
  padding: 'pad',
  p: 'pad',
  paddingx: 'padX',
  padx: 'padX',
  px: 'padX',
  paddingy: 'padY',
  pady: 'padY',
  py: 'padY',
  alignitems: 'align',
  justifycontent: 'justify',
  overflow: 'clip',
  content: 'text',
  textstyle: 'style',
  fontfamily: 'font',
  fontsize: 'size',
  fontweight: 'weight',
  lineheight: 'lineHeight',
  leading: 'lineHeight',
  letterspacing: 'letterSpacing',
  tracking: 'letterSpacing',
  textcolor: 'color',
  textalign: 'textAlign',
  description: 'alt',
  placeholder: 'alt',
  objectfit: 'fit',
  component: 'of',
  showif: 'showIf',
};

const COMMON = ['name', 'x', 'y', 'w', 'h', 'absolute', 'hidden', 'locked', 'opacity', 'showIf'];
const BOX = ['fill', 'stroke', 'strokeWidth', 'radius', 'shadow'];

/** What each tag's attributes may be. */
const ATTRS: Record<NodeType, string[]> = {
  frame: [
    ...COMMON,
    ...BOX,
    'layout',
    'gap',
    'pad',
    'padX',
    'padY',
    'align',
    'justify',
    'wrap',
    'clip',
  ],
  text: [
    ...COMMON,
    'text',
    'style',
    'font',
    'size',
    'weight',
    'lineHeight',
    'letterSpacing',
    'color',
    'textAlign',
    'align',
    'bind',
  ],
  rect: [...COMMON, ...BOX],
  ellipse: [...COMMON, ...BOX],
  line: [...COMMON, 'stroke', 'strokeWidth', 'vertical', 'color'],
  image: [...COMMON, 'src', 'alt', 'fit', 'radius'],
  vector: [...COMMON, 'svg'],
  icon: [...COMMON, 'icon', 'color', 'size'],
  instance: [...COMMON, 'of', 'variant', 'props'],
};

// Reading the text

class Reader {
  pos = 0;
  constructor(readonly text: string) {}

  get line(): number {
    return this.text.slice(0, this.pos).split('\n').length;
  }

  fail(message: string): never {
    throw new MarkupError(`Line ${this.line}: ${message}`);
  }

  peek(length = 1): string {
    return this.text.slice(this.pos, this.pos + length);
  }

  skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) this.pos++;
  }
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** Text between tags: lines joined and spaces collapsed, as HTML does, with `\n` kept as breaks. */
function tidyText(text: string): string {
  return unescape(
    text
      // JSX's way of writing a string in the middle of text.
      .replace(/\{\s*"((?:[^"\\]|\\.)*)"\s*\}/g, (_m, s: string) => s)
      .replace(/\{\s*'((?:[^'\\]|\\.)*)'\s*\}/g, (_m, s: string) => s)
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim()
      .replace(/\\n/g, '\n')
      .replace(/ ?<br\s*\/?> ?/gi, '\n'),
  );
}

function readBraces(reader: Reader): string {
  let depth = 0;
  const start = reader.pos;
  for (; reader.pos < reader.text.length; reader.pos++) {
    const ch = reader.text[reader.pos]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = reader.text.indexOf(ch, reader.pos + 1);
      if (end === -1) reader.fail('A quote is never closed.');
      reader.pos = end;
    } else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      reader.pos++;
      return reader.text.slice(start + 1, reader.pos - 1);
    }
  }
  return reader.fail('A { is never closed.');
}

/** What's inside braces: a number, a string, a token, or an object of properties. */
function braceValue(inner: string, reader: Reader): unknown {
  const text = inner.trim();
  if (text === '') return reader.fail('Empty braces. Write a token such as {color.brand}.');
  if (/^-?\d*\.?\d+$/.test(text)) return Number(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(text);
  if (quoted) return quoted[2]!;
  if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(text)) return `{${text}}`;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      // Property names without quotes, single quotes and trailing commas, as JavaScript allows.
      const json = text
        .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
        .replace(/'((?:[^'\\]|\\.)*)'/g, (_m, s: string) => JSON.stringify(s))
        .replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(json) as unknown;
    } catch {
      return reader.fail(`Can't read {${text}}. Write an object as {{ "label": "Buy now" }}.`);
    }
  }
  return reader.fail(
    `Can't read {${text}}. Braces hold a token, such as {color.brand}, or a number.`,
  );
}

function readAttrValue(reader: Reader): unknown {
  const ch = reader.peek();
  if (ch === '"' || ch === "'") {
    const end = reader.text.indexOf(ch, reader.pos + 1);
    if (end === -1) reader.fail('A quote is never closed.');
    const value = reader.text.slice(reader.pos + 1, end);
    reader.pos = end + 1;
    return unescape(value);
  }
  if (ch === '{') return braceValue(readBraces(reader), reader);
  const match = /^[^\s>]+?(?=\s|\/?>)/.exec(reader.text.slice(reader.pos));
  if (!match) return reader.fail('An attribute has no value.');
  reader.pos += match[0].length;
  const bare = match[0];
  if (/^-?\d*\.?\d+$/.test(bare)) return Number(bare);
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  return bare;
}

function readElement(reader: Reader): Element {
  const line = reader.line;
  reader.pos++;
  const name = /^[A-Za-z][\w.]*/.exec(reader.text.slice(reader.pos))?.[0];
  if (!name) {
    // An empty tag groups nothing here: a fragment's children are read as siblings.
    if (reader.peek() === '>') {
      reader.pos++;
      return { tag: '', attrs: new Map(), children: readChildren(reader, ''), line };
    }
    return reader.fail('A < must start a tag such as <Frame>. Write a literal < as &lt;.');
  }
  reader.pos += name.length;
  const attrs: Element['attrs'] = new Map();
  for (;;) {
    reader.skipSpace();
    if (reader.peek(2) === '/>') {
      reader.pos += 2;
      return { tag: name, attrs, children: [], line };
    }
    if (reader.peek() === '>') {
      reader.pos++;
      break;
    }
    if (reader.pos >= reader.text.length) reader.fail(`<${name}> is never closed.`);
    const attr = /^[A-Za-z_:][\w:.-]*/.exec(reader.text.slice(reader.pos))?.[0];
    if (!attr) reader.fail(`Can't read the attributes of <${name}> at "${reader.peek(12)}".`);
    const attrLine = reader.line;
    reader.pos += attr.length;
    reader.skipSpace();
    if (reader.peek() === '=') {
      reader.pos++;
      reader.skipSpace();
      attrs.set(attr, { raw: readAttrValue(reader), line: attrLine });
    } else {
      attrs.set(attr, { raw: true, line: attrLine });
    }
  }
  const lower = name.toLowerCase();
  if (lower === 'svg' || lower === 'vector') {
    // An SVG is kept as written, not read as layers.
    const close = new RegExp(`</${name}\\s*>`, 'i').exec(reader.text.slice(reader.pos));
    if (!close) reader.fail(`<${name}> is never closed.`);
    const inner = reader.text.slice(reader.pos, reader.pos + close.index);
    reader.pos += close.index + close[0].length;
    return { tag: name, attrs, children: [], line, raw: inner };
  }
  return { tag: name, attrs, children: readChildren(reader, name), line };
}

function readChildren(reader: Reader, parent: string): (Element | string)[] {
  const children: (Element | string)[] = [];
  let text = '';
  const flush = () => {
    const tidy = tidyText(text);
    if (tidy) children.push(tidy);
    text = '';
  };
  while (reader.pos < reader.text.length) {
    if (reader.peek(4) === '<!--') {
      const end = reader.text.indexOf('-->', reader.pos);
      reader.pos = end === -1 ? reader.text.length : end + 3;
    } else if (reader.peek(3) === '{/*') {
      const end = reader.text.indexOf('*/}', reader.pos);
      reader.pos = end === -1 ? reader.text.length : end + 3;
    } else if (reader.peek(2) === '</') {
      flush();
      const close = /^<\/\s*([\w.]*)\s*>/.exec(reader.text.slice(reader.pos));
      if (!close) reader.fail('A closing tag is cut off.');
      if (close[1]!.toLowerCase() !== parent.toLowerCase()) {
        reader.fail(
          parent
            ? `</${close[1]}> closes <${parent}>, which is still open.`
            : `</${close[1]}> closes nothing.`,
        );
      }
      reader.pos += close[0].length;
      return children;
    } else if (reader.peek() === '<' && /^<(br\s*\/?>)/i.test(reader.text.slice(reader.pos))) {
      const br = /^<br\s*\/?>/i.exec(reader.text.slice(reader.pos))!;
      text += '<br>';
      reader.pos += br[0].length;
    } else if (reader.peek() === '<') {
      flush();
      const element = readElement(reader);
      if (element.tag === '') children.push(...element.children);
      else children.push(element);
    } else {
      text += reader.text[reader.pos];
      reader.pos++;
    }
  }
  flush();
  if (parent) reader.fail(`<${parent}> is never closed. Add </${parent}>.`);
  return children;
}

// Turning elements into layers

export interface MarkupContext {
  ids: Ids;
  /** The design the layers go into, for the components instances name. */
  design: Pick<Design, 'components'>;
}

const SIZE_WORDS: Record<string, Size> = {
  fill: 'fill',
  full: 'fill',
  stretch: 'fill',
  '100%': 'fill',
  hug: 'hug',
  auto: 'hug',
  fit: 'hug',
  'fit-content': 'hug',
};

function lengthOf(raw: unknown, what: string, fail: (message: string) => never): Length {
  if (typeof raw === 'number') return raw;
  if (isRef(raw)) return raw;
  if (typeof raw === 'string') {
    const match = /^(-?\d*\.?\d+)(px)?$/.exec(raw.trim());
    if (match) return Number(match[1]);
    // A token written without its braces.
    if (/^[a-z][\w-]*(\.[\w-]+)+$/.test(raw.trim())) return `{${raw.trim()}}`;
  }
  return fail(`${what} takes pixels or a token such as {space.4}, not ${JSON.stringify(raw)}.`);
}

function sizeOf(raw: unknown, what: string, fail: (message: string) => never): Size {
  if (typeof raw === 'string' && SIZE_WORDS[raw.trim().toLowerCase()]) {
    return SIZE_WORDS[raw.trim().toLowerCase()]!;
  }
  if (typeof raw === 'string' && raw.trim().endsWith('%')) {
    return fail(`${what} takes pixels, a token, "fill" or "hug". Percentages aren't used here.`);
  }
  const length = lengthOf(raw, what, fail);
  return typeof length === 'number' ? Math.max(0, length) : length;
}

function colourOf(raw: unknown, what: string, fail: (message: string) => never): string {
  if (typeof raw === 'string' && raw.trim()) {
    const text = raw.trim();
    if (/^[a-z][\w-]*(\.[\w-]+)+$/.test(text)) return `{${text}}`;
    return text;
  }
  return fail(`${what} takes a colour token such as {color.brand}, not ${JSON.stringify(raw)}.`);
}

function wordOf<T extends string>(
  raw: unknown,
  what: string,
  words: readonly T[],
  aliases: Record<string, T>,
  fail: (message: string) => never,
): T {
  const text = String(raw).trim().toLowerCase();
  const found = (words as readonly string[]).includes(text) ? (text as T) : aliases[text];
  if (found === undefined) return fail(`${what} is one of ${words.join(', ')}, not "${text}".`);
  return found;
}

function boolOf(raw: unknown): boolean {
  return raw === true || raw === 'true' || raw === 1 || raw === '';
}

/** `16`, `"16 24"` or `"16 24 16 24"`: one value for every side, or CSS's two- and four-value forms. */
function padOf(raw: unknown, fail: (message: string) => never): Padding {
  const parts =
    typeof raw === 'string' && /\s/.test(raw.trim())
      ? raw.trim().split(/\s+/)
      : Array.isArray(raw)
        ? (raw as unknown[])
        : [raw];
  const values = parts.map((p) => lengthOf(p, 'pad', fail));
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return [values[0]!, values[1]!, values[0]!, values[1]!];
  if (values.length === 4) return values as [Length, Length, Length, Length];
  return fail(
    'pad takes one value, two (vertical, horizontal) or four (top, right, bottom, left).',
  );
}

function short(text: string, max = 40): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Reads a layer's properties as markup writes them: other names for a property, pixels as
 * `"16px"`, tokens with or without braces. An instance's own properties come back apart.
 */
/** A value as text: a string as it is, anything else as JSON would write it. */
function str(raw: unknown): string {
  return typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? '');
}

function readProps(
  type: NodeType,
  attrs: [string, unknown][],
  component: Component | null,
  fail: (message: string) => never,
  update: { pad: Padding | undefined } | null = null,
): { props: Record<string, unknown>; instanceProps: Record<string, string | boolean> } {
  const allowed = ATTRS[type];
  const has = (name: string) => attrs.some(([written]) => written.toLowerCase() === name);
  const updating = update !== null;
  const currentPad = update?.pad;
  const props: Record<string, unknown> = {};
  const instanceProps: Record<string, string | boolean> = {};
  let padX: Length | undefined;
  let padY: Length | undefined;
  for (const [written, raw] of attrs) {
    const lower = written.toLowerCase();
    let key = allowed.find((a) => a.toLowerCase() === lower) ?? ALIASES[lower] ?? written;
    // On text, align is how the text is set, not where the layer sits.
    if (type === 'text' && key === 'align') key = 'textAlign';
    if (type === 'line' && key === 'color') key = 'stroke';
    if (type === 'icon' && key === 'name' && !has('icon')) {
      props.icon = str(raw);
      continue;
    }
    if (type === 'icon' && key === 'w' && !has('size')) key = 'size';
    if (type === 'instance' && component && !allowed.includes(key)) {
      const prop = component.props.find((p) => p.name.toLowerCase() === lower);
      if (!prop) {
        const names = component.props.map((p) => p.name);
        return fail(
          `${component.name} has no property "${written}". ${names.length ? `Its properties: ${names.join(', ')}.` : 'It has no properties.'}`,
        );
      }
      instanceProps[prop.name] = prop.type === 'boolean' ? boolOf(raw) : str(raw);
      continue;
    }
    if (!allowed.includes(key)) {
      return fail(`It has no "${written}". It takes: ${allowed.join(', ')}.`);
    }
    // In an update, null takes a property away.
    if (raw === null) {
      if (key !== 'padX' && key !== 'padY' && key !== 'of') props[key] = null;
      continue;
    }
    switch (key) {
      case 'name':
      case 'text':
      case 'src':
      case 'alt':
      case 'svg':
      case 'bind':
      case 'showIf':
      case 'variant':
      case 'icon':
        props[key] = str(raw);
        break;
      case 'of':
        break;
      case 'x':
      case 'y': {
        const value = lengthOf(raw, key, fail);
        if (typeof value !== 'number') return fail(`${key} takes pixels.`);
        props[key] = value;
        break;
      }
      case 'w':
      case 'h':
        props[key] = sizeOf(raw, key, fail);
        break;
      case 'fill':
      case 'stroke':
      case 'color':
        props[key] = colourOf(raw, key, fail);
        break;
      case 'gap':
      case 'radius':
      case 'strokeWidth':
      case 'size':
      case 'letterSpacing':
        props[key] = lengthOf(raw, key, fail);
        break;
      case 'pad':
        props.pad = padOf(raw, fail);
        break;
      case 'padX':
        padX = lengthOf(raw, 'padX', fail);
        break;
      case 'padY':
        padY = lengthOf(raw, 'padY', fail);
        break;
      case 'opacity':
      case 'lineHeight': {
        const value = isRef(raw) ? raw : Number(raw);
        if (typeof value === 'number' && Number.isNaN(value)) return fail(`${key} takes a number.`);
        props[key] =
          typeof value === 'number' && key === 'opacity' && value > 1 ? value / 100 : value;
        break;
      }
      case 'weight': {
        const names: Record<string, number> = {
          thin: 100,
          light: 300,
          normal: 400,
          regular: 400,
          medium: 500,
          semibold: 600,
          bold: 700,
          extrabold: 800,
          black: 900,
        };
        const value = isRef(raw) ? raw : (names[str(raw).toLowerCase()] ?? Number(raw));
        if (typeof value === 'number' && Number.isNaN(value)) {
          return fail('weight takes a number such as 600, or a token.');
        }
        props.weight = value;
        break;
      }
      case 'style': {
        const text = str(raw).trim();
        const ref = isRef(text) ? text : /^[a-z][\w-]*(\.[\w-]+)+$/.test(text) ? `{${text}}` : null;
        if (!ref) return fail('style takes a text style token, such as {type.body}.');
        props.style = ref;
        break;
      }
      case 'font':
      case 'shadow':
        props[key] = str(raw).trim();
        break;
      case 'layout':
        props.layout = wordOf(
          raw,
          'layout',
          ['none', 'row', 'col'] as const,
          {
            column: 'col',
            vertical: 'col',
            horizontal: 'row',
            absolute: 'none',
            free: 'none',
          },
          fail,
        );
        break;
      case 'align':
        props.align = wordOf(
          raw,
          'align',
          ALIGNS,
          {
            'flex-start': 'start',
            'flex-end': 'end',
            left: 'start',
            right: 'end',
            top: 'start',
            bottom: 'end',
            middle: 'center',
          },
          fail,
        );
        break;
      case 'justify':
        props.justify = wordOf(
          raw,
          'justify',
          JUSTIFIES,
          {
            'flex-start': 'start',
            'flex-end': 'end',
            'space-between': 'between',
            'space.between': 'between',
            space_between: 'between',
            spacebetween: 'between',
            'space-around': 'between',
            'space-evenly': 'between',
            left: 'start',
            right: 'end',
            middle: 'center',
          },
          fail,
        );
        break;
      case 'textAlign':
        props.textAlign = wordOf(
          raw,
          'textAlign',
          TEXT_ALIGNS,
          { start: 'left', end: 'right', middle: 'center' },
          fail,
        );
        break;
      case 'fit':
        props.fit = wordOf(raw, 'fit', IMAGE_FITS, { fill: 'cover' }, fail);
        break;
      case 'clip':
        props.clip =
          raw === 'hidden' || raw === 'clip' ? true : raw === 'visible' ? false : boolOf(raw);
        break;
      case 'absolute':
      case 'hidden':
      case 'locked':
      case 'wrap':
      case 'vertical':
        props[key] = raw === 'wrap' ? true : raw === 'nowrap' ? false : boolOf(raw);
        break;
      case 'props': {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          return fail('props takes an object, such as props={{ "label": "Buy now" }}.');
        }
        for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
          instanceProps[name] = typeof value === 'boolean' ? value : String(value);
        }
        break;
      }
      default:
        return fail(`It has no "${written}".`);
    }
  }
  if (padX !== undefined || padY !== undefined) {
    const current = (props.pad ?? currentPad) as Padding | undefined;
    const [top, right, bottom, left] = Array.isArray(current)
      ? current
      : [current ?? 0, current ?? 0, current ?? 0, current ?? 0];
    props.pad = [padY ?? top, padX ?? right, padY ?? bottom, padX ?? left];
  }
  for (const key of ['hidden', 'locked', 'absolute', 'wrap', 'clip', 'vertical']) {
    if (props[key] !== false) continue;
    if (updating) props[key] = null;
    else delete props[key];
  }
  return { props, instanceProps };
}

function toNode(element: Element, ctx: MarkupContext): Node {
  const fail = (message: string): never => {
    throw new MarkupError(`Line ${element.line}, <${element.tag}>: ${message}`);
  };
  const tag = TAGS[element.tag.toLowerCase()];
  if (!tag) return fail(`There's no such tag. The tags are ${MARKUP_TAGS}.`);
  const { type } = tag;
  if (element.tag.toLowerCase() === 'svg') {
    // A whole SVG document, attributes and all, kept as written.
    const number = (name: string) => {
      const raw = element.attrs.get(name)?.raw;
      const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
      return Number.isFinite(value) && value > 0 ? value : undefined;
    };
    const name = element.attrs.get('name')?.raw;
    const w = number('width');
    const h = number('height');
    return {
      id: ctx.ids.node(),
      type: 'vector',
      name: typeof name === 'string' && name.trim() ? name : 'Vector',
      ...(w === undefined ? {} : { w }),
      ...(h === undefined ? {} : { h }),
      svg: `<svg${svgAttrs(element)}>${element.raw ?? ''}</svg>`,
    };
  }
  const component =
    type === 'instance'
      ? (() => {
          const of = element.attrs.get('of') ?? element.attrs.get('component');
          if (!of) return fail('An instance names its component: of="Button".');
          const found = findComponent(ctx.design as Design, String(of.raw));
          if (!found) {
            const names = ctx.design.components.map((c) => c.name);
            return fail(
              names.length > 0
                ? `There's no component called "${String(of.raw)}". The components are: ${names.join(', ')}.`
                : `There's no component called "${String(of.raw)}". There are no components yet: build the layer, then make it one with design_make_component.`,
            );
          }
          return found;
        })()
      : null;

  const { props, instanceProps } = readProps(
    type,
    [...element.attrs].map(([name, { raw }]): [string, unknown] => [name, raw]),
    component,
    fail,
  );

  const id = ctx.ids.node();
  const elements = element.children.filter((c): c is Element => typeof c !== 'string');
  const texts = element.children.filter((c): c is string => typeof c === 'string');
  const named = typeof props.name === 'string' && props.name.trim() !== '';

  switch (type) {
    case 'frame': {
      const children: Node[] = element.children.map((child) =>
        typeof child === 'string'
          ? // Words straight inside a frame become a text layer.
            { id: ctx.ids.node(), type: 'text', name: short(child), text: child }
          : toNode(child, ctx),
      );
      const placed = children.some((c) => (c.x !== undefined || c.y !== undefined) && !c.absolute);
      const layout =
        (props.layout as string | undefined) ?? tag.layout ?? (placed ? 'none' : 'col');
      return {
        ...props,
        id,
        type,
        name: named ? String(props.name) : 'Frame',
        layout,
        children,
      } as Node;
    }
    case 'text': {
      if (elements.length > 0) {
        return fail('Text holds only words. Put other layers beside it, in a Frame.');
      }
      const text = typeof props.text === 'string' ? props.text : texts.join(' ');
      return {
        ...props,
        id,
        type,
        name: named ? String(props.name) : short(text) || 'Text',
        text,
      };
    }
    case 'vector': {
      const svg = typeof props.svg === 'string' ? props.svg : (element.raw ?? '').trim();
      if (!/<svg[\s>]/i.test(svg)) return fail('A vector holds an <svg>…</svg> document.');
      return { ...props, id, type, name: named ? String(props.name) : 'Vector', svg };
    }
    case 'icon': {
      if (typeof props.icon !== 'string' || !props.icon.trim()) {
        return fail('An icon names its icon: icon="shopping-cart".');
      }
      const icon = props.icon
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[\s_]+/g, '-')
        .toLowerCase();
      return { ...props, id, type, icon, name: named ? String(props.name) : icon };
    }
    case 'instance': {
      const variant = props.variant as string | undefined;
      if (variant !== undefined && !component!.variants.some((v) => v.name === variant)) {
        return fail(
          `${component!.name} has no variant "${variant}". Its variants: ${component!.variants.map((v) => v.name).join(', ')}.`,
        );
      }
      // Words inside an instance fill its text property, if it has just the one.
      const textProps = component!.props.filter((p) => p.type === 'text');
      if (texts.length > 0 && textProps.length === 1 && !(textProps[0]!.name in instanceProps)) {
        instanceProps[textProps[0]!.name] = texts.join(' ');
      }
      return {
        ...props,
        id,
        type,
        name: named ? String(props.name) : component!.name,
        component: component!.id,
        ...(Object.keys(instanceProps).length > 0 ? { props: instanceProps } : {}),
      };
    }
    case 'image':
      return {
        ...props,
        id,
        type,
        name: named
          ? String(props.name)
          : short(typeof props.alt === 'string' ? props.alt : 'Image', 30),
      };
    default:
      if (elements.length > 0 || texts.length > 0) {
        return fail(`A ${type} holds nothing. Use a Frame to hold other layers.`);
      }
      return {
        ...props,
        id,
        type,
        name: named
          ? String(props.name)
          : { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line' }[type as 'rect'],
      };
  }
}

/** An `<svg>` tag's own attributes, written back so the document is whole. */
function svgAttrs(element: Element): string {
  let text = '';
  for (const [name, { raw }] of element.attrs) {
    if (name === 'name') continue;
    text += ` ${name}="${String(raw).replace(/"/g, '&quot;')}"`;
  }
  return text.includes('xmlns=') ? text : ` xmlns="http://www.w3.org/2000/svg"${text}`;
}

/**
 * Reads markup into layers, giving each a new id. Throws a `MarkupError` that says which line and
 * tag is wrong and what would be right, so whoever wrote it can fix it.
 */
export function parseMarkup(markup: string, ctx: MarkupContext): Node[] {
  // Models often wrap markup in a code fence.
  const text = markup
    .replace(/^\s*```[a-z]*\s*\n/i, '')
    .replace(/\n```\s*$/, '')
    .trim();
  if (!text) throw new MarkupError(`The markup is empty. Write layers with ${MARKUP_TAGS}.`);
  const reader = new Reader(text);
  const top = readChildren(reader, '');
  const nodes: Node[] = [];
  for (const item of top) {
    if (typeof item === 'string') {
      throw new MarkupError(
        `"${short(item)}" is outside any tag. Put words in <Text>, inside a <Frame>.`,
      );
    }
    nodes.push(toNode(item, ctx));
  }
  if (nodes.length === 0) throw new MarkupError(`The markup has no layers. Use ${MARKUP_TAGS}.`);
  return nodes;
}

/**
 * A layer's properties from an update written the way markup writes attributes, ready for an
 * `update` operation: null takes a property away. Throws a `MarkupError` for one it doesn't have.
 */
export function updateProps(
  node: Node,
  set: Record<string, unknown>,
  design: Pick<Design, 'components'>,
): Record<string, unknown> {
  const fail = (message: string): never => {
    throw new MarkupError(message);
  };
  let component: Component | null = null;
  let swapped = false;
  if (node.type === 'instance') {
    const of = set.of ?? set.component;
    if (typeof of === 'string') {
      const found = findComponent(design as Design, of);
      if (!found) {
        return fail(
          `There's no component called "${of}". The components are: ${design.components.map((c) => c.name).join(', ') || 'none yet'}.`,
        );
      }
      component = found;
      swapped = found.id !== node.component;
    } else {
      component = design.components.find((c) => c.id === node.component) ?? null;
    }
  }
  const { props, instanceProps } = readProps(
    node.type,
    Object.entries(set).filter(([name]) => !(name === 'component' && node.type === 'instance')),
    component,
    fail,
    { pad: node.type === 'frame' ? node.pad : undefined },
  );
  if (node.type === 'instance') {
    if (swapped && component) props.component = component.id;
    const variant = props.variant;
    if (
      typeof variant === 'string' &&
      component &&
      !component.variants.some((v) => v.name === variant)
    ) {
      return fail(
        `${component.name} has no variant "${variant}". Its variants: ${component.variants.map((v) => v.name).join(', ')}.`,
      );
    }
    if (Object.keys(instanceProps).length > 0) {
      props.props = { ...(swapped ? {} : node.props), ...instanceProps };
    }
  }
  if (node.type === 'icon' && typeof props.icon === 'string') {
    props.icon = props.icon
      .trim()
      .replace(/[\s_]+/g, '-')
      .toLowerCase();
  }
  return props;
}
