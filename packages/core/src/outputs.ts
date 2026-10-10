import type { OutputType } from './crew';

/**
 * What the crew hands in besides code and designs: documents, copy, emails, research notes and
 * campaigns. Each has a contract, in its maker's priming doc, that `submit_output` is checked
 * against. A hand-in that breaks it is refused with what to fix; smaller things are warnings that
 * go on the ticket for Atlas and the user.
 */

/** An email as Quill drafts it. The user sends it; a clank never does. */
export interface EmailDraft {
  to: string[];
  cc: string[];
  subject: string;
  /** Plain text. */
  body: string;
}

/** One post in a campaign: where, when, what it says and the picture that goes with it. */
export interface CampaignPost {
  channel: string;
  /** The account it goes out from, such as `@surfshop`. */
  account: string | null;
  /** When, as written, with its time zone. */
  at: string | null;
  text: string;
  /** The name of Prism's frame for it, or what the picture should show. */
  visual: string | null;
}

/** A source a research note cites, from its Sources list. */
export interface ResearchSource {
  /** Its number in the list, which the note cites as `[n]`. */
  n: number;
  /** The line as written: title, publisher, dates. */
  text: string;
  url: string | null;
}

/** A page Scout read for a research note, kept as a picture with the ticket. */
export interface SourceShot {
  /** The source it shows, by number. */
  source: number;
  url: string;
  /** The picture, by its artifact's id. */
  artifact: string;
}

/** The pages a research note's sources were pictured on, when it's research. */
export function shotsOf(output: Record<string, unknown> | null): SourceShot[] {
  if (!output || !Array.isArray(output.screenshots)) return [];
  return output.screenshots.filter(
    (s): s is SourceShot =>
      typeof s === 'object' && s !== null && typeof (s as SourceShot).artifact === 'string',
  );
}

/** Whether two addresses are the same page, whatever their `www.`, query, hash or last slash. */
export function samePage(a: string, b: string): boolean {
  // By hand, since this runs in the window and the orchestrator alike: host, then path.
  const page = (address: string) => {
    const parts = /^https?:\/\/(?:[^/@?#]*@)?([^/:?#]+)(?::\d+)?([^?#]*)/i.exec(address.trim());
    if (!parts) return null;
    return `${parts[1]!.replace(/^www\./i, '').toLowerCase()}${parts[2]!.replace(/\/+$/, '')}`;
  };
  const left = page(a);
  return left !== null && left === page(b);
}

export interface OutputCheck {
  /** The hand-in, tidied: lists are lists, names are the contract's. */
  output: Record<string, unknown>;
  /** Why it can't be handed in as it is. */
  problems: string[];
  /** What Atlas and the user should know, which doesn't stop it. */
  warnings: string[];
}

/** The types whose hand-in is words rather than a branch: what `checkOutput` has a contract for. */
export const WRITTEN_OUTPUTS = ['doc', 'copy', 'email', 'research', 'campaign', 'other'] as const;

export type WrittenOutput = (typeof WRITTEN_OUTPUTS)[number];

export function isWrittenOutput(type: OutputType): type is WrittenOutput {
  return (WRITTEN_OUTPUTS as readonly string[]).includes(type);
}

/** Small models wrap a value as `{ "value": … }`; this takes it out again. */
function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'value') {
      return unwrap((value as Record<string, unknown>).value);
    }
  }
  return value;
}

/** The first of some fields that holds text. */
function text(fields: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = unwrap(fields[name]);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** A list a model wrote as a list, as JSON in a string, or as lines or commas in one. */
function list(value: unknown): unknown[] {
  const raw = unwrap(value);
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON after all: split it as text.
    }
  }
  return trimmed
    .split(/[\n,;]+/)
    .map((item) => item.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
}

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

/** An address as written: `sam@example.com`, or `Sam <sam@example.com>`. Null when it isn't one. */
export function parseAddress(raw: string): { name: string | null; address: string } | null {
  const value = raw.trim();
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(value);
  const address = (named ? named[2]! : value).trim();
  if (!ADDRESS.test(address)) return null;
  const name = named?.[1]?.replace(/^"|"$/g, '').trim() || null;
  return { name, address };
}

/** The addresses in a field, and the entries that aren't addresses. */
function addresses(value: unknown): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const item of list(value)) {
    if (typeof item !== 'string' || !item.trim()) continue;
    // A guess left as a placeholder, such as "[TODO: the shop's address]", is no address.
    if (parseAddress(item)) ok.push(item.trim());
    else bad.push(item.trim());
  }
  return { ok: [...new Set(ok)], bad };
}

