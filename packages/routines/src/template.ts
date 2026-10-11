/**
 * Templates in a routine's ticket fields and action payloads: `{{inputs.offer}}`,
 * `{{steps.copy.output.posts[0].text}}`. Substitution only: there are no expressions and no code.
 */

/** What a template may read from. */
export const TEMPLATE_ROOTS = ['inputs', 'run', 'routine', 'event', 'steps'] as const;

export type TemplateRoot = (typeof TEMPLATE_ROOTS)[number];

export interface TemplateRef {
  /** As written, without the braces: `steps.copy.output.posts[0].text`. */
  raw: string;
  root: string;
  /** What follows the root: `['copy', 'output', 'posts', 0, 'text']`. */
  path: (string | number)[];
}

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Reads a path such as `steps.banner.output.frames['Promo / X'].png` into its parts. Null when it
 * isn't one.
 */
export function parsePath(text: string): (string | number)[] | null {
  const parts: (string | number)[] = [];
  let rest = text.trim();
  const name = /^[A-Za-z_][\w-]*/;
  const first = name.exec(rest);
  if (!first) return null;
  parts.push(first[0]);
  rest = rest.slice(first[0].length);
  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      const next = name.exec(rest.slice(1));
      if (!next) return null;
      parts.push(next[0]);
      rest = rest.slice(1 + next[0].length);
      continue;
    }
    const index = /^\[(\d{1,4})\]/.exec(rest);
    if (index) {
      parts.push(Number(index[1]));
      rest = rest.slice(index[0].length);
      continue;
    }
    const quoted = /^\[\s*(?:'([^']*)'|"([^"]*)")\s*\]/.exec(rest);
    if (quoted) {
      parts.push(quoted[1] ?? quoted[2] ?? '');
      rest = rest.slice(quoted[0].length);
      continue;
    }
    return null;
  }
  return parts;
}

/** Every template in a value, however deep, in the order they appear. */
export function templateRefs(value: unknown): TemplateRef[] {
  const refs: TemplateRef[] = [];
  const walk = (item: unknown) => {
    if (typeof item === 'string') {
      for (const match of item.matchAll(TEMPLATE)) {
        const raw = match[1]!;
        const path = parsePath(raw);
        refs.push({
          raw,
          root: path ? String(path[0]) : '',
          path: path ? path.slice(1) : [],
        });
      }
    } else if (Array.isArray(item)) item.forEach(walk);
    else if (typeof item === 'object' && item !== null) Object.values(item).forEach(walk);
  };
  walk(value);
  return refs;
}

/**
 * Why a template can't be used where it is, or null when it can. A step reads only from the steps
 * it depends on, and a ticket, which is made before any step has handed anything in, reads from
 * none.
 */
export function refProblem(
  ref: TemplateRef,
  context: { inputs: string[]; dependsOn: string[]; steps: boolean; event: boolean },
): string | null {
  const shown = `{{${ref.raw}}}`;
  if (!ref.root) return `${shown} isn't a template: write it as {{inputs.name}}`;
  if (!(TEMPLATE_ROOTS as readonly string[]).includes(ref.root)) {
    return `${shown} reads from "${ref.root}", which there's no such thing as. Templates read from ${TEMPLATE_ROOTS.join(', ')}.`;
  }
  const [first, second] = ref.path;
  if (ref.root === 'inputs') {
    if (typeof first !== 'string' || ref.path.length !== 1) return `${shown} must name one input`;
    if (!context.inputs.includes(first)) {
      return `${shown}: the routine has no input called "${first}"`;
    }
  }
  if (ref.root === 'run' && !['date', 'started_at', 'time'].includes(String(first))) {
    return `${shown}: a run has date, time and started_at`;
  }
  if (ref.root === 'routine' && first !== 'name') return `${shown}: a routine has a name`;
  if (ref.root === 'event' && !context.event) {
    return `${shown}: only a routine an event starts has event details`;
  }
  if (ref.root === 'steps') {
    if (!context.steps) {
      return `${shown}: a ticket is made when the run starts, before any step has handed anything in. It's told what the steps it depends on made; only an action's payload can use their outputs.`;
    }
    if (typeof first !== 'string' || second !== 'output') {
      return `${shown}: write a step's output as {{steps.<id>.output.<field>}}`;
    }
    if (!context.dependsOn.includes(first)) {
      return `${shown}: this step doesn't depend on "${first}". Add it to depends_on.`;
    }
  }
  return null;
}

