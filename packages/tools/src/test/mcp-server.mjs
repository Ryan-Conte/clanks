// A tiny MCP server for tests, over stdio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fixture', version: '1.0.0' });

server.registerTool(
  'add',
  { description: 'Adds two numbers', inputSchema: { a: z.number(), b: z.number() } },
  ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
);

server.registerTool(
  'secret',
  { description: 'Says what FIXTURE_SECRET is', inputSchema: {} },
  () => ({ content: [{ type: 'text', text: process.env.FIXTURE_SECRET ?? 'none' }] }),
);

server.registerTool('fails', { description: 'Always fails', inputSchema: {} }, () => ({
  content: [{ type: 'text', text: 'It broke' }],
  isError: true,
}));

await server.connect(new StdioServerTransport());
