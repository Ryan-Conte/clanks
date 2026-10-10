import {
  type Component,
  DESIGN_VERSION,
  type Design,
  type Page,
  componentSchema,
  designSchema,
  pageSchema,
} from './schema';

/** Where a project keeps its designs, its tokens and its design language. */
export const DESIGN_DIR = 'design';
export const TOKENS_FILE = 'design/tokens.tokens.json';
export const LANGUAGE_FILE = 'design/DESIGN.md';
export const ASSETS_DIR = 'design/assets';
/** The design file a project gets when nobody names one. */
export const DEFAULT_DESIGN = 'design/site.design';

/** A design file can't be read, and why. */
export class DesignFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignFileError';
  }
}

const FIRST = ['id', 'type', 'name', 'version'];
const LAST = ['variants', 'root', 'children'];

/** Keys in a fixed order: what a layer is first, what's inside it last, the rest by name. */
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (typeof value !== 'object' || value === null) return value;
  const rank = (key: string) =>
    FIRST.includes(key)
      ? FIRST.indexOf(key) - FIRST.length
      : LAST.includes(key)
        ? 1 + LAST.indexOf(key)
        : 0;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) result[key] = ordered(item);
  }
  return result;
}

/** Pretty-printed JSON with stable key order, so git shows a change as the lines that changed. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(ordered(value), null, 2)}\n`;
}

/**
 * A design as the files of its `.design` folder: `document.json` with the page order and the
 * prototype links, a file per page and a file per component.
 */
export function serializeDesign(design: Design): Record<string, string> {
  const files: Record<string, string> = {
    'document.json': stableJson({
      version: DESIGN_VERSION,
      name: design.name,
      nextId: design.nextId,
      pages: design.pages.map((p) => ({ id: p.id, name: p.name })),
      components: design.components.map((c) => c.id),
      links: design.links,
    }),
  };
  for (const page of design.pages) files[`pages/${page.id}.json`] = stableJson(page);
  for (const component of design.components) {
    files[`components/${component.id}.json`] = stableJson(component);
  }
  return files;
}

function readJson(files: Record<string, string>, path: string): unknown {
  const text = files[path];
  if (text === undefined) throw new DesignFileError(`${path} is missing.`);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new DesignFileError(
      `${path} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Reads a design from the files of its `.design` folder, by their paths inside it. */
export function parseDesign(files: Record<string, string>): Design {
  const document = readJson(files, 'document.json') as {
    version?: unknown;
    name?: unknown;
    nextId?: unknown;
    pages?: unknown;
    components?: unknown;
    links?: unknown;
  };
  const version = typeof document.version === 'number' ? document.version : 1;
  if (version > DESIGN_VERSION) {
    throw new DesignFileError(
      `This design was saved by a newer clanks (format ${version}). Update clanks to open it.`,
    );
  }
  const listed = Array.isArray(document.pages) ? document.pages : [];
  const pages: Page[] = listed.map((entry) => {
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string') throw new DesignFileError('document.json lists a page with no id.');
    const parsed = pageSchema.safeParse(readJson(files, `pages/${id}.json`));
    if (!parsed.success) {
      throw new DesignFileError(`pages/${id}.json isn't a valid page: ${firstIssue(parsed.error)}`);
    }
    return parsed.data;
  });
  const ids = Array.isArray(document.components) ? document.components : [];
  const components: Component[] = ids.map((id) => {
    if (typeof id !== 'string')
      throw new DesignFileError('document.json lists a component with no id.');
    const parsed = componentSchema.safeParse(readJson(files, `components/${id}.json`));
    if (!parsed.success) {
      throw new DesignFileError(
        `components/${id}.json isn't a valid component: ${firstIssue(parsed.error)}`,
      );
    }
    return parsed.data;
  });
  const design = designSchema.safeParse({
    version: DESIGN_VERSION,
    name: typeof document.name === 'string' ? document.name : 'Design',
    nextId: typeof document.nextId === 'number' ? document.nextId : 1,
    pages,
    components,
    links: Array.isArray(document.links) ? document.links : [],
  });
  if (!design.success) {
    throw new DesignFileError(`document.json isn't valid: ${firstIssue(design.error)}`);
  }
  return design.data;
}

function firstIssue(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (!issue) return 'wrong shape';
  const where = issue.path.map(String).join('.');
  return where ? `${where}: ${issue.message}` : issue.message;
}

/** A design file's name from what someone typed: `design/site.design` for `site`. */
export function designPath(name: string): string {
  const slug = name
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\/*/, '')
    .replace(/^design\//, '')
    .replace(/\.design\/?$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${DESIGN_DIR}/${slug || 'site'}.design`;
}
