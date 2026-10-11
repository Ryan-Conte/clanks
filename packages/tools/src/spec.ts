import type { ToolApproval, ToolDefinition } from '@clanks/core';
import { z } from 'zod';
import type { Risk, RiskContext } from './risk';

/** The run's copy of a repository. Files and git tools work only inside it. */
export interface WorkspaceAccess {
  /** The worktree's root. Nothing outside it can be read or written. */
  root: string;
  /** Where relative paths start: the folder the chat is about, inside the worktree. */
  cwd: string;
  branch: string;
  baseCommit: string;
}

/** What a command returned. */
export interface CommandResult {
  /** The handle a clank uses for `shell_output` and `shell_stop`, such as `p2`. */
  handle: string;
  sessionId: string;
  output: string;
  running: boolean;
  exitCode: number | null;
  /** How it ended, once it has. */
  reason: 'exited' | 'timeout' | 'stopped' | 'error' | null;
}

/** Commands, run where the user can watch them in the terminal pane. */
export interface ShellAccess {
  /** `bash` or `cmd`, so the clank writes commands for the right shell. */
  name: string;
  exec(
    command: string,
    options: { timeoutMs: number; signal: AbortSignal },
  ): Promise<CommandResult>;
  start(command: string, options: { signal: AbortSignal }): Promise<CommandResult>;
  /** Output since the last read. Null for a handle it doesn't know. */
  output(handle: string): CommandResult | null;
  stop(handle: string): Promise<CommandResult | null>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebAccess {
  fetch: typeof fetch;
  /** Null when no search backend is set up. */
  search: ((query: string, count: number, signal: AbortSignal) => Promise<SearchResult[]>) | null;
}

/** A picture a tool took, such as the page after a browser step. */
export interface ToolImage {
  data: Uint8Array;
  mediaType: 'image/jpeg' | 'image/png';
}

/** A picture `browser_styles` listed on a page: where to get it, or the drawing itself. */
export interface ListedImage {
  kind: string;
  note: string;
  /** Its address, which may be a `data:` one. Null for a drawing that's part of the page. */
  url: string | null;
  /** The drawing as an SVG document, when it's part of the page. */
  svg: string | null;
}

/** What a browser step did, worded for the clank. */
export interface BrowserResult {
  content: string;
  error?: boolean;
  /** The page as it looked afterwards, for the user. */
  image?: ToolImage;
}

/**
 * The browser pane, for one clank in one chat. Every step happens in a tab the user can watch,
 * and waits while the user has taken over.
 */
export interface BrowserAccess {
  /** Opens a page in a new tab, which becomes the current one. */
  open(url: string): Promise<BrowserResult>;
  /** Goes to an address in the current tab, opening one if there's none. */
  navigate(url: string): Promise<BrowserResult>;
  /** The page as text with numbered refs, from a line on. */
  read(fromLine: number): Promise<BrowserResult>;
  click(ref: number): Promise<BrowserResult>;
  type(ref: number, text: string, submit: boolean): Promise<BrowserResult>;
  press(keys: string): Promise<BrowserResult>;
  scroll(direction: 'up' | 'down', ref: number | null): Promise<BrowserResult>;
  /** What's visible in the current tab, as a picture for a model that can see. */
  screenshot(): Promise<BrowserResult>;
  console(): Promise<BrowserResult>;
  back(): Promise<BrowserResult>;
  close(): Promise<BrowserResult>;
  /**
   * Searches the web in a tab. When the results can't be picked off the page, `page` has the page
   * as text instead.
   */
  search(query: string, count: number): Promise<{ results: SearchResult[]; page: string | null }>;
  /**
   * A page as text once its scripts have drawn it, for a page that is empty until they run. It's
   * read in the tab searches use, so it takes none of the clank's own.
   */
  text(url: string): Promise<string>;
  /** How the current page looks: its fonts, colours, buttons, logo and pictures. */
  styles(): Promise<BrowserResult>;
  /** A picture from the list `styles` last gave for the current page, by its number. */
  listed(index: number): Promise<ListedImage>;
}

/** What a design step did, worded for the clank. */
export interface DesignResult {
  content: string;
  error?: boolean;
  /** A frame as it's drawn, for the user and for a model that can see. */
  image?: ToolImage;
}

/** A token as `design_tokens_set` takes it. */
export interface TokenDraft {
  name: string;
  value: unknown;
  type?: string | undefined;
  /** Its value in other modes, by mode, such as `{ dark: "#111" }`. */
  modes?: Record<string, unknown> | undefined;
  description?: string | undefined;
}

/**
 * The project's design in Studio, as the run's worktree has it. Every change shows on the user's
 * canvas as it's made. Each method returns what the clank reads, or throws a `ToolFailure` saying
 * what's wrong. `file` picks a design file when the project has more than one.
 */
export interface DesignAccess {
  read(input: {
    file?: string | undefined;
    node?: string | undefined;
    depth?: number | undefined;
    /** The tokens instead of the layers: listed, or exported as CSS, a Tailwind theme or JSON. */
    tokens?: boolean | 'css' | 'tailwind' | 'json' | undefined;
    /** A component as a React component and its CSS, rather than as layers. */
    code?: boolean | undefined;
  }): Promise<string>;
  create(input: {
    file?: string | undefined;
    markup: string;
    /** A frame's id or name, or a page's name. Without one, the first page. */
    parent?: string | undefined;
    index?: number | undefined;
  }): Promise<string>;
  update(input: {
    file?: string | undefined;
    updates: {
      id: string;
      set: Record<string, unknown>;
      /** A frame or page to move it into. */
      parent?: string | undefined;
      index?: number | undefined;
    }[];
  }): Promise<string>;
  remove(input: { file?: string | undefined; ids: string[] }): Promise<string>;
  setTokens(input: { tokens: TokenDraft[]; remove: string[] }): Promise<string>;
  makeComponent(input: {
    file?: string | undefined;
    node: string;
    name: string;
    variant?: string | undefined;
  }): Promise<string>;
  link(input: { file?: string | undefined; from: string; to: string | null }): Promise<string>;
  render(input: {
    file?: string | undefined;
    frame: string;
    mode?: string | undefined;
  }): Promise<DesignResult>;
  lint(input: { file?: string | undefined; frame?: string | undefined }): Promise<string>;
}

/** A ticket as the board tools take it from a clank. */
export interface TicketDraft {
  title: string;
  type: string;
  description: string;
  stories: string[];
  criteria: string[];
  /** A clank's id, or null to leave it open. */
  assignee: string | null;
  /** Keys of tickets it waits on. */
  dependsOn: string[];
  /** Optional checks it doesn't need, with why. */
  skipChecks: { clank: string; reason: string }[];
}

/**
 * The board of the project a chat or run is in. Each method does what its tool says and returns
 * what the clank reads, or throws a `ToolFailure` saying what's wrong. The crew's finishing calls
 * work only in a ticket run.
 */
export interface BoardAccess {
  list(filter: { column?: string; assignee?: string; query?: string }): string;
  get(key: string): string;
  create(ticket: TicketDraft): string;
  update(input: {
    key: string;
    title?: string;
    description?: string;
    criteria?: string[];
    stories?: string[];
    skipChecks?: { clank: string; reason: string }[];
  }): string;
  link(input: { key: string; dependsOn: string; remove: boolean }): string;
  /** A clank's id, or null to make it open. */
  assign(input: { key: string; clank: string | null }): string;
  /** A version, the draft, or null for the one that fits the run. */
  readSpec(version: number | 'draft' | null): string;
  writeSpec(content: string): string;
  progress(input: { message: string; steps: { title: string; done: boolean }[] }): string;
  submit(output: Record<string, unknown> & { type: string }): string | Promise<string>;
  pass(review: Record<string, unknown>): string | Promise<string>;
  bounce(input: { to: string; reason: string; issues: string[] }): string | Promise<string>;
  fail(input: { reason: string; tried: string }): string;
  ask(input: { question: string; options: string[]; recommendation: string }): string;
}

/** A note as `context_write` takes it. */
export interface NoteDraft {
  kind: string;
  title: string;
  body: string;
  why: string;
  /** A note this replaces, by its reference or title. */
  supersedes: string | null;
  /** A note to take back instead, by its reference or title. */
  drop: string | null;
}

/**
 * The project's shared context and this clank's own memory of the project. Each method returns
 * what the clank reads, or throws a `ToolFailure` saying what's wrong.
 */
export interface ContextAccess {
  search(query: string): string;
  write(note: NoteDraft): string;
  /** Another clank's memory only for Atlas, about a ticket it's signing off. */
  searchMemory(query: string, clank: string | null): string;
  remember(input: { kind: 'decision' | 'note'; body: string }): string;
}

/**
 * What's saved with a ticket, or with a chat outside one, in the app's own folder. Each method
 * returns what the clank reads, or throws a `ToolFailure` saying what's wrong.
 */
export interface ArtifactAccess {
  save(input: { name: string; content: string }): string;
  /** The list of what's saved, or one file's text from a line on. */
  read(input: {
    name?: string | undefined;
    version?: number | undefined;
    fromLine: number;
  }): string;
}

/** The rest of the crew, for a quick question to one of them. */
export interface CrewAccess {
  /** Resolves with the other clank's answer, or throws a `ToolFailure` saying why there's none. */
  ask(input: { clank: string; question: string }): Promise<string>;
}

export interface ToolContext {
  workspace: WorkspaceAccess | null;
  shell: ShellAccess | null;
  web: WebAccess;
  /** Null when the chat has no browser, such as in tests or outside the app. */
  browser: BrowserAccess | null;
  /** The project's board, in a chat or run in a project. */
  board: BoardAccess | null;
  /** The project's context and the clank's memory, in a chat or run in a project. */
  context: ContextAccess | null;
  /** The design in the run's worktree. Null when the chat has no workspace. */
  design: DesignAccess | null;
  /** Notes and files saved with the ticket or chat. Missing outside the app. */
  artifacts?: ArtifactAccess | null;
  /** The crew, to ask one of them a question. Missing where there's nobody to ask. */
  crew?: CrewAccess | null;
  signal: AbortSignal;
  clank: { id: string; name: string };
  /** The most a result may hold, in characters, so it doesn't crowd out the conversation. */
  maxChars: number;
}

export interface ToolResult {
  /** What the model gets back. */
  content: string;
  /** The call failed. The model reads why in `content`. */
  error?: boolean;
  /** The terminal session a command ran in. */
  sessionId?: string;
  /** Everything it produced, for the activity log, when the model got less. */
  output?: string;
  /** A picture of what the tool saw, kept for the user. */
  image?: ToolImage;
  /** The model gets the picture too, when it can see. */
  showModel?: boolean;
  /** It handed the ticket on, so the run ends here, with no more turns for the model. */
  finish?: boolean;
}

/**
 * What a tool needs from the chat to be offered: a workspace, commands, a search backend (or the
 * browser to search in), the browser, the app to draw designs with, a model that can see pictures,
 * a project's board, a ticket run, a run as the ticket's maker or one of its checkers, or a crew
 * to put a question to.
 */
export type ToolNeed =
  | 'workspace'
  | 'shell'
  | 'search'
  | 'browser'
  | 'render'
  | 'vision'
  | 'project'
  | 'ticket'
  | 'maker'
  | 'checker'
  | 'crew';

/** A tool a clank can call. */
export interface ToolSpec<A = unknown> {
  name: string;
  /** For the model: what it does and when to use it. */
  description: string;
  /** The arguments, as a JSON schema for the model. */
  parameters: Record<string, unknown>;
  /** Checks the arguments the model wrote. Throws a `ToolArgumentsError` saying what's wrong. */
  parse(raw: unknown): A;
  needs: ToolNeed[];
  /** What it makes use of when the chat has it, without needing it to be offered. */
  uses?: ToolNeed[];
  /** It can change files, so a checkpoint follows it. */
  mutates: boolean;
  /** One line for the chat and the board, such as "Running `npm test`". */
  label(args: A): string;
  /** What an approval prompt shows, and what "always allow" would cover. */
  approval(args: A): Omit<ToolApproval, 'scope'>;
  /**
   * How risky this call is. A tool the clank's policy asks about asks only for high-risk calls,
   * unless the user wants to be asked about every one. A tool without this is always high risk.
   */
  risk?(args: A, ctx: RiskContext): Risk;
  /**
   * It asks every time, such as a call that spends money through a connected service: no "always
   * allow" rule, setting or policy lets one through without the user.
   */
  locked?: boolean;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

/** The model's arguments don't fit the tool. */
export class ToolArgumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentsError';
  }
}

/** A tool failed in a way the model should hear about, worded for it. */
export class ToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolFailure';
  }
}

/** A built-in tool, with its arguments described by a zod schema. */
export function defineTool<S extends z.ZodType>(
  spec: Omit<ToolSpec<z.infer<S>>, 'parameters' | 'parse'> & { schema: S },
): ToolSpec<z.infer<S>> {
  const { schema, ...rest } = spec;
  return {
    ...rest,
    parameters: jsonSchemaOf(schema),
    parse(raw) {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) throw new ToolArgumentsError(z.prettifyError(parsed.error));
      return parsed.data;
    },
  };
}

/** A JSON schema as model APIs take it: no `$schema`, and an object at the top. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

/** The tools as a model request lists them. */
export function definitionsOf(specs: ToolSpec[]): ToolDefinition[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
  }));
}

/** A command or URL cut short for a label. */
export function short(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
