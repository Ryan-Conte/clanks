import { z } from 'zod';

/**
 * An integration's id. It's part of every tool name it gives (`int_<integration>_<operation>`), so
 * it keeps to the characters model APIs take.
 */
export const integrationIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,23}$/, 'Use lowercase letters, digits and "_", starting with a letter');

/** One operation's id within its integration. */
export const operationIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,34}$/, 'Use lowercase letters, digits and "_", starting with a letter');

/**
 * What an operation does to the service: `read` only looks, `write` changes something there, and
 * `outbound` spends money, publishes, contacts people or deletes.
 */
export const operationRiskSchema = z.enum(['read', 'write', 'outbound']);

export type OperationRisk = z.infer<typeof operationRiskSchema>;

/** Whether a connection's credential is for a sandbox or for the real account. */
export const connectionModeSchema = z.enum(['test', 'live']);

export type ConnectionMode = z.infer<typeof connectionModeSchema>;

export const MODE_NAMES: Record<ConnectionMode, string> = { test: 'Test', live: 'Live' };

/** `int_<integration>_<operation>`: the tool an operation becomes. */
export function integrationToolName(integration: string, operation: string): string {
  return `int_${integration}_${operation}`;
}

export function isIntegrationTool(name: string): boolean {
  return name.startsWith('int_');
}

/**
 * The risk that applies to a call. In test mode an operation may be gentler than its usual, such as
 * a charge that moves no money; in live mode every change counts as outbound.
 */
export function effectiveRisk(
  operation: { risk: OperationRisk; test?: OperationRisk | undefined },
  mode: ConnectionMode,
): OperationRisk {
  if (mode === 'test') return operation.test ?? operation.risk;
  return operation.risk === 'read' ? 'read' : 'outbound';
}

/** How an integration signs its requests. */
export type IntegrationAuthType = 'api_key' | 'basic' | 'oauth2' | 'none';

/** Something the user fills in when connecting that isn't a secret, such as a shop's name. */
export interface IntegrationSetting {
  id: string;
  label: string;
  hint: string;
  placeholder: string;
}

export interface IntegrationOperationInfo {
  id: string;
  /** The tool clanks call. */
  tool: string;
  summary: string;
  /** `GET /v1/products`, or the calls a sequence makes, in order. */
  calls: string[];
  risk: OperationRisk;
  /** Its risk on a test-mode connection. */
  testRisk: OperationRisk;
}

/** An account the user connected to an integration. The credential itself is in the keychain. */
export interface ConnectionInfo {
  id: string;
  integrationId: string;
  /** What the user calls it, such as "Surf shop (test)". */
  label: string;
  mode: ConnectionMode;
  authType: IntegrationAuthType;
  /** Who it's connected as, when the service says. */
  account: string | null;
  settings: Record<string, string>;
  connectedAt: Date;
  /** When an OAuth token runs out, if it does and can't be renewed. */
  expiresAt: Date | null;
  /**
   * Hosts the integration calls now that it didn't when the account was connected. The credential
   * isn't sent to them until the user allows it.
   */
  newHosts: string[];
}

/** An MCP server an integration is made of: code that runs on this computer. */
export interface IntegrationServerInfo {
  /** The npm package and exact version it's pinned to. */
  pinned: string;
  /** The command that starts it, as the user would type it. */
  command: string;
  /** Environment variables it needs, by name. */
  env: { name: string; label: string; secret: boolean }[];
  /** The image it runs in when the user chooses Docker. */
  dockerImage: string;
  /** The MCP server it was added as, once installed. */
  serverId: string | null;
  docker: boolean;
}

/** An integration as Settings and the marketplace show it. */
export interface IntegrationInfo {
  id: string;
  name: string;
  summary: string;
  /** `declarative` is a manifest over an OpenAPI document; `mcp` runs a server's code. */
  kind: 'declarative' | 'mcp';
  /** Shipped with the app, installed from a marketplace, or added from a folder by the user. */
  source: 'bundled' | 'marketplace' | 'local';
  /** The package's version, or null for one that ships with the app. */
  version: string | null;
  /** Every host it may call. Nothing else is ever reached. */
  hosts: string[];
  auth: {
    type: IntegrationAuthType;
    /** What the form calls the secret: "Secret key", "Token". */
    label: string;
    hint: string;
    /** It can tell a test credential from a live one by looking at it. */
    detectsMode: boolean;
    /** OAuth: the user brings their own client id, and maybe its secret. */
    ownClient: boolean;
    scopes: string[];
  };
  settings: IntegrationSetting[];
  operations: IntegrationOperationInfo[];
  /** What clanks that can use it are told. */
  guide: string;
  guideTokens: number;
  connections: ConnectionInfo[];
  server: IntegrationServerInfo | null;
  /** Why it's off, such as being revoked in its marketplace. Null when it works. */
  disabled: string | null;
}

/** An integration turned on in a project, and the clanks that may use it there. */
export interface ProjectIntegration {
  connectionId: string;
  integrationId: string;
  name: string;
  label: string;
  mode: ConnectionMode;
  clanks: string[];
}

/** What an approval prompt says about the service a call goes to. */
export interface IntegrationApproval {
  name: string;
  /** The connection's label. */
  account: string;
  mode: ConnectionMode;
  host: string;
  risk: OperationRisk;
}

export const connectInputSchema = z.object({
  integrationId: integrationIdSchema,
  label: z.string().trim().max(60).default(''),
  /** The API key or token, or for basic auth the password. */
  secret: z.string().trim().max(8192).default(''),
  /** For basic auth. */
  username: z.string().trim().max(320).default(''),
  settings: z.record(z.string(), z.string().trim().max(300)).default({}),
  /** For an integration that can't tell from the credential. */
  mode: connectionModeSchema.optional(),
  /** OAuth: the user's own client. */
  clientId: z.string().trim().max(500).default(''),
  clientSecret: z.string().trim().max(500).default(''),
});

export type ConnectInput = z.input<typeof connectInputSchema>;

/** An OAuth sign-in waiting for the user to finish it in their browser. */
export interface OAuthPending {
  integrationId: string;
  /** The page to sign in on, opened in the system browser. */
  url: string;
  startedAt: Date;
}

export interface IntegrationsSnapshot {
  integrations: IntegrationInfo[];
  oauth: OAuthPending | null;
  /** Why the last OAuth sign-in didn't work. */
  oauthError: string | null;
}