/** The most a post may hold on each platform, in characters. */
const POST_LIMITS: [RegExp, number][] = [
  [/\b(x|twitter)\b/i, 280],
  [/\bbluesky\b/i, 300],
  [/\b(threads|mastodon)\b/i, 500],
  [/\b(instagram|tiktok)\b/i, 2200],
  [/\blinkedin\b/i, 3000],
  [/\bpinterest\b/i, 500],
  [/\bfacebook\b/i, 63_206],
  [/\bsms\b/i, 160],
];

/** How long a post on a channel may be. Null when the channel has no limit worth checking. */
export function postLimit(channel: string): number | null {
  return POST_LIMITS.find(([pattern]) => pattern.test(channel))?.[1] ?? null;
}

/** A post's length as its platform counts it: a link is 23 characters on X, whatever its length. */
export function postLength(post: Pick<CampaignPost, 'channel' | 'text'>): number {
  const text = /\b(x|twitter)\b/i.test(post.channel)
    ? post.text.replace(/https?:\/\/\S+/g, 'x'.repeat(23))
    : post.text;
  return [...text].length;
}

const PLAN_SECTIONS = ['Goal', 'Audience', 'Positioning', 'Channels', 'Calendar'];

/** Where a research note's list of sources starts. */
const SOURCES_HEADING = /^#{1,6}\s*(sources|references)\s*:?\s*$/im;

/** The sources a research note lists, numbered as it numbers them. */
export function parseSources(note: string): ResearchSource[] {
  const heading = SOURCES_HEADING.exec(note);
  if (!heading) return [];
  const sources: ResearchSource[] = [];
  for (const line of note.slice(heading.index + heading[0].length).split('\n')) {
    if (/^#{1,6}\s/.test(line)) break;
    const item = /^\s*(?:\[(\d+)\]|(\d+)[.)])\s*(.+)$/.exec(line);
    if (!item) continue;
    const text = item[3]!.trim();
    const url = /https?:\/\/[^\s<>)\]]+/.exec(text)?.[0].replace(/[.,;]+$/, '') ?? null;
    sources.push({ n: Number(item[1] ?? item[2]), text, url });
  }
  return sources;
}

/** The source numbers a note cites in its text, such as `[1]` and `[2, 3]`, in order. */
export function citedSources(note: string): number[] {
  const heading = SOURCES_HEADING.exec(note);
  const body = heading ? note.slice(0, heading.index) : note;
  const cited = new Set<number>();
  for (const match of body.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\](?!\()/g)) {
    for (const part of match[1]!.split(',')) {
      const range = /^\s*(\d+)\s*[–-]\s*(\d+)\s*$/.exec(part);
      if (range) {
        for (let n = Number(range[1]); n <= Math.min(Number(range[2]), Number(range[1]) + 50); n++)
          cited.add(n);
      } else cited.add(Number(part.trim()));
    }
  }
  return [...cited].sort((a, b) => a - b);
}

/** `[TODO: …]` placeholders left in a piece of writing, for the user to fill. */
export function placeholders(body: string): string[] {
  return [...body.matchAll(/\[TODO:?\s*([^\]]*)\]/gi)].map((m) => m[1]!.trim() || 'something');
}

/** A document's title: its own field, or its first heading. */
function titleOf(fields: Record<string, unknown>, body: string): string {
  return text(fields, 'title', 'name') || (/^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? '');
}

/** A path in the repository a document is saved to: relative, inside it, and a text file. */
export function documentPathProblem(path: string): string | null {
  const clean = path.replace(/\\/g, '/').trim();
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').includes('..')) {
    return `"${path}" isn't a path inside the project. Give one relative to its top folder, such as docs/launch.md.`;
  }
  if (clean.split('/').some((part) => part === '.git')) {
    return `"${path}" is inside .git, which holds no documents.`;
  }
  if (!/\.(md|mdx|markdown|txt)$/i.test(clean)) {
    return `"${path}" isn't a Markdown or text file. Use a name ending in .md, .mdx or .txt.`;
  }
  return null;
}

function noteWarnings(body: string, warnings: string[]): void {
  const todo = placeholders(body);
  if (todo.length > 0) {
    warnings.push(
      `${todo.length} ${todo.length === 1 ? 'placeholder' : 'placeholders'} to fill: ${todo.slice(0, 5).join('; ')}${todo.length > 5 ? '; …' : ''}`,
    );
  }
}

