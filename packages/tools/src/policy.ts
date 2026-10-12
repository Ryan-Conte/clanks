import {
  ALWAYS_AVAILABLE_TOOLS,
  type ClankFrontmatter,
  type ToolOverrides,
  type ToolPolicyLevel,
  isReadOnlyTool,
} from '@clanks/core';

type DocPolicy = ClankFrontmatter['tools'];

/**
 * What a priming doc says about a tool. An entry naming the tool beats a group entry such as
 * `browser_*`; between entries alike, deny beats ask beats allow. Unlisted tools are off, except
 * the crew's own, which every clank has.
 */
export function docLevel(policy: DocPolicy, name: string): ToolPolicyLevel {
  const exact = (entries: string[]) => entries.includes(name);
  const group = (entries: string[]) =>
    entries.some((entry) => entry.endsWith('*') && name.startsWith(entry.slice(0, -1)));
  for (const matches of [exact, group]) {
    if (matches(policy.deny)) return 'deny';
    if (matches(policy.ask)) return 'ask';
    if (matches(policy.allow)) return 'allow';
  }
  return (ALWAYS_AVAILABLE_TOOLS as readonly string[]).includes(name) ? 'allow' : 'off';
}

export interface PolicyDecision {
  level: ToolPolicyLevel;
  defaultLevel: ToolPolicyLevel;
  overridden: boolean;
}

/**
 * A clank's policy for one tool: the user's, if they set one, over the doc's. An MCP server's
 * tools start at ask for the clanks it's attached to, since they can do anything. A clank from a
 * marketplace is `capped`: whatever its doc allows, nothing above read starts higher than ask, so
 * a package can't give itself permissions. The user can still raise them.
 */
export function policyFor(options: {
  doc: DocPolicy;
  overrides: ToolOverrides;
  name: string;
  mcp?: boolean;
  capped?: boolean;
}): PolicyDecision {
  const fromDoc = options.mcp ? 'ask' : docLevel(options.doc, options.name);
  const defaultLevel =
    options.capped && fromDoc === 'allow' && !isReadOnlyTool(options.name) ? 'ask' : fromDoc;
  const override = options.overrides[options.name];
  return {
    level: override ?? defaultLevel,
    defaultLevel,
    overridden: override !== undefined && override !== defaultLevel,
  };
}
