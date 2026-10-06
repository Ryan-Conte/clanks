import {
  type ClankToolPolicy,
  type RunRole,
  TOOL_GROUPS,
  type ToolDefinition,
  type ToolGroup,
  type ToolPolicyLevel,
  type ToolRule,
  matchesPattern,
  toolGroupOf,
} from '@clanks/core';
import {
  BUILTIN_TOOLS,
  type McpManager,
  type ToolNeed,
  type ToolSpec,
  type WebAccess,
  builtinTool,
  definitionsOf,
  mcpToolSpec,
  policyFor,
  searchWith,
} from '@clanks/tools';
import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Clank, CrewService } from '../crew/crew';
import type { McpService } from '../mcp/service';
import type { SecretStore } from '../secrets';
import type { SettingsService } from '../settings';
import { toolRule } from '../store/schema';
import type { Db } from '../store/store';

/** Keychain entries for the search backends that take a key. */
export const SEARCH_KEYS = { brave: 'search:brave', tavily: 'search:tavily' } as const;

/** The tools a clank has in one chat, ready to offer to the model. */
export interface Toolset {
  specs: Map<string, ToolSpec>;
  levels: Map<string, ToolPolicyLevel>;
  definitions: ToolDefinition[];
  /** MCP servers that couldn't start, so the clank can be told they're missing. */
  problems: string[];
}

export interface ToolServiceOptions {
  db: Db;
  crew: CrewService;
  mcp: McpService;
  manager: McpManager;
  settings: SettingsService;
  secrets: SecretStore;
  fetch?: typeof fetch;
}

/**
 * Which tools each clank can use and how: its policy, the user's "always allow" rules per project,
 * and the MCP servers attached to it. Emits `change` when rules change.
 */
export class ToolService extends EventEmitter<{ change: [] }> {
  constructor(private readonly options: ToolServiceOptions) {
    super();
  }

