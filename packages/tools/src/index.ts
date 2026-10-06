import { BOARD_TOOLS, CREW_TOOLS } from './board';
import { BROWSER_TOOLS } from './browser';
import { FILE_TOOLS } from './files';
import { GIT_TOOLS } from './git';
import { SHELL_TOOLS } from './shell';
import type { ToolSpec } from './spec';
import { WEB_TOOLS } from './web';

export * from './board';
export * from './browser';
export * from './files';
export * from './git';
export * from './mcp';
export * from './policy';
export * from './redact';
export * from './shell';
export * from './spec';
export * from './web';

/** The built-in tools clanks can use so far. The rest of the registry arrives with later milestones. */
export const BUILTIN_TOOLS: ToolSpec[] = [
  ...FILE_TOOLS,
  ...SHELL_TOOLS,
  ...GIT_TOOLS,
  ...WEB_TOOLS,
  ...BROWSER_TOOLS,
  ...BOARD_TOOLS,
  ...CREW_TOOLS,
] as ToolSpec[];

export function builtinTool(name: string): ToolSpec | undefined {
  return BUILTIN_TOOLS.find((tool) => tool.name === name);
}
