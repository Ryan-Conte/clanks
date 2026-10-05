import type { ToolApproval, ToolDefinition } from '@clanks/core';
import { z } from 'zod';

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
}

export interface ToolContext {
  workspace: WorkspaceAccess | null;
  shell: ShellAccess | null;
  web: WebAccess;
  /** Null when the chat has no browser, such as in tests or outside the app. */
  browser: BrowserAccess | null;
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
}

/**
 * What a tool needs from the chat to be offered: a workspace, commands, a search backend (or the
 * browser to search in), the browser, or a model that can see pictures.
 */
export type ToolNeed = 'workspace' | 'shell' | 'search' | 'browser' | 'vision';

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
  /** It can change files, so a checkpoint follows it. */
  mutates: boolean;
  /** One line for the chat and the board, such as "Running `npm test`". */
  label(args: A): string;
  /** What an approval prompt shows, and what "always allow" would cover. */
  approval(args: A): Omit<ToolApproval, 'scope'>;
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
