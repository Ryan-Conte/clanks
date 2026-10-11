import { z } from 'zod';

/**
 * Every built-in tool, by group. Priming docs may only name these, and CI checks that they do.
 * Integration (`int_<integration>_<operation>`) and MCP (`mcp_<server>_<tool>`) tools are generated
 * at run time and aren't listed.
 */
export const TOOL_GROUPS = {
  files: ['fs_read', 'fs_list', 'fs_search', 'fs_write', 'fs_edit'],
  shell: ['shell_exec', 'shell_start', 'shell_output', 'shell_stop'],
  git: ['git_status', 'git_diff', 'git_log', 'git_commit'],
  web: ['web_search', 'web_fetch'],
  browser: [
    'browser_open',
    'browser_navigate',
    'browser_read',
    'browser_click',
    'browser_type',
    'browser_press',
    'browser_scroll',
    'browser_screenshot',
    'browser_styles',
    'browser_save_image',
    'browser_console',
    'browser_back',
    'browser_close',
  ],
  design: [
    'design_read',
    'design_create',
    'design_update',
    'design_delete',
    'design_tokens_set',
    'design_make_component',
    'design_link',
    'design_render',
    'design_lint',
  ],
  board: [
    'board_list',
    'board_get_ticket',
    'board_create_ticket',
    'board_update_ticket',
    'board_link_dependency',
    'board_assign',
  ],
  spec: ['spec_read', 'spec_write'],
  review: ['review_pass'],
  crew: ['post_progress', 'ask_clank', 'ask_user', 'submit_output', 'fail', 'ticket_bounce'],
  context: ['context_search', 'context_write', 'memory_search', 'memory_write'],
  artifacts: ['artifact_save', 'artifact_read'],
  routines: ['routine_list', 'routine_get', 'routine_propose'],
} as const;

export type ToolGroup = keyof typeof TOOL_GROUPS;

export type ToolName = (typeof TOOL_GROUPS)[ToolGroup][number];

export const TOOL_NAMES: readonly ToolName[] = Object.values(TOOL_GROUPS).flat();

/** Every clank has these, so priming docs never list them. */
export const ALWAYS_AVAILABLE_TOOLS: readonly ToolName[] = [
  'post_progress',
  'ask_user',
  'ask_clank',
  'submit_output',
  'fail',
  'ticket_bounce',
  'context_search',
  'context_write',
  'memory_search',
  'memory_write',
];

/**
 * Tools that only look, and change nothing. A clank installed from a marketplace starts with these
 * as its doc says; anything else its doc allows starts at ask.
 */
export const READ_ONLY_TOOLS: readonly ToolName[] = [
  'fs_read',
  'fs_list',
  'fs_search',
  'git_status',
  'git_diff',
  'git_log',
  'shell_output',
  'shell_stop',
  'browser_read',
  'browser_screenshot',
  'browser_styles',
  'browser_console',
  'design_read',
  'design_render',
  'design_lint',
  'board_list',
  'board_get_ticket',
  'spec_read',
  'artifact_read',
  'routine_list',
  'routine_get',
  // A checker's own verdict: it changes the ticket, which is what the clank is for.
  'review_pass',
];

export function isReadOnlyTool(name: string): boolean {
  return (
    (READ_ONLY_TOOLS as readonly string[]).includes(name) ||
    (ALWAYS_AVAILABLE_TOOLS as readonly string[]).includes(name)
  );
}

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** The group a built-in tool belongs to. */
export function toolGroupOf(name: string): ToolGroup | null {
  for (const [group, names] of Object.entries(TOOL_GROUPS)) {
    if ((names as readonly string[]).includes(name)) return group as ToolGroup;
  }
  return null;
}

/**
 * The tools a policy entry covers: an exact name, or a group with a `*` suffix such as `browser_*`.
 * Empty when the entry names nothing real.
 */
export function toolsMatching(entry: string): ToolName[] {
  if (entry.endsWith('*')) {
    const prefix = entry.slice(0, -1);
    if (!/^[a-z]+_$/.test(prefix)) return [];
    return TOOL_NAMES.filter((name) => name.startsWith(prefix));
  }
  return isToolName(entry) ? [entry] : [];
}

/**
 * What happens when a clank calls a tool: it runs, it waits for the user's approval, or it's
 * refused. `off` tools aren't offered to the clank at all.
 */
export const toolPolicyLevelSchema = z.enum(['allow', 'ask', 'deny', 'off']);

export type ToolPolicyLevel = z.infer<typeof toolPolicyLevelSchema>;

/** A tool's name: a built-in one, or a generated `mcp_<server>_<tool>` or `int_<integration>_<operation>`. */
export const toolNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'Use a tool name such as fs_read');

/** The user's policy for one clank's tools, which wins over its priming doc. */
export const toolOverridesSchema = z.record(toolNameSchema, toolPolicyLevelSchema);

export type ToolOverrides = z.infer<typeof toolOverridesSchema>;

/** A tool as a clank's profile shows it. */
export interface ClankToolPolicy {
  name: string;
  /** A built-in group, `mcp` for a tool from an MCP server, or `integration` for a service's. */
  group: ToolGroup | 'mcp' | 'integration';
  description: string;
  /** What actually applies: the user's choice if they made one, else the doc's. */
  level: ToolPolicyLevel;
  /** What the priming doc says, or `ask` for an attached MCP server's tools. */
  defaultLevel: ToolPolicyLevel;
  overridden: boolean;
  /** Tools clanks can use already; the rest arrive in later milestones. */
  available: boolean;
  /** It asks every time, whatever is set here: it can only be denied or turned off. */
  locked?: boolean;
}

/**
 * An "always allow" the user gave from an approval prompt, for one project. Until projects arrive,
 * a project is the git repository a chat works in.
 */
export interface ToolRule {
  id: string;
  scope: string;
  tool: string;
  /** The command, URL or path it covers. `*` matches anything, including nothing. */
  pattern: string;
  createdAt: Date;
}

export const toolRulePatternSchema = z.string().trim().min(1).max(2000);

/** Whether a rule's pattern covers a command, URL or path. Only `*` is special. */
export function matchesPattern(pattern: string, subject: string): boolean {
  const parts = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('[\\s\\S]*')}$`).test(subject);
}