function checkDocument(
  type: 'doc' | 'copy' | 'other',
  fields: Record<string, unknown>,
): OutputCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const body = text(fields, 'body', 'content', 'markdown', 'text', 'document');
  const title = titleOf(fields, body);
  if (!body && type !== 'other') {
    problems.push(`Put the ${type === 'doc' ? 'document' : 'copy'} in \`body\`, as Markdown.`);
  }
  if (!body && type === 'other' && !text(fields, 'summary') && !title) {
    problems.push('Say what you made in `title` and `body`, or `summary`.');
  }
  if (body && !title) problems.push('Give it a `title`.');
  const output: Record<string, unknown> = { ...fields, type };
  for (const alias of ['content', 'markdown', 'text', 'document', 'name']) delete output[alias];
  if (title) output.title = title;
  if (body) output.body = body;
  const path = text(fields, 'path', 'file');
  delete output.file;
  if (path) {
    const problem = documentPathProblem(path);
    if (problem) problems.push(problem);
    else output.path = path.replace(/\\/g, '/').trim();
  } else delete output.path;
  if (/<(script|iframe|style|object|embed)\b/i.test(body)) {
    problems.push('Take the raw HTML out of `body`: documents are Markdown only.');
  } else if (
    /<\/?(div|span|p|br|table|img|a|h[1-6])\b[^>]*>/i.test(body.replace(/```[\s\S]*?```/g, ''))
  ) {
    warnings.push("It has raw HTML, which doesn't export to DOCX or PDF. Markdown would.");
  }
  noteWarnings(body, warnings);
  return { output, problems, warnings };
}

function checkEmail(fields: Record<string, unknown>): OutputCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const subject = text(fields, 'subject', 'title').replace(/\s+/g, ' ');
  const body = text(fields, 'body', 'content', 'text');
  const to = addresses(fields.to);
  const cc = addresses(fields.cc);
  if (!subject) problems.push('Give the email a `subject`.');
  else if (subject.length > 200) problems.push('The subject is over 200 characters. Shorten it.');
  if (!body) problems.push("Put the email's text in `body`, as plain text.");
  const bad = [...to.bad, ...cc.bad];
  if (bad.length > 0) {
    problems.push(
      `${bad.map((b) => `"${b}"`).join(', ')} ${bad.length === 1 ? "isn't an email address" : "aren't email addresses"}. Leave \`to\` empty when you don't know the address, and say whose it is in \`notes\`.`,
    );
  }
  if (subject.length > 60 && subject.length <= 200) {
    warnings.push(`The subject is ${subject.length} characters; under 60 shows in full.`);
  }
  if (to.ok.length === 0 && bad.length === 0)
    warnings.push('No recipient yet: add one before sending.');
  noteWarnings(`${subject}\n${body}`, warnings);
  const output: Record<string, unknown> = { ...fields, type: 'email' };
  for (const alias of ['content', 'text', 'title']) delete output[alias];
  Object.assign(output, { to: to.ok, cc: cc.ok, subject, body });
  return { output, problems, warnings };
}

function checkResearch(fields: Record<string, unknown>): OutputCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const note = text(fields, 'note', 'body', 'content', 'markdown');
  const title = titleOf(fields, note);
  const output: Record<string, unknown> = { ...fields, type: 'research' };
  for (const alias of ['body', 'content', 'markdown']) delete output[alias];
  if (title) output.title = title;
  if (!note) {
    problems.push('Put the research note in `note`, as Markdown ending with a "## Sources" list.');
    return { output, problems, warnings };
  }
  output.note = note;
  const sources = parseSources(note);
  if (sources.length === 0) {
    problems.push(
      'The note has no sources. End it with a "## Sources" heading and a numbered list, one source per line with its URL, such as "1. Pricing. Stripe, updated 2026-08-14. https://stripe.com/au/pricing (seen 2026-10-05)".',
    );
    return { output, problems, warnings };
  }
  output.sources = sources;
  const numbers = sources.map((s) => s.n);
  const cited = citedSources(note);
  const unknown = cited.filter((n) => !numbers.includes(n));
  if (unknown.length > 0) {
    problems.push(
      `The note cites ${unknown.map((n) => `[${n}]`).join(', ')}, but its Sources list has no ${unknown.length === 1 ? 'such source' : 'such sources'}. Add ${unknown.length === 1 ? 'it' : 'them'}, or fix the ${unknown.length === 1 ? 'number' : 'numbers'}.`,
    );
  }
  if (cited.length === 0) {
    problems.push(
      'Nothing in the note cites its sources. Put the source numbers after each fact, such as "Stripe charges 1.7% + 30c. [1]".',
    );
  }
  const without = sources.filter((s) => !s.url);
  if (without.length > 0) {
    warnings.push(
      `${without.length === 1 ? 'Source' : 'Sources'} ${without.map((s) => s.n).join(', ')} ${without.length === 1 ? 'has' : 'have'} no URL, so ${without.length === 1 ? "it can't" : "they can't"} be checked.`,
    );
  }
  const unused = numbers.filter((n) => !cited.includes(n));
  if (cited.length > 0 && unused.length > 0) {
    warnings.push(
      `${unused.length === 1 ? 'Source' : 'Sources'} ${unused.join(', ')} ${unused.length === 1 ? "isn't" : "aren't"} cited in the note.`,
    );
  }
  return { output, problems, warnings };
}

