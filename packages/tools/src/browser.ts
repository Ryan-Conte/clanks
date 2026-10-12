import { PathError, resolveInside, toRelative } from '@clanks/workspace';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { z } from 'zod';
import { redactUrl } from './redact';
import { LOW_RISK, pageActionRisk, urlRisk } from './risk';
import {
  type BrowserAccess,
  type BrowserResult,
  type ListedImage,
  type ToolContext,
  ToolFailure,
  type ToolResult,
  type ToolSpec,
  defineTool,
  short,
} from './spec';
import { USER_AGENT, readCapped } from './web';

/** Where a design's pictures live in a project: the design package's `ASSETS_DIR`. */
const ASSETS_DIR = 'design/assets';
/** The pictures a design can show, by media type. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
};
/** Bigger than this isn't a picture for a design. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 20_000;

function browserOf(ctx: ToolContext): BrowserAccess {
  if (!ctx.browser) throw new ToolFailure("There's no browser in this chat.");
  return ctx.browser;
}

function result(step: BrowserResult): ToolResult {
  return {
    content: step.content,
    ...(step.error ? { error: true } : {}),
    ...(step.image ? { image: step.image } : {}),
  };
}

/** Models write a ref as 12, "12" or "[12]". All three mean the same element. */
function lenientRef<A>(spec: ToolSpec<A>): ToolSpec<A> {
  const parse = spec.parse.bind(spec);
  return {
    ...spec,
    parse(raw) {
      if (raw && typeof raw === 'object' && 'ref' in raw) {
        const ref = raw.ref;
        if (typeof ref === 'string' && /^\s*\[?\s*\d+\s*\]?\s*$/.test(ref)) {
          return parse({ ...raw, ref: Number(ref.replace(/\D/g, '')) });
        }
      }
      return parse(raw);
    },
  };
}

const urlArg = z.string().min(1).describe('The full address, starting with https://');
const refArg = z.number().int().min(1).describe("The element's ref from browser_read, such as 12");

/** "Always allow" for a page covers its whole site. */
function urlApproval(url: string) {
  let pattern = url;
  try {
    pattern = `${new URL(url).origin}/*`;
  } catch {
    // Not a URL: the call fails anyway.
  }
  return { kind: 'url' as const, subject: url, pattern };
}

export const browserOpen = defineTool({
  name: 'browser_open',
  description:
    'Opens a page in a new tab of the browser pane, where the user watches, makes it the current tab and returns the page as text, as browser_read does. Use it for pages that need scripts, clicks or forms, and for dev servers on localhost.',
  schema: z.object({ url: urlArg }),
  needs: ['browser'],
  mutates: false,
  label: (args) => `Opening \`${short(redactUrl(args.url))}\``,
  approval: (args) => urlApproval(args.url),
  risk: (args) => urlRisk(args.url),
  run: async (args, ctx) => result(await browserOf(ctx).open(args.url)),
});

export const browserNavigate = defineTool({
  name: 'browser_navigate',
  description:
    'Goes to an address in the current tab, opening a tab if there is none, and returns the page as text.',
  schema: z.object({ url: urlArg }),
  needs: ['browser'],
  mutates: false,
  label: (args) => `Going to \`${short(redactUrl(args.url))}\``,
  approval: (args) => urlApproval(args.url),
  risk: (args) => urlRisk(args.url),
  run: async (args, ctx) => result(await browserOf(ctx).navigate(args.url)),
});

export const browserRead = defineTool({
  name: 'browser_read',
  description:
    "Reads the current tab's page as text: headings, text, and every link, button and field numbered like [12]. Give that number to browser_click or browser_type. Read again after a page changes. Long pages come in parts; pass from_line to read on.",
  schema: z.object({
    from_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('The line to start from, for the rest of a long page. Default 1'),
  }),
  needs: ['browser'],
  mutates: false,
  label: (args) => (args.from_line && args.from_line > 1 ? 'Reading on' : 'Reading the page'),
  approval: () => ({ kind: 'tool', subject: 'Read the page', pattern: '*' }),
  risk: () => LOW_RISK,
  run: async (args, ctx) => result(await browserOf(ctx).read(args.from_line ?? 1)),
});

