import { z } from 'zod';
import { redactUrl } from './redact';
import {
  type BrowserAccess,
  type BrowserResult,
  type ToolContext,
  ToolFailure,
  type ToolResult,
  type ToolSpec,
  defineTool,
  short,
} from './spec';

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
  async run(_args, ctx) {
    const step = await browserOf(ctx).screenshot();
    return { ...result(step), showModel: step.image !== undefined };
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
  browserConsole,
  browserBack,
  browserClose,
];
