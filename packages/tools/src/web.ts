import { headOnly } from '@clanks/workspace';
import { z } from 'zod';
import { redactUrl } from './redact';
import { LOW_RISK, urlRisk } from './risk';
import { type SearchResult, ToolFailure, defineTool, short } from './spec';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
export const USER_AGENT = 'Mozilla/5.0 (compatible; clanks; +https://clanks.si)';
/** A page with scripts and less text than this is taken to be drawn by them. */
const DRAWN_PAGE_CHARS = 200;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  middot: '·',
  bull: '•',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const value =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(value) && value > 0 && value < 0x110000
        ? String.fromCodePoint(value)
        : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * A web page as readable text, close to Markdown: headings, lists and links kept, scripts, styles
 * and navigation chrome dropped. Small models read this far better than HTML. `description` is
 * what the page says about itself in its head, which is all a page drawn by scripts says.
 */
export function htmlToText(html: string): { title: string; text: string; description: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const description = decodeEntities(metaContent(html, 'description') ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  // The main content, when the page marks it.
  const main =
    /<main[\s>][\s\S]*?<\/main>/i.exec(html)?.[0] ??
    /<article[\s>][\s\S]*?<\/article>/i.exec(html)?.[0] ??
    /<body[\s>][\s\S]*<\/body>/i.exec(html)?.[0] ??
    html;
  let text = main
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<(script|style|noscript|svg|template|iframe|head|nav|footer|form)[\s>][\s\S]*?<\/\1>/gi,
      '',
    )
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_m, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inner}\n\n`,
    )
    .replace(
      /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, inner: string) => {
        const label = inner.replace(/<[^>]+>/g, '').trim();
        return label && /^https?:/i.test(href) ? `[${label}](${href})` : label;
      },
    )
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|ul|ol|table|tr|blockquote|pre|header|dl|dd|dt)>/gi, '\n')
    .replace(/<(p|div|section|table|tr|blockquote|pre|header)[\s>]/gi, (m) => `\n${m}`)
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text, description };
}

/** A `<meta>` tag's content by its name, or by its Open Graph property of the same name. */
function metaContent(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const key = /\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (key !== name && key !== `og:${name}`) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const value = content?.[1] ?? content?.[2];
    if (value) return value;
  }
  return null;
}

/** Reads at most `max` bytes of a response. */
export async function readCapped(
  response: Response,
  max: number,
): Promise<{ body: Buffer; cut: boolean }> {
  if (!response.body) return { body: Buffer.alloc(0), cut: false };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
    size += chunk.byteLength;
    if (size >= max) {
      await response.body.cancel().catch(() => {});
      return { body: Buffer.concat(chunks).subarray(0, max), cut: true };
    }
  }
  return { body: Buffer.concat(chunks), cut: false };
}

export const webFetch = defineTool({
  name: 'web_fetch',
  description:
    'Fetches a web page or file over http(s) and returns it as text. Pages come back as readable text, not HTML. It gives what a page says, not how it looks.',
  schema: z.object({
    url: z.string().url().describe('The full address, starting with https://'),
  }),
  needs: [],
  uses: ['browser'],
  mutates: false,
  label: (args) => `Fetching \`${short(redactUrl(args.url))}\``,
  approval(args) {
    let pattern = args.url;
    try {
      pattern = `${new URL(args.url).origin}/*`;
    } catch {
      // Not a URL: the call fails anyway.
    }
    return { kind: 'url', subject: args.url, pattern };
  },
  risk: (args) => urlRisk(args.url),
  async run(args, ctx) {
    if (!/^https?:\/\//i.test(args.url))
      throw new ToolFailure('Only http and https addresses work.');
    let response: Response;
    try {
      response = await ctx.web.fetch(args.url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,text/plain,application/json,*/*;q=0.5',
        },
        redirect: 'follow',
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      });
    } catch (error) {
      const cause = (error as Error & { cause?: Error }).cause;
      throw new ToolFailure(
        `Couldn't fetch ${args.url}: ${cause?.message ?? (error as Error).message}`,
      );
    }
    const type = response.headers.get('content-type') ?? '';
    const { body, cut } = await readCapped(response, MAX_DOWNLOAD_BYTES);
    if (
      !/^(text\/|application\/(json|xml|xhtml|javascript|ld\+json|rss|atom))|\+xml|\+json/i.test(
        type,
      ) &&
      type
    ) {
      throw new ToolFailure(
        `${args.url} is ${type.split(';')[0]}, not text, so it can't be read here.`,
      );
    }
    const raw = body.toString('utf8');
    const isHtml = /html/i.test(type) || /^\s*<(!doctype html|html)/i.test(raw);
    const page = isHtml ? htmlToText(raw) : { title: '', text: raw, description: '' };
    const { title, description } = page;
    let text = page.text;
    // A page that's empty until its scripts run is read where they do, when there's a browser.
    const drawn = isHtml && text.length < DRAWN_PAGE_CHARS && /<script[\s>]/i.test(raw);
    let inBrowser = false;
    if (drawn && response.ok && ctx.browser) {
      try {
        const shown = await ctx.browser.text(response.url || args.url);
        if (shown.trim().length > text.length) {
          text = shown.trim();
          inBrowser = true;
        }
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        // The browser couldn't show it either: what was fetched is all there is.
      }
    }
    const header = [
      `URL: ${response.url || args.url}`,
      `Status: ${response.status}${response.ok ? '' : ` ${response.statusText}`}`,
      ...(title ? [`Title: ${title}`] : []),
      ...(description ? [`Description: ${description}`] : []),
      ...(inBrowser ? ['Its scripts draw the page, so it was read in the browser.'] : []),
    ].join('\n');
    const empty =
      drawn && !inBrowser
        ? "(The page has no text of its own: its scripts draw it in a browser, which isn't here to run them. The description above is all it says without one.)"
        : '(The page has no text.)';
    const content = headOnly(
      `${header}\n\n${text || empty}${cut ? '\n\n[Only the first 5 MB was downloaded.]' : ''}`,
      ctx.maxChars,
      'The rest of the page was cut to fit.',
    );
    return { content, error: !response.ok };
  },
});

export const webSearch = defineTool({
  name: 'web_search',
  description:
    'Searches the web and returns the top results with their addresses. Read a result in full with web_fetch or browser_open.',
  schema: z.object({
    query: z.string().min(1).describe('What to search for'),
    count: z.number().int().min(1).max(10).optional().describe('How many results. Default 5'),
  }),
  needs: ['search'],
  mutates: false,
  label: (args) => `Searching the web for "${short(args.query, 40)}"`,
  approval: (args) => ({ kind: 'tool', subject: args.query, pattern: '*' }),
  risk: () => LOW_RISK,
  async run(args, ctx) {
    const count = args.count ?? 5;
    let results: SearchResult[];
    if (ctx.web.search) {
      results = await ctx.web.search(args.query, count, ctx.signal);
    } else if (ctx.browser) {
      // No backend: the search runs in the browser pane, where the user can watch it.
      const found = await ctx.browser.search(args.query, count);
      if (found.results.length === 0 && found.page) {
        return {
          content: headOnly(
            `The results couldn't be picked off the search page, so here it is as text:\n\n${found.page}`,
            ctx.maxChars,
            'The rest of the page was cut.',
          ),
        };
      }
      results = found.results;
    } else {
      throw new ToolFailure('No web search is set up.');
    }
    if (results.length === 0) return { content: `No results for "${args.query}".` };
    const lines = results.map(
      (r, i) =>
        `${i + 1}. ${r.title || r.url}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.replace(/\s+/g, ' ').trim()}` : ''}`,
    );
    return { content: headOnly(lines.join('\n\n'), ctx.maxChars, 'More results were cut.') };
  },
});

export const WEB_TOOLS = [webSearch, webFetch];

export type SearchBackend =
  | { kind: 'searxng'; url: string }
  | { kind: 'brave'; key: string }
  | { kind: 'tavily'; key: string };

/** A search function for the backend the user set up. */
export function searchWith(backend: SearchBackend, doFetch: typeof fetch = fetch) {
  return async (query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> => {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
    let response: Response;
    try {
      if (backend.kind === 'searxng') {
        const url = new URL('search', backend.url.replace(/\/*$/, '/'));
        url.searchParams.set('q', query);
        url.searchParams.set('format', 'json');
        response = await doFetch(url, { signal: timeout, headers: { Accept: 'application/json' } });
      } else if (backend.kind === 'brave') {
        const url = new URL('https://api.search.brave.com/res/v1/web/search');
        url.searchParams.set('q', query);
        url.searchParams.set('count', String(count));
        response = await doFetch(url, {
          signal: timeout,
          headers: { Accept: 'application/json', 'X-Subscription-Token': backend.key },
        });
      } else {
        response = await doFetch('https://api.tavily.com/search', {
          method: 'POST',
          signal: timeout,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${backend.key}` },
          body: JSON.stringify({ query, max_results: count }),
        });
      }
    } catch (error) {
      throw new ToolFailure(`The search failed: ${(error as Error).message}`);
    }
    if (!response.ok) {
      const name = { searxng: 'SearXNG', brave: 'Brave Search', tavily: 'Tavily' }[backend.kind];
      throw new ToolFailure(
        `${name} answered HTTP ${response.status}${backend.kind === 'searxng' && response.status === 403 ? '. Turn on the JSON format in its settings.yml.' : '.'}`,
      );
    }
    const body = (await response.json()) as {
      results?: { title?: string; url?: string; content?: string; description?: string }[];
      web?: { results?: { title?: string; url?: string; description?: string }[] };
    };
    const raw: { title?: string; url?: string; content?: string; description?: string }[] =
      backend.kind === 'brave' ? (body.web?.results ?? []) : (body.results ?? []);
    return raw
      .filter((r) => r.url)
      .slice(0, count)
      .map((r) => ({
        title: htmlToText(r.title ?? '').text,
        url: r.url!,
        snippet: htmlToText(r.content ?? r.description ?? '').text,
      }));
  };
}