export const browserClick = lenientRef(
  defineTool({
    name: 'browser_click',
    description:
      'Clicks a link, button, checkbox or other element by its ref from browser_read. Returns the new page if the click led to one.',
    schema: z.object({ ref: refArg }),
    needs: ['browser'],
    mutates: false,
    label: (args) => `Clicking [${args.ref}]`,
    approval: (args) => ({ kind: 'tool', subject: `Click [${args.ref}]`, pattern: '*' }),
    risk: (_args, ctx) => pageActionRisk(ctx, 'Clicks'),
    run: async (args, ctx) => result(await browserOf(ctx).click(args.ref)),
  }),
);

export const browserType = lenientRef(
  defineTool({
    name: 'browser_type',
    description:
      'Types into a text field by its ref, replacing what is in it, or picks an option of a drop-down by its label. Set submit to press Enter afterwards, as for a search box. Never type passwords, keys or other secrets.',
    schema: z.object({
      ref: refArg,
      text: z.string().max(10_000).describe('What to type, or the option to pick'),
      submit: z.boolean().optional().describe('Press Enter after typing. Default false'),
    }),
    needs: ['browser'],
    mutates: false,
    label: (args) => `Typing into [${args.ref}]`,
    approval: (args) => ({
      kind: 'tool',
      subject: `Type "${args.text}" into [${args.ref}]${args.submit ? ', then press Enter' : ''}`,
      pattern: '*',
    }),
    risk: (_args, ctx) => pageActionRisk(ctx, 'Types'),
    run: async (args, ctx) =>
      result(await browserOf(ctx).type(args.ref, args.text, args.submit ?? false)),
  }),
);

export const browserPress = defineTool({
  name: 'browser_press',
  description:
    'Presses keys in the current tab, such as Enter, Escape, Tab, ArrowDown, PageDown or Control+A. Separate several presses with spaces: "Tab Tab Enter".',
  schema: z.object({ keys: z.string().min(1).max(200).describe('The keys, such as Enter') }),
  needs: ['browser'],
  mutates: false,
  label: (args) => `Pressing ${short(args.keys, 30)}`,
  approval: (args) => ({ kind: 'tool', subject: `Press ${args.keys}`, pattern: '*' }),
  risk: (_args, ctx) => pageActionRisk(ctx, 'Presses keys'),
  run: async (args, ctx) => result(await browserOf(ctx).press(args.keys)),
});

export const browserScroll = lenientRef(
  defineTool({
    name: 'browser_scroll',
    description:
      'Scrolls the current page by most of a screen, or brings an element into view by its ref.',
    schema: z.object({
      direction: z.enum(['down', 'up']).optional().describe('Default down'),
      ref: refArg.optional().describe('Scroll this element into view instead'),
    }),
    needs: ['browser'],
    mutates: false,
    label: (args) =>
      args.ref ? `Scrolling to [${args.ref}]` : `Scrolling ${args.direction ?? 'down'}`,
    approval: () => ({ kind: 'tool', subject: 'Scroll the page', pattern: '*' }),
    risk: () => LOW_RISK,
    run: async (args, ctx) =>
      result(await browserOf(ctx).scroll(args.direction ?? 'down', args.ref ?? null)),
  }),
);

export const browserScreenshot = defineTool({
  name: 'browser_screenshot',
  description:
    "Takes a picture of what's visible in the current tab, to check how a page looks: layout, images, colours. Read text with browser_read instead.",
  schema: z.object({}),
  needs: ['browser', 'vision'],
  mutates: false,
  label: () => 'Taking a screenshot',
  approval: () => ({ kind: 'tool', subject: 'Take a screenshot of the page', pattern: '*' }),
  risk: () => LOW_RISK,
  async run(_args, ctx) {
    const step = await browserOf(ctx).screenshot();
    return { ...result(step), showModel: step.image !== undefined };
  },
});

