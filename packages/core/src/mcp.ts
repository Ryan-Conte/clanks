import { z } from 'zod';
import { clankIdSchema } from './crew';

const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use a variable name like API_KEY');
const headerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]+$/, 'Use a header name like Authorization');

/**
 * An MCP server the user added: a command clanks starts, or an address it calls. Its tools reach
 * the clanks it's attached to as `mcp_<server>_<tool>`.
 */
export const mcpServerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    transport: z.enum(['stdio', 'http']),
    /** stdio: the program to run, such as `npx`. */
    command: z.string().trim().max(1000).default(''),
    args: z.array(z.string().max(2000)).max(50).default([]),
    /** http: the server's address. */
    url: z.string().trim().max(2000).default(''),
    /**
     * stdio: environment variables, http: request headers. Kept in the keychain, since they often
     * hold keys. Null keeps the ones saved before.
     */
    secrets: z.record(z.string(), z.string().max(8192)).nullable().default(null),
    clanks: z.array(clankIdSchema).max(64).default([]),
  })
  .superRefine((server, ctx) => {
    if (server.transport === 'stdio' && !server.command) {
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'Say which command starts it' });
    }
    if (server.transport === 'http' && !/^https?:\/\/\S+$/i.test(server.url)) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'Use an http:// or https:// address',
      });
    }
    for (const key of Object.keys(server.secrets ?? {})) {
      const name = server.transport === 'stdio' ? envNameSchema : headerNameSchema;
      if (!name.safeParse(key).success) {
        ctx.addIssue({
          code: 'custom',
          path: ['secrets', key],
          message: `${key} isn't a valid name`,
        });
      }
    }
  });

export type McpServerInput = z.input<typeof mcpServerInputSchema>;

export interface McpToolInfo {
  /** As the server names it. */
  name: string;
  /** As clanks see it: `mcp_<server>_<tool>`. */
  fullName: string;
  description: string;
}

export interface McpServerStatus {
  id: string;
  name: string;
  /** The part of its tools' names that says where they're from. */
  slug: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  /** The names of its environment variables or headers. The values stay in the keychain. */
  secretNames: string[];
  clanks: string[];
  /**
   * The integration it was installed as. Its command is pinned to one version of one package, so
   * it's changed by updating the integration, not by editing it here.
   */
  integration: string | null;
  /** It runs in a Docker container rather than on this computer. */
  docker: boolean;
  state: 'idle' | 'connecting' | 'ready' | 'failed';
  error: string | null;
  tools: McpToolInfo[];
}