  /**
   * The tools a clank gets in a chat: those its policy doesn't turn off, that this chat can
   * support. Files, commands and git need a workspace; search needs a backend or the browser;
   * the browser needs the app; screenshots need a model that can see them. Board and spec tools
   * need a project, and the crew's finishing calls a run on a ticket.
   */
  async forChat(
    clank: Clank,
    chat: {
      workspace: boolean;
      browser?: boolean;
      vision?: boolean;
      project?: boolean;
      /** What the clank does in a run. Null or missing for a chat. */
      role?: RunRole | null;
    },
  ): Promise<Toolset> {
    const specs = new Map<string, ToolSpec>();
    const levels = new Map<string, ToolPolicyLevel>();
    const problems: string[] = [];
    const has: Record<ToolNeed, boolean> = {
      workspace: chat.workspace,
      shell: chat.workspace,
      search: (chat.browser ?? false) || this.searchConfigured(),
      browser: chat.browser ?? false,
      vision: chat.vision ?? false,
      project: chat.project ?? false,
      ticket: chat.role === 'maker' || chat.role === 'checker',
      maker: chat.role === 'maker',
      checker: chat.role === 'checker',
    };
    for (const spec of BUILTIN_TOOLS) {
      const { level } = policyFor({
        doc: clank.frontmatter.tools,
        overrides: clank.overrides.tools,
        name: spec.name,
      });
      if (level === 'off') continue;
      if (!spec.needs.every((need) => has[need])) continue;
      specs.set(spec.name, spec);
      levels.set(spec.name, level);
    }
    for (const config of this.options.mcp.forClank(clank.id)) {
      try {
        for (const tool of await this.options.manager.tools(config)) {
          const { level } = policyFor({
            doc: clank.frontmatter.tools,
            overrides: clank.overrides.tools,
            name: tool.fullName,
            mcp: true,
          });
          if (level === 'off' || specs.has(tool.fullName)) continue;
          specs.set(tool.fullName, mcpToolSpec(this.options.manager, config, tool));
          levels.set(tool.fullName, level);
        }
      } catch (error) {
        problems.push(`${config.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { specs, levels, definitions: definitionsOf([...specs.values()]), problems };
  }

  /** Every tool on a clank's profile, with what applies. */
  policies(clankId: string): ClankToolPolicy[] {
    const clank = this.options.crew.get(clankId);
    const policies: ClankToolPolicy[] = [];
    for (const [group, names] of Object.entries(TOOL_GROUPS) as [ToolGroup, readonly string[]][]) {
      for (const name of names) {
        const spec = builtinTool(name);
        const decision = policyFor({
          doc: clank.frontmatter.tools,
          overrides: clank.overrides.tools,
          name,
        });
        // Tools from later milestones are listed only when the doc already gives them.
        if (!spec && decision.defaultLevel === 'off') continue;
        policies.push({
          name,
          group,
          description: spec?.description ?? '',
          ...decision,
          available: spec !== undefined,
        });
      }
    }
    for (const config of this.options.mcp.forClank(clankId)) {
      for (const tool of this.options.manager.status(config.id).tools) {
        const decision = policyFor({
          doc: clank.frontmatter.tools,
          overrides: clank.overrides.tools,
          name: tool.fullName,
          mcp: true,
        });
        policies.push({
          name: tool.fullName,
          group: 'mcp',
          description: `${config.name}: ${tool.description || tool.name}`,
          ...decision,
          available: true,
        });
      }
    }
    return policies;
  }

  /** Sets a clank's policy for a tool. Null goes back to what its doc says. */
  setPolicy(clankId: string, tool: string, level: ToolPolicyLevel | null): void {
    const clank = this.options.crew.get(clankId);
    const tools = { ...clank.overrides.tools };
    const isMcp = !toolGroupOf(tool);
    const defaultLevel = policyFor({
      doc: clank.frontmatter.tools,
      overrides: {},
      name: tool,
      mcp: isMcp,
    }).level;
    if (level === null || level === defaultLevel) delete tools[tool];
    else tools[tool] = level;
    this.options.crew.updateProfile(clank.id, { tools });
  }

  rules(scope?: string): ToolRule[] {
    const query = this.options.db.select().from(toolRule);
    return (scope ? query.where(eq(toolRule.scope, scope)) : query)
      .orderBy(asc(toolRule.createdAt))
      .all();
  }

  /** "Always allow" `tool` for anything matching `pattern` in a project. */
  addRule(scope: string, tool: string, pattern: string): ToolRule {
    const existing = this.options.db
      .select()
      .from(toolRule)
      .where(and(eq(toolRule.scope, scope), eq(toolRule.tool, tool), eq(toolRule.pattern, pattern)))
      .get();
    if (existing) return existing;
    const rule: ToolRule = { id: randomUUID(), scope, tool, pattern, createdAt: new Date() };
    this.options.db.insert(toolRule).values(rule).run();
    this.emit('change');
    return rule;
  }

  deleteRule(id: string): void {
    this.options.db.delete(toolRule).where(eq(toolRule.id, id)).run();
    this.emit('change');
  }

  /** The rule that lets a call through without asking, if there is one. */
  ruleFor(scope: string, tool: string, subject: string): ToolRule | undefined {
    return this.rules(scope).find(
      (rule) => rule.tool === tool && matchesPattern(rule.pattern, subject),
    );
  }

  /** How clanks reach the web: plain fetch, and search through the backend in Settings. */
  web(): WebAccess {
    const doFetch = this.options.fetch ?? fetch;
    const { webSearch, searxngUrl } = this.options.settings.get();
    let search: WebAccess['search'] = null;
    if (webSearch === 'searxng' && searxngUrl) {
      search = searchWith({ kind: 'searxng', url: searxngUrl }, doFetch);
    } else if (webSearch === 'brave' || webSearch === 'tavily') {
      const key = this.options.secrets.get(SEARCH_KEYS[webSearch]);
      if (key) search = searchWith({ kind: webSearch, key }, doFetch);
    }
    return { fetch: doFetch, search };
  }

  private searchConfigured(): boolean {
    return this.web().search !== null;
  }
}