export const browserStyles = defineTool({
  name: 'browser_styles',
  description:
    "Reads how the current page looks, as the browser drew it: its fonts and where each is used, its colours as hex, how its buttons and cards are shaped, and its logo and pictures, numbered. Use it to match a site's design language; browser_read gives only the words.",
  schema: z.object({}),
  needs: ['browser'],
  mutates: false,
  label: () => "Reading the page's look",
  approval: () => ({
    kind: 'tool',
    subject: "Read the page's fonts, colours and pictures",
    pattern: '*',
  }),
  risk: () => LOW_RISK,
  run: async (_args, ctx) => result(await browserOf(ctx).styles()),
});

/** What a picture's bytes are, whatever its address or its server says. */
function sniffImage(data: Uint8Array): string | null {
  const head = Buffer.from(data.subarray(0, 512));
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  const start = head.toString('latin1');
  if (start.startsWith('GIF8')) return 'image/gif';
  if (start.startsWith('RIFF') && start.slice(8, 12) === 'WEBP') return 'image/webp';
  if (start.slice(4, 12) === 'ftypavif') return 'image/avif';
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(start))
    return 'image/svg+xml';
  return null;
}

/**
 * An SVG with what could run taken out. A design draws it as an image, where nothing in it runs,
 * but the file is in the project, where a page might use it some other way.
 */
export function inertSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?(<\/script\s*>|$)/gi, '')
    .replace(/<foreignObject[\s\S]*?(<\/foreignObject\s*>|$)/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/((?:xlink:)?href\s*=\s*["'])\s*javascript:[^"']*/gi, '$1#');
}

/** A listed picture's bytes and what kind of picture they are. */
async function pictureOf(
  image: ListedImage,
  ctx: ToolContext,
): Promise<{ data: Buffer; type: string }> {
  let data: Buffer;
  // What its address or its server calls it, which the bytes may contradict.
  let said: string;
  if (image.svg) {
    data = Buffer.from(image.svg, 'utf8');
    said = 'image/svg+xml';
  } else if (image.url?.startsWith('data:')) {
    const comma = image.url.indexOf(',');
    const meta = image.url.slice(5, Math.max(5, comma));
    const payload = image.url.slice(comma + 1);
    said = meta.split(';')[0]!.toLowerCase();
    try {
      data = /;base64$/i.test(meta)
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8');
    } catch {
      throw new ToolFailure("The picture is embedded in the page in a way that can't be read.");
    }
  } else if (image.url && /^https?:\/\//i.test(image.url)) {
    let response: Response;
    try {
      response = await ctx.web.fetch(image.url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.5' },
        redirect: 'follow',
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]),
      });
    } catch (error) {
      const cause = (error as Error & { cause?: Error }).cause;
      throw new ToolFailure(
        `Couldn't fetch ${image.url}: ${cause?.message ?? (error as Error).message}`,
      );
    }
    if (!response.ok) {
      throw new ToolFailure(`${image.url} answered ${response.status}, so nothing was saved.`);
    }
    const read = await readCapped(response, MAX_IMAGE_BYTES + 1);
    data = read.body;
    said = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  } else {
    throw new ToolFailure(
      "That isn't a picture's address. Give a number from browser_styles' list, or an address starting with https://.",
    );
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw new ToolFailure('The picture is bigger than 12 MB, too big for a design.');
  }
  const type = sniffImage(data) ?? (said in IMAGE_EXTENSIONS ? said : null);
  if (!type) {
    throw new ToolFailure(
      `That isn't a picture a design can show${said ? ` (it's ${said})` : ''}. Designs take PNG, JPEG, GIF, WebP, AVIF and SVG.`,
    );
  }
  return type === 'image/svg+xml'
    ? { data: Buffer.from(inertSvg(data.toString('utf8')), 'utf8'), type }
    : { data, type };
}

const DEFAULT_NAMES: Record<string, string> = { logo: 'logo', icon: 'icon', card: 'social-card' };

/** Models write a picture's number as 2, "2" or "[2]". */
function listNumber(image: number | string): number | null {
  if (typeof image === 'number') return image;
  return /^\s*\[?\s*\d+\s*\]?\s*$/.test(image) ? Number(image.replace(/\D/g, '')) : null;
}