/**
 * What each kind of ticket hands in, as a payload may read it. A design hands in frames, and its
 * picture is `image` (its first frame) or one frame by name; a campaign hands in posts, and its
 * words are `text` (its first post's) or one post by its place.
 */
export const OUTPUT_FIELDS: Record<string, { fields: string[]; example: string }> = {
  design: {
    fields: ['image', 'frames', 'title', 'summary'],
    example: "output.image for its picture, or output.frames['<frame name>'].png for one frame",
  },
  campaign: {
    fields: ['text', 'posts', 'plan', 'title'],
    example: 'output.text for its first post, or output.posts[1].text for another',
  },
  email: { fields: ['subject', 'body', 'to', 'cc'], example: 'output.subject and output.body' },
  research: { fields: ['note', 'title', 'summary', 'sources'], example: 'output.note' },
  copy: { fields: ['body', 'title', 'summary'], example: 'output.body' },
  doc: { fields: ['body', 'title', 'summary', 'path'], example: 'output.body' },
  other: { fields: ['body', 'title', 'summary'], example: 'output.body' },
  pr: { fields: ['summary', 'title', 'notes'], example: 'output.summary' },
  spec: { fields: ['summary', 'title'], example: 'output.summary' },
};

/**
 * Why a payload can't read a field from a step's output, given what the step makes, or null when
 * it can. Said when the routine is written, with what to write instead, rather than found out when
 * a run has nothing to send.
 */
export function outputFieldProblem(ref: TemplateRef, type: string): string | null {
  if (ref.root !== 'steps') return null;
  const known = OUTPUT_FIELDS[type];
  const field = ref.path[2];
  if (!known || field === undefined) return null;
  if (known.fields.includes(String(field))) return null;
  return `{{${ref.raw}}}: a ${type} ticket hands in no "${String(field)}". Use ${known.example}.`;
}

/** Where templates look values up. A `steps` entry is a step's `{ output }`. */
export type TemplateScope = Partial<Record<TemplateRoot, unknown>>;

function lookup(scope: TemplateScope, ref: TemplateRef): unknown {
  let value: unknown = scope[ref.root as TemplateRoot];
  for (const part of ref.path) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) value = typeof part === 'number' ? value[part] : undefined;
    else if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      // Things kept by name, such as frames, can be counted off too: `frames[0]` is the first.
      if (typeof part === 'number') {
        value = Object.values(record)[part];
        continue;
      }
      const key = String(part);
      // Names are matched as written, then without regard to case: frames are named by people.
      value = Object.hasOwn(record, key)
        ? record[key]
        : record[Object.keys(record).find((k) => k.toLowerCase() === key.toLowerCase()) ?? ''];
    } else return undefined;
  }
  return value;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Fills in a value's templates from a scope. A string that is one template alone becomes what it
 * names, whatever that is, such as a file; inside other text a value is written out. What has no
 * value is listed in `missing`, as written.
 */
export function fillTemplates(
  value: unknown,
  scope: TemplateScope,
): { value: unknown; missing: string[] } {
  const missing: string[] = [];
  const fill = (item: unknown): unknown => {
    if (typeof item === 'string') {
      const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(item);
      const resolve = (raw: string): unknown => {
        const path = parsePath(raw);
        const found = path
          ? lookup(scope, { raw, root: String(path[0]), path: path.slice(1) })
          : undefined;
        if (found === undefined || found === null) missing.push(`{{${raw}}}`);
        return found;
      };
      if (whole) return resolve(whole[1]!) ?? null;
      return item.replace(TEMPLATE, (_match, raw: string) => {
        const found = resolve(raw);
        return found === undefined || found === null ? '' : asText(found);
      });
    }
    if (Array.isArray(item)) return item.map(fill);
    if (typeof item === 'object' && item !== null) {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, fill(entry)]));
    }
    return item;
  };
  return { value: fill(value), missing: [...new Set(missing)] };
}
