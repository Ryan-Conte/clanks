import type { McpToolInfo } from '@clanks/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EventEmitter } from 'node:events';
import { short } from './spec';
import { type ToolSpec, ToolArgumentsError, ToolFailure } from './spec';

const CONNECT_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 5 * 60_000;

/** An MCP server as the manager connects to it. Secrets are already read from the keychain. */
export interface McpServerConfig {
  id: string;
  name: string;
  slug: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  /** Environment variables for stdio, headers for http. */
  secrets: Record<string, string>;
}

export interface McpTool extends McpToolInfo {
  inputSchema: Record<string, unknown>;
}

interface Connection {
  key: string;
  state: 'connecting' | 'ready' | 'failed';
  error: string | null;
  client: Client | null;
  tools: McpTool[];
  ready: Promise<void>;
  /** The last lines the server wrote to stderr, which usually say why it failed. */
  stderr: string;
}

/** The part of a tool's name that says which server it's from. */
export function mcpSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 16);
  return slug || 'server';
}

/** `mcp_<server>_<tool>`, in the characters every model API accepts, at most 64 of them. */
export function mcpToolName(slug: string, tool: string): string {
  const cleaned = tool
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `mcp_${slug}_${cleaned || 'tool'}`.slice(0, 64);
}

/**
 * Connections to the MCP servers the user added. A server starts when a clank it's attached to
 * first needs its tools, and keeps running until it's changed, removed or the app quits.
 * Emits `change` with a server's id when its state changes.
 */
export class McpManager extends EventEmitter<{ change: [id: string] }> {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly clientInfo: { name: string; version: string }) {
    super();
  }

  status(id: string): {
    state: 'idle' | Connection['state'];
    error: string | null;
    tools: McpTool[];
  } {
    const connection = this.connections.get(id);
    if (!connection) return { state: 'idle', error: null, tools: [] };
    return { state: connection.state, error: connection.error, tools: connection.tools };
  }

  /** The server's tools, connecting first if it isn't. Throws if it can't connect. */
  async tools(config: McpServerConfig): Promise<McpTool[]> {
    const connection = this.connect(config);
    await connection.ready;
    if (connection.state !== 'ready') throw new ToolFailure(connection.error ?? 'It failed');
    return connection.tools;
  }

  /** Calls one of a server's tools. */
  async call(
    config: McpServerConfig,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ content: string; isError: boolean }> {
    const connection = this.connect(config);
    await connection.ready;
    if (connection.state !== 'ready' || !connection.client) {
      throw new ToolFailure(
        `${config.name} isn't running: ${connection.error ?? 'it failed to start'}`,
      );
    }
    const result = await connection.client.callTool({ name: tool, arguments: args }, undefined, {
      signal,
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    });
    return { content: contentText(result), isError: result.isError === true };
  }

  /** Stops a server, so the next use starts it with its current settings. */
  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id);
    this.connections.delete(id);
    if (connection) {
      await connection.client?.close().catch(() => {});
      this.emit('change', id);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  private connect(config: McpServerConfig): Connection {
    const key = JSON.stringify(config);
    const existing = this.connections.get(config.id);
    // A failed server is tried again on the next use: it may have been fixed meanwhile.
    if (existing && existing.key === key && existing.state !== 'failed') return existing;
    if (existing) void existing.client?.close().catch(() => {});

    const connection: Connection = {
      key,
      state: 'connecting',
      error: null,
      client: null,
      tools: [],
      ready: Promise.resolve(),
      stderr: '',
    };
    this.connections.set(config.id, connection);
    this.emit('change', config.id);
    connection.ready = this.open(config, connection)
      .then(
        () => {
          connection.state = 'ready';
        },
        (error: unknown) => {
          connection.state = 'failed';
          const detail = connection.stderr.trim().split('\n').slice(-3).join(' ').trim();
          connection.error = `${(error as Error).message ?? String(error)}${detail ? ` (${short(detail, 300)})` : ''}`;
          void connection.client?.close().catch(() => {});
          connection.client = null;
        },
      )
      .finally(() => {
        if (this.connections.get(config.id) === connection) this.emit('change', config.id);
      });
    return connection;
  }

  private async open(config: McpServerConfig, connection: Connection): Promise<void> {
    const client = new Client(this.clientInfo, { capabilities: {} });
    connection.client = client;
    if (config.transport === 'stdio') {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.secrets,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk: Buffer) => {
        connection.stderr = (connection.stderr + chunk.toString('utf8')).slice(-4000);
      });
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.secrets },
      });
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    }
    const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
    connection.tools = listed.tools.map((tool) => ({
      name: tool.name,
      fullName: mcpToolName(config.slug, tool.name),
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }));
  }
}

/** A tool result's content as text for the model. */
function contentText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const parts: string[] = [];
  const content = Array.isArray(result.content)
    ? (result.content as Record<string, unknown>[])
    : [];
  for (const item of content) {
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'image' || item.type === 'audio')
      parts.push(`[${String(item.type)}: ${String(item.mimeType)}]`);
    else if (item.type === 'resource') {
      const resource = item.resource as { text?: string; uri?: string } | undefined;
      parts.push(resource?.text ?? `[resource ${resource?.uri ?? ''}]`);
    } else if (item.type === 'resource_link') {
      const name = typeof item.name === 'string' ? item.name : '';
      const uri = typeof item.uri === 'string' ? item.uri : '';
      parts.push(`[${name} ${uri}]`);
    }
  }
  if (parts.length === 0 && result.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return parts.join('\n\n') || '(no content)';
}

/** One of an MCP server's tools, as a tool clanks can call. */
export function mcpToolSpec(
  manager: McpManager,
  config: McpServerConfig,
  tool: McpTool,
): ToolSpec<Record<string, unknown>> {
  return {
    name: tool.fullName,
    description: `${tool.description || tool.name} (from the MCP server ${config.name})`.slice(
      0,
      1024,
    ),
    parameters: { type: 'object', ...tool.inputSchema },
    parse(raw) {
      if (raw === undefined || raw === null) return {};
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ToolArgumentsError('The arguments must be a JSON object');
      }
      return raw as Record<string, unknown>;
    },
    needs: [],
    // A server can do anything, files included.
    mutates: true,
    label: () => `Using ${config.name}: ${tool.name}`,
    approval: (args) => ({
      kind: 'tool',
      subject: `${config.name} › ${tool.name} ${short(JSON.stringify(args), 200)}`,
      pattern: '*',
    }),
    async run(args, ctx) {
      const result = await manager.call(config, tool.name, args, ctx.signal);
      return { content: result.content, error: result.isError };
    },
  };
}