export const browserSaveImage = defineTool({
  name: 'browser_save_image',
  description:
    "Saves a picture from the current page into the project's `design/assets` folder, so a design can show it: the logo, icon or a product picture of the site you are designing for. Give its number from browser_styles' list.",
  schema: z.object({
    image: z
      .union([z.number().int().min(1), z.string().trim().min(1).max(4000)])
      .describe("Its number in browser_styles' list, such as 1, or the picture's address"),
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .optional()
      .describe('What to call the file, without an extension, such as logo'),
  }),
  needs: ['browser', 'workspace'],
  mutates: true,
  label: (args) =>
    `Saving ${args.name ? `\`${short(args.name, 30)}\`` : 'a picture'} from the page`,
  approval: () => ({
    kind: 'tool',
    subject: "Save a picture from the page into the project's design/assets",
    pattern: '*',
  }),
  risk: (args) =>
    typeof args.image === 'string' && listNumber(args.image) === null
      ? urlRisk(args.image)
      : LOW_RISK,
  async run(args, ctx) {
    const ws = ctx.workspace;
    if (!ws) throw new ToolFailure('This chat has no workspace, so there is nowhere to save it.');
    const number = listNumber(args.image);
    const listed: ListedImage =
      number !== null
        ? await browserOf(ctx).listed(number)
        : { kind: 'image', note: '', url: String(args.image), svg: null };
    const { data, type } = await pictureOf(listed, ctx);
    const extension = IMAGE_EXTENSIONS[type]!;
    const given = args.name ? args.name.slice(0, args.name.length - extname(args.name).length) : '';
    const base =
      (given || DEFAULT_NAMES[listed.kind] || 'image')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'image';
    let full: string;
    let path = `${ASSETS_DIR}/${base}${extension}`;
    try {
      full = resolveInside(ws.root, ws.cwd, path);
      for (let i = 2; existsSync(full); i++) {
        path = `${ASSETS_DIR}/${base}-${i}${extension}`;
        full = resolveInside(ws.root, ws.cwd, path);
      }
    } catch (error) {
      if (error instanceof PathError) throw new ToolFailure(error.message);
      throw error;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
    const rel = toRelative(ws.cwd, full).replace(/\\/g, '/');
    const size =
      data.length < 1024 ? `${data.length} bytes` : `${Math.round(data.length / 1024)} kB`;
    return {
      content: `Saved the ${listed.kind}${listed.note ? ` ${listed.note}` : ''} as \`${rel}\` (${size}). A design shows it with \`<Image src="${rel}" alt="…" />\`.`,
    };
  },
});

export const browserConsole = defineTool({
  name: 'browser_console',
  description:
    "Returns what the current page logged to its console since it loaded: errors, warnings and messages. Use it to check a page you're building.",
  schema: z.object({}),
  needs: ['browser'],
  mutates: false,
  label: () => 'Reading the console',
  approval: () => ({ kind: 'tool', subject: "Read the page's console", pattern: '*' }),
  risk: () => LOW_RISK,
  run: async (_args, ctx) => result(await browserOf(ctx).console()),
});

export const browserBack = defineTool({
  name: 'browser_back',
  description: 'Goes back to the previous page in the current tab.',
  schema: z.object({}),
  needs: ['browser'],
  mutates: false,
  label: () => 'Going back',
  approval: () => ({ kind: 'tool', subject: 'Go back a page', pattern: '*' }),
  risk: () => LOW_RISK,
  run: async (_args, ctx) => result(await browserOf(ctx).back()),
});

export const browserClose = defineTool({
  name: 'browser_close',
  description:
    'Closes the current tab when you are done with it. The tab before it becomes current.',
  schema: z.object({}),
  needs: ['browser'],
  mutates: false,
  label: () => 'Closing the tab',
  approval: () => ({ kind: 'tool', subject: 'Close the tab', pattern: '*' }),
  risk: () => LOW_RISK,
  run: async (_args, ctx) => result(await browserOf(ctx).close()),
});

export const BROWSER_TOOLS = [
  browserOpen,
  browserNavigate,
  browserRead,
  browserClick,
  browserType,
  browserPress,
  browserScroll,
  browserScreenshot,
  browserStyles,
  browserSaveImage,
  browserConsole,
  browserBack,
  browserClose,
];
