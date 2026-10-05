import { type McpServerInput, type McpServerStatus, mcpServerInputSchema } from '@clanks/core';
import { type McpManager, type McpServerConfig, mcpSlug } from '@clanks/tools';
import { asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { SecretStore } from '../secrets';
import { mcpServer } from '../store/schema';
import type { Db } from '../store/store';

/** An MCP server problem worded for the user. */
export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

type Row = typeof mcpServer.$inferSelect;

const secretRef = (id: string) => `mcp:${id}`;

/**
 * The MCP servers the user added, and which clanks each is attached to. Emits `change` when the
 * list or a server's state changes.
 */
export class McpService extends EventEmitter<{ change: [] }> {
  constructor(private readonly options: { db: Db; secrets: SecretStore; manager: McpManager }) {
    super();
    options.manager.on('change', () => this.emit('change'));
  }

  list(): McpServerStatus[] {
    return this.rows().map((row) => this.status(row));
  }

  add(input: McpServerInput): McpServerStatus {
    const parsed = this.parse(input);
    const id = randomUUID();
    this.saveSecrets(id, parsed.secrets ?? {});
    const row: Row = {
      id,
      name: parsed.name,
      slug: this.uniqueSlug(parsed.name),
      transport: parsed.transport,
      command: parsed.command,
      args: parsed.args,
      url: parsed.url,
      secretNames: Object.keys(parsed.secrets ?? {}),
      clanks: parsed.clanks,
      createdAt: new Date(),
    };
    this.options.db.insert(mcpServer).values(row).run();
    this.emit('change');
    return this.status(row);
  }

  /** Changes a server. It restarts with the new settings the next time it's used. */
  async update(id: string, input: McpServerInput): Promise<McpServerStatus> {
    const current = this.require(id);
    const parsed = this.parse(input);
    if (parsed.secrets !== null) this.saveSecrets(id, parsed.secrets);
    const next: Row = {
      ...current,
      name: parsed.name,
      slug: parsed.name === current.name ? current.slug : this.uniqueSlug(parsed.name, id),
      transport: parsed.transport,
      command: parsed.command,
      args: parsed.args,
      url: parsed.url,
      secretNames: parsed.secrets !== null ? Object.keys(parsed.secrets) : current.secretNames,
      clanks: parsed.clanks,
    };
    this.options.db.update(mcpServer).set(next).where(eq(mcpServer.id, id)).run();
    await this.options.manager.disconnect(id);
    this.emit('change');
    return this.status(next);
  }

  async remove(id: string): Promise<void> {
    this.require(id);
    await this.options.manager.disconnect(id);
    this.options.db.delete(mcpServer).where(eq(mcpServer.id, id)).run();
    this.options.secrets.delete(secretRef(id));
    this.emit('change');
  }

  /** Starts a server, or asks a running one again, for its tools. */
  async test(id: string): Promise<McpServerStatus> {
    const row = this.require(id);
    await this.options.manager.disconnect(id);
    await this.options.manager.tools(this.config(row)).catch(() => {});
    return this.status(row);
  }

  /** The servers a clank's tools come from, ready to connect to. */
  forClank(clankId: string): McpServerConfig[] {
    return this.rows()
      .filter((row) => row.clanks.includes(clankId))
      .map((row) => this.config(row));
  }

  private config(row: Row): McpServerConfig {
    let secrets: Record<string, string> = {};
    const stored = this.options.secrets.get(secretRef(row.id));
    if (stored) {
      try {
        secrets = JSON.parse(stored) as Record<string, string>;
      } catch {
        // Unreadable: the server starts without them and says what's missing.
      }
    }
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      transport: row.transport,
      command: row.command,
      args: row.args,
      url: row.url,
      secrets,
    };
  }

  private status(row: Row): McpServerStatus {
    const state = this.options.manager.status(row.id);
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      transport: row.transport,
      command: row.command,
      args: row.args,
      url: row.url,
      secretNames: row.secretNames,
      clanks: row.clanks,
      state: state.state,
      error: state.error,
      tools: state.tools.map(({ name, fullName, description }) => ({
        name,
        fullName,
        description,
      })),
    };
  }

  private parse(input: McpServerInput) {
    const parsed = mcpServerInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new McpError(parsed.error.issues.map((issue) => issue.message).join('. '));
    }
    return parsed.data;
  }

  private saveSecrets(id: string, secrets: Record<string, string>): void {
    if (Object.keys(secrets).length === 0) this.options.secrets.delete(secretRef(id));
    else this.options.secrets.set(secretRef(id), JSON.stringify(secrets));
  }

  /** A slug no other server has, so tool names never clash. */
  private uniqueSlug(name: string, except?: string): string {
    const taken = new Set(
      this.rows()
        .filter((r) => r.id !== except)
        .map((r) => r.slug),
    );
    const base = mcpSlug(name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base.slice(0, 14)}${n}`;
    return slug;
  }

  private rows(): Row[] {
    return this.options.db.select().from(mcpServer).orderBy(asc(mcpServer.createdAt)).all();
  }

  private require(id: string): Row {
    const row = this.options.db.select().from(mcpServer).where(eq(mcpServer.id, id)).get();
    if (!row) throw new McpError("That MCP server isn't there any more");
    return row;
  }
}