function postOf(raw: unknown): Record<string, unknown> | null {
  let value = unwrap(raw);
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function checkCampaign(fields: Record<string, unknown>): OutputCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  const plan = text(fields, 'plan', 'body', 'content');
  const title = titleOf(fields, plan);
  const output: Record<string, unknown> = { ...fields, type: 'campaign' };
  for (const alias of ['body', 'content']) delete output[alias];
  if (title) output.title = title;
  if (!plan) problems.push('Put the plan in `plan`, as Markdown.');
  else {
    output.plan = plan;
    const missing = PLAN_SECTIONS.filter(
      (section) => !new RegExp(`^#{1,6}.*\\b${section}`, 'im').test(plan),
    );
    if (missing.length > 0) {
      warnings.push(
        `The plan has no ${missing.join(', ')} section${missing.length === 1 ? '' : 's'}.`,
      );
    }
  }
  // A plan that says its posts are drafted, with no posts in it, is the commonest slip there is:
  // leaving the field out is turned back once, while an empty list says there are none on purpose.
  if (unwrap(fields.posts) === undefined || unwrap(fields.posts) === null) {
    problems.push(
      'The campaign has no `posts`. Put every post you drafted in `posts`, one entry each with `channel`, `at`, `text` and `visual`: writing them into the plan or the notes is not enough. If this plan really has no posts to draft, pass `posts` as an empty list.',
    );
  }
  const posts: CampaignPost[] = [];
  list(fields.posts).forEach((raw, i) => {
    const post = postOf(raw);
    if (!post) {
      problems.push(
        `Post ${i + 1} isn't an object. Give each post \`channel\`, \`text\` and, when you know them, \`account\`, \`at\` and \`visual\`.`,
      );
      return;
    }
    const channel = text(post, 'channel', 'platform', 'network');
    const body = text(post, 'text', 'copy', 'body', 'caption', 'content');
    if (!channel) problems.push(`Post ${i + 1} has no \`channel\`, such as "Instagram".`);
    if (!body) problems.push(`Post ${i + 1} has no \`text\`.`);
    if (!channel || !body) return;
    const entry: CampaignPost = {
      channel,
      account: text(post, 'account', 'handle') || null,
      at: text(post, 'at', 'when', 'date', 'time') || null,
      text: body,
      visual: text(post, 'visual', 'image', 'frame') || null,
    };
    const limit = postLimit(channel);
    const length = postLength(entry);
    if (limit !== null && length > limit) {
      warnings.push(`Post ${i + 1} is ${length} characters; ${channel} takes ${limit}.`);
    }
    posts.push(entry);
  });
  output.posts = posts;
  if (posts.length === 0 && problems.length === 0) {
    warnings.push('It has no posts drafted, only the plan.');
  }
  noteWarnings(`${plan}\n${posts.map((p) => p.text).join('\n')}`, warnings);
  return { output, problems, warnings };
}

/**
 * Checks a hand-in against its type's contract and tidies it. Types whose work is a branch or the
 * spec (`pr`, `design`, `spec`) are checked elsewhere and come back as they are.
 */
export function checkOutput(type: OutputType, fields: Record<string, unknown>): OutputCheck {
  switch (type) {
    case 'doc':
    case 'copy':
    case 'other':
      return checkDocument(type, fields);
    case 'email':
      return checkEmail(fields);
    case 'research':
      return checkResearch(fields);
    case 'campaign':
      return checkCampaign(fields);
    default:
      return { output: fields, problems: [], warnings: [] };
  }
}

