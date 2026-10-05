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
  artifacts: ['artifact_save'],
  routines: ['routine_list', 'routine_get', 'routine_propose'],
} as const;

export type ToolName = (typeof TOOL_GROUPS)[keyof typeof TOOL_GROUPS][number];

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

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
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
