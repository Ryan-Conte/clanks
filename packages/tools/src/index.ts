import { ARTIFACT_TOOLS, ASK_TOOLS } from './artifacts';
import { BOARD_TOOLS, CREW_TOOLS } from './board';
import { BROWSER_TOOLS } from './browser';
import { CONTEXT_TOOLS } from './context';
import { DESIGN_TOOLS } from './design';
import { FILE_TOOLS } from './files';
import { GIT_TOOLS } from './git';
import { ROUTINE_TOOLS } from './routines';
import { SHELL_TOOLS } from './shell';
import type { ToolSpec } from './spec';
import { WEB_TOOLS } from './web';

export * from './artifacts';
export * from './board';
export * from './browser';
export * from './context';
export * from './design';
export * from './files';
export * from './git';
export * from './mcp';
export * from './policy';
export * from './redact';
export * from './risk';
export * from './routines';
export * from './shell';
export * from './spec';
export * from './web';

/** The built-in tools clanks can use. */
export const BUILTIN_TOOLS: ToolSpec[] = [
  ...FILE_TOOLS,
  ...SHELL_TOOLS,
  ...GIT_TOOLS,
  ...WEB_TOOLS,
  ...BROWSER_TOOLS,
  ...DESIGN_TOOLS,
  ...BOARD_TOOLS,
  ...CREW_TOOLS,
  ...ASK_TOOLS,
  ...CONTEXT_TOOLS,
  ...ARTIFACT_TOOLS,
  ...ROUTINE_TOOLS,
] as ToolSpec[];

export function builtinTool(name: string): ToolSpec | undefined {
  return BUILTIN_TOOLS.find((tool) => tool.name === name);
}