/**
 * Copy as its writer set it out: a line under another stays a line of its own, where Markdown
 * would run them together. "Headline: …" over "Button: …" is two lines, not a sentence. Lists,
 * tables, headings, quotes and code are left as they are.
 */
export function keepLineBreaks(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const plain = (line: string | undefined) =>
    line !== undefined &&
    line.trim() !== '' &&
    !/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|---+\s*$|\*\*\*+\s*$)/.test(line);
  let fenced = false;
  return lines
    .map((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced || !plain(line) || !plain(lines[i + 1])) return line;
      return /( {2}|\\)$/.test(line) ? line : `${line}  `;
    })
    .join('\n');
}

/** A hand-in's email, when it is one. */
export function emailOf(output: Record<string, unknown> | null): EmailDraft | null {
  if (!output || output.type !== 'email') return null;
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return {
    to: strings(output.to),
    cc: strings(output.cc),
    subject: typeof output.subject === 'string' ? output.subject : '',
    body: typeof output.body === 'string' ? output.body : '',
  };
}

/** A hand-in's posts, when it's a campaign. */
export function postsOf(output: Record<string, unknown> | null): CampaignPost[] {
  if (!output || !Array.isArray(output.posts)) return [];
  return output.posts.filter(
    (p): p is CampaignPost =>
      typeof p === 'object' && p !== null && typeof (p as CampaignPost).text === 'string',
  );
}

/** A hand-in's sources, when it's research. */
export function sourcesOf(output: Record<string, unknown> | null): ResearchSource[] {
  if (!output || !Array.isArray(output.sources)) return [];
  return output.sources.filter(
    (s): s is ResearchSource =>
      typeof s === 'object' && s !== null && typeof (s as ResearchSource).n === 'number',
  );
}

/** An email as a text file: its headers, a blank line, its body. */
export function emailText(email: EmailDraft): string {
  return [
    `To: ${email.to.join(', ')}`,
    ...(email.cc.length > 0 ? [`Cc: ${email.cc.join(', ')}`] : []),
    `Subject: ${email.subject}`,
    '',
    email.body,
  ].join('\n');
}

function withTitle(title: unknown, body: string): string {
  const heading = typeof title === 'string' ? title.trim() : '';
  if (!heading || /^#\s+\S/m.test(body.trimStart().split('\n')[0] ?? '')) return body;
  return `# ${heading}\n\n${body}`;
}

/** A campaign's posts as Markdown, one section each. */
export function postsMarkdown(posts: CampaignPost[]): string {
  return posts
    .map((post, i) => {
      const where = [post.channel, post.account, post.at].filter(Boolean).join(', ');
      return [
        `### ${i + 1}. ${where}`,
        '',
        post.text,
        ...(post.visual ? ['', `Visual: ${post.visual}`] : []),
      ].join('\n');
    })
    .join('\n\n');
}

/**
 * A written hand-in as one document, which is what's kept as the ticket's artifact and what
 * exports to DOCX and PDF. Null for work that isn't words.
 */
export function outputDocument(
  output: Record<string, unknown> | null,
): { name: string; mediaType: string; text: string; title: string } | null {
  if (!output) return null;
  const field = (name: string) => {
    const value = output[name];
    return typeof value === 'string' ? value : '';
  };
  const title = field('title');
  switch (output.type) {
    case 'doc':
    case 'copy':
    case 'other': {
      const body = field('body') || field('summary');
      if (!body) return null;
      return {
        name: `${String(output.type)}.md`,
        mediaType: 'text/markdown',
        text: withTitle(title, body),
        title: title || String(output.type),
      };
    }
    case 'research':
      if (!field('note')) return null;
      return {
        name: 'research.md',
        mediaType: 'text/markdown',
        text: withTitle(title, field('note')),
        title: title || 'Research note',
      };
    case 'campaign': {
      if (!field('plan')) return null;
      const posts = postsOf(output);
      return {
        name: 'campaign.md',
        mediaType: 'text/markdown',
        text: [
          withTitle(title, field('plan')),
          ...(posts.length > 0 ? ['## Posts', postsMarkdown(posts)] : []),
        ].join('\n\n'),
        title: title || 'Campaign',
      };
    }
    case 'email': {
      const email = emailOf(output)!;
      return {
        name: 'email.txt',
        mediaType: 'text/plain',
        text: emailText(email),
        title: email.subject || 'Email',
      };
    }
    default:
      return null;
  }
}
