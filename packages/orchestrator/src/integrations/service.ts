import {
  type ConnectInput,
  type ConnectionInfo,
  type ConnectionMode,
  type IntegrationInfo,
  type IntegrationsSnapshot,
  MODE_NAMES,
  type OAuthPending,
  type OperationRisk,
  type ProjectIntegration,
  connectInputSchema,
  estimateTokens,
  integrationIdSchema,
} from '@clanks/core';
import {
  type Credential,
  type DeclarativeIntegration,
  GUIDE_FILE,
  type GuideEntry,
  type Integration,
  IntegrationError,
  type IntegrationFiles,
  MANIFEST_FILE,
  type McpIntegration,
  OPENAPI_FILE,
  OperationUnanswered,
  RequestFailure,
  type ToolConnection,
  authorizeUrl,
  detectMode,
  detectsMode,
  exchangeCode,
  integrationTools,
  loadIntegration,
  mcpCommand,
  mcpPinned,
  parseArgs,
  pick,
  pkcePair,
  refreshTokens,
  riskOn,
  runOperation,
} from '@clanks/integrations';
import { ToolArgumentsError, ToolFailure, type ToolSpec } from '@clanks/tools';
import { removeTree } from '@clanks/workspace';
import { and, asc, eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { lookup } from 'node:dns/promises';
import { type Server, createServer } from 'node:http';
import { join } from 'node:path';
import type { McpService } from '../mcp/service';
import type { SecretStore } from '../secrets';
import { connection as connectionTable, pkg, projectIntegration } from '../store/schema';
import type { Db } from '../store/store';

export { IntegrationError } from '@clanks/integrations';

type ConnectionRow = typeof connectionTable.$inferSelect;

/** Where an integration's files came from. */
type Source = IntegrationInfo['source'];

interface Loaded {
  integration: Integration;
  source: Source;
  files: IntegrationFiles;
}

/** What's kept in the keychain for a connection. */
type Stored =
  | { kind: 'api_key'; secret: string }
  | { kind: 'basic'; username: string; password: string }
  | {
      kind: 'oauth2';
      accessToken: string;
      refreshToken: string | null;
      clientId: string;
      clientSecret: string;
    };

const secretRef = (id: string) => `integration:${id}`;

/** How long the app waits for the user to finish signing in, in their browser. */
const OAUTH_TIMEOUT_MS = 10 * 60_000;
/** An access token this close to running out is renewed before it's used. */
const REFRESH_EARLY_MS = 60_000;

export interface IntegrationServiceOptions {
  db: Db;
  secrets: SecretStore;
  /** The integrations that ship with the app. Never written to. */
  bundledDir: string | null;
  /** Those installed from a marketplace or added from a folder, in the app data folder. */
  installedDir: string;
  mcp: McpService;
  /** A project's integrations changed, so its board and prompts should catch up. */
  onProjectChange?: (projectId: string) => void;
  /** Opens a page in the user's own browser, for signing in to a service. */
  openUrl?: (url: string) => Promise<void>;
  /** Whether Docker is there to run an integration's server in. */
  docker?: () => Promise<{ running: boolean; problem: string | null }>;
  fetch?: typeof fetch;
  /** Tests say what a host resolves to. */
  lookup?: (host: string) => Promise<string[]>;
  now?: () => Date;
}

/** How a call made for a scheduled action came out. */
export type IntegrationCall =
  | { kind: 'answered'; body: unknown; text: string }
  /** The service turned it down, with the status it answered. */
  | { kind: 'refused'; status: number; message: string }
  /** No answer at all: it may or may not have gone through. */
  | { kind: 'unanswered'; message: string }
  /** It couldn't be made: the account or the integration is gone, or its credential is. */
  | { kind: 'unavailable'; message: string };

/** The tools and guides a clank gets from a project's integrations. */
export interface IntegrationTools {
  specs: ToolSpec<Record<string, unknown>>[];
  services: GuideEntry[];
}

/**
 * Integrations: which there are, the accounts the user connected to each, and which projects and
 * clanks may use them. Credentials stay in the keychain and are read here, only to sign a request
 * to a host the integration declares. Emits `change` when anything the window shows changes.
 */
export class IntegrationService extends EventEmitter<{ change: [] }> {
  private cache: Map<string, Loaded> | null = null;
  private broken: string[] = [];
  private oauth: {
    pending: OAuthPending;
    server: Server;
    timer: NodeJS.Timeout;
    controller: AbortController;
  } | null = null;
  private oauthError: string | null = null;
  /** Token renewals under way, so two calls at once don't both spend a refresh token. */
  private readonly refreshing = new Map<string, Promise<Stored>>();

  constructor(private readonly options: IntegrationServiceOptions) {
    super();
    this.setMaxListeners(50);
  }

  snapshot(): IntegrationsSnapshot & { problems: string[] } {
    const integrations = [...this.loaded().values()]
      .map((loaded) => this.info(loaded))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      integrations,
      oauth: this.oauth?.pending ?? null,
      oauthError: this.oauthError,
      problems: this.broken,
    };
  }

  /** An integration as it's loaded now, or undefined when there's none by that id. */
  find(id: string): Integration | undefined {
    return this.loaded().get(id)?.integration;
  }

  /** Whether an integration is there, bundled or installed. */
  has(id: string): boolean {
    return this.loaded().has(id);
  }

  sourceOf(id: string): Source | null {
    return this.loaded().get(id)?.source ?? null;
  }

  /** An integration's files as text, for a diff against a newer version and for publishing. */
  files(id: string): IntegrationFiles | null {
    return this.loaded().get(id)?.files ?? null;
  }

  // Connections

  /** Connects an account with a key or a password, once the service has accepted it. */
  async connect(input: ConnectInput): Promise<ConnectionInfo> {
    const values = connectInputSchema.parse(input);
    const integration = this.declarative(values.integrationId);
    const { auth } = integration.manifest;
    if (auth.type === 'oauth2') {
      throw new IntegrationError(`${integration.manifest.name} is connected by signing in`);
    }
    const settings = this.checkSettings(integration, values.settings);
    let stored: Stored | null = null;
    let mode: ConnectionMode = values.mode ?? 'live';
    if (auth.type === 'api_key') {
      if (!values.secret) throw new IntegrationError(`Paste the ${labelOf(integration)} first`);
      stored = { kind: 'api_key', secret: values.secret };
      mode = this.modeOf(integration, values.secret, values.mode);
    } else if (auth.type === 'basic') {
      if (!values.username || !values.secret) {
        throw new IntegrationError('It needs both a user name and a password');
      }
      stored = { kind: 'basic', username: values.username, password: values.secret };
      mode = this.modeOf(integration, values.secret, values.mode);
    }
    const account = await this.verify(integration, settings, stored, mode);
    return this.save(integration, {
      label: values.label,
      mode,
      account,
      settings,
      stored,
      scopes: [],
      expiresAt: null,
    });
  }

  /**
   * Starts signing in to a service with OAuth: the sign-in page opens in the user's own browser,
   * and hands its code back to a listener on this computer, so no server of ours is involved.
   */
  async startOAuth(input: ConnectInput): Promise<OAuthPending> {
    const values = connectInputSchema.parse(input);
    const integration = this.declarative(values.integrationId);
    const { auth } = integration.manifest;
    if (auth.type !== 'oauth2') {
      throw new IntegrationError(`${integration.manifest.name} doesn't sign in with OAuth`);
    }
    const clientId = auth.client_id ?? values.clientId;
    if (!clientId) throw new IntegrationError('Paste your OAuth client id first');
    const settings = this.checkSettings(integration, values.settings);
    this.cancelOAuth();

    const state = randomBytes(24).toString('base64url');
    const pair = pkcePair();
    const controller = new AbortController();
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(auth.redirect_port ?? 0, '127.0.0.1', resolve);
      });
    } catch (error) {
      throw new IntegrationError(
        auth.redirect_port
          ? `${integration.manifest.name} hands its sign-in back on port ${auth.redirect_port}, which something else on this computer is using. Close that and try again.`
          : `The sign-in couldn't start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const url = authorizeUrl(auth, { clientId, redirectUri, state, challenge: pair.challenge });
    const pending: OAuthPending = {
      integrationId: integration.manifest.id,
      url,
      startedAt: this.now(),
    };
    const timer = setTimeout(() => {
      if (this.oauth?.pending !== pending) return;
      this.endOAuth('The sign-in took too long. Start it again.');
    }, OAUTH_TIMEOUT_MS);
    timer.unref();
    this.oauth = { pending, server, timer, controller };
    this.oauthError = null;

    server.on('request', (request, response) => {
      const asked = new URL(request.url ?? '/', redirectUri);
      const page = (title: string, text: string) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(
          `<!doctype html><meta charset="utf-8"><title>clanks</title><body style="font:16px system-ui;background:#050506;color:#fff;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:22px">${title}</h1><p style="color:#8a8a93">${text}</p></div>`,
        );
      };
      if (asked.pathname !== '/callback' || this.oauth?.pending !== pending) {
        response.writeHead(404).end();
        return;
      }
      // Only the page this sign-in opened knows the state, so nothing else can finish it.
      if (asked.searchParams.get('state') !== state) {
        response.writeHead(400).end('This sign-in was not started by clanks.');
        return;
      }
      const code = asked.searchParams.get('code');
      if (!code) {
        const why = asked.searchParams.get('error_description') ?? asked.searchParams.get('error');
        page('Not connected', 'You can close this tab and go back to clanks.');
        this.endOAuth(
          why === 'access_denied'
            ? 'You cancelled the sign-in.'
            : `It didn't sign in: ${why ?? 'no code came back'}`,
        );
        return;
      }
      page('Connected', 'You can close this tab and go back to clanks.');
      void (async () => {
        try {
          const tokens = await exchangeCode(
            auth,
            {
              clientId,
              clientSecret: values.clientSecret,
              redirectUri,
              code,
              verifier: pair.verifier,
            },
            { fetch: this.fetch(), signal: controller.signal, now: () => this.now() },
          );
          const stored: Stored = {
            kind: 'oauth2',
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            clientId,
            clientSecret: values.clientSecret,
          };
          const mode = values.mode ?? 'live';
          const account = await this.verify(integration, settings, stored, mode);
          this.save(integration, {
            label: values.label,
            mode,
            account,
            settings,
            stored,
            scopes: tokens.scopes.length > 0 ? tokens.scopes : auth.scopes,
            expiresAt: tokens.expiresAt,
          });
          this.endOAuth(null);
        } catch (error) {
          if (controller.signal.aborted) return;
          this.endOAuth(error instanceof Error ? error.message : String(error));
        }
      })();
    });

    this.emit('change');
    // Without the app's shell, such as in tests, the caller opens the page itself.
    await this.options.openUrl?.(url);
    return pending;
  }

  cancelOAuth(): void {
    if (this.oauth) this.endOAuth(null);
  }

  private endOAuth(error: string | null): void {
    const current = this.oauth;
    this.oauth = null;
    this.oauthError = error;
    if (current) {
      clearTimeout(current.timer);
      current.controller.abort();
      current.server.close();
      current.server.closeAllConnections();
    }
    this.emit('change');
  }

  /** Calls the integration's check again, and says how it went. */
  async check(connectionId: string): Promise<{ ok: boolean; message: string }> {
    const row = this.requireConnection(connectionId);
    const integration = this.declarative(row.integration);
    try {
      const account = await this.verify(
        integration,
        row.settings,
        null,
        row.mode,
        this.toolConnection(integration, row),
      );
      if (account && account !== row.account) {
        this.options.db
          .update(connectionTable)
          .set({ account })
          .where(eq(connectionTable.id, row.id))
          .run();
        this.emit('change');
      }
      return {
        ok: true,
        message: account
          ? `It works, as ${account}.`
          : integration.manifest.check
            ? 'It works.'
            : "It's saved. This integration has no call to check it with.",
      };
    } catch (error) {
      if (error instanceof IntegrationError || error instanceof ToolFailure) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }

  rename(connectionId: string, label: string): void {
    const row = this.requireConnection(connectionId);
    const next = label.trim().slice(0, 60);
    if (!next) throw new IntegrationError('Give it a name');
    this.options.db
      .update(connectionTable)
      .set({ label: next })
      .where(eq(connectionTable.id, row.id))
      .run();
    this.changed(row.id);
  }

  /** Says whether an account is a test one, for a service whose credentials don't show it. */
  setMode(connectionId: string, mode: ConnectionMode): void {
    const row = this.requireConnection(connectionId);
    const integration = this.find(row.integration);
    if (integration?.kind === 'declarative' && detectsMode(integration.manifest.auth)) {
      throw new IntegrationError(
        `${integration.manifest.name} says which mode a credential is for, so it can't be changed here. Connect the other kind of key instead.`,
      );
    }
    this.options.db
      .update(connectionTable)
      .set({ mode })
      .where(eq(connectionTable.id, row.id))
      .run();
    this.changed(row.id);
  }

  /** Lets a connection's credential go to the hosts its integration calls now. */
  allowHosts(connectionId: string): void {
    const row = this.requireConnection(connectionId);
    const integration = this.find(row.integration);
    if (!integration) return;
    this.options.db
      .update(connectionTable)
      .set({ hosts: integration.hosts })
      .where(eq(connectionTable.id, row.id))
      .run();
    this.changed(row.id);
  }

  disconnect(connectionId: string): void {
    const row = this.requireConnection(connectionId);
    const projects = this.projectsUsing(row.id);
    this.options.db.delete(connectionTable).where(eq(connectionTable.id, row.id)).run();
    this.options.secrets.delete(secretRef(row.id));
    this.emit('change');
    for (const projectId of projects) this.options.onProjectChange?.(projectId);
  }

  // Projects

  /** The integrations turned on in a project, with the clanks that may use each. */
  forProject(projectId: string): ProjectIntegration[] {
    const rows = this.options.db
      .select()
      .from(projectIntegration)
      .where(eq(projectIntegration.projectId, projectId))
      .all();
    const out: ProjectIntegration[] = [];
    for (const row of rows) {
      const connection = this.connectionRow(row.connectionId);
      const integration = connection ? this.find(connection.integration) : undefined;
      if (!connection || !integration) continue;
      out.push({
        connectionId: connection.id,
        integrationId: integration.manifest.id,
        name: integration.manifest.name,
        label: connection.label,
        mode: connection.mode,
        clanks: row.clanks,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Turns a connection on in a project for some clanks, or off with null. A project uses one
   * account per integration, so turning one on turns off any other of the same service.
   */
  setProject(projectId: string, connectionId: string, clanks: string[] | null): void {
    const row = this.requireConnection(connectionId);
    const { db } = this.options;
    const where = and(
      eq(projectIntegration.projectId, projectId),
      eq(projectIntegration.connectionId, connectionId),
    );
    if (clanks === null) {
      db.delete(projectIntegration).where(where).run();
    } else {
      const same = this.connections(row.integration)
        .map((c) => c.id)
        .filter((id) => id !== connectionId);
      db.transaction((tx) => {
        for (const other of same) {
          tx.delete(projectIntegration)
            .where(
              and(
                eq(projectIntegration.projectId, projectId),
                eq(projectIntegration.connectionId, other),
              ),
            )
            .run();
        }
        tx.insert(projectIntegration)
          .values({ projectId, connectionId, clanks: [...new Set(clanks)] })
          .onConflictDoUpdate({
            target: [projectIntegration.projectId, projectIntegration.connectionId],
            set: { clanks: [...new Set(clanks)] },
          })
          .run();
      });
    }
    this.emit('change');
    this.options.onProjectChange?.(projectId);
  }

  /** The tools a clank gets from a project's integrations, and what its prompt says of them. */
  toolsFor(projectId: string, clankId: string): IntegrationTools {
    const specs: ToolSpec<Record<string, unknown>>[] = [];
    const services: GuideEntry[] = [];
    for (const enabled of this.forProject(projectId)) {
      if (!enabled.clanks.includes(clankId)) continue;
      const loaded = this.loaded().get(enabled.integrationId);
      const row = this.connectionRow(enabled.connectionId);
      if (!loaded || !row || loaded.integration.kind !== 'declarative') continue;
      if (this.disabledWhy(loaded) !== null) continue;
      const tools = integrationTools(
        loaded.integration,
        this.toolConnection(loaded.integration, row),
        {
          fetch: this.fetch(),
          lookup: this.lookup(),
        },
      );
      specs.push(...tools);
      services.push({
        name: loaded.integration.manifest.name,
        account: row.label,
        mode: row.mode,
        tools: tools.map((t) => t.name),
        guide: loaded.integration.guide,
      });
    }
    return { specs, services };
  }

  /** Every operation a clank could be given, across projects, for its profile's tool list. */
  operationsFor(clankId: string): {
    tool: string;
    description: string;
    locked: boolean;
    read: boolean;
  }[] {
    const rows = this.options.db.select().from(projectIntegration).all();
    const seen = new Map<
      string,
      { tool: string; description: string; locked: boolean; read: boolean }
    >();
    for (const row of rows) {
      if (!row.clanks.includes(clankId)) continue;
      const connection = this.connectionRow(row.connectionId);
      const integration = connection ? this.find(connection.integration) : undefined;
      if (!connection || integration?.kind !== 'declarative') continue;
      for (const operation of integration.operations) {
        const risk = riskOn(operation, connection.mode);
        const existing = seen.get(operation.tool);
        seen.set(operation.tool, {
          tool: operation.tool,
          description: `${integration.manifest.name}: ${operation.summary}`,
          // Locked if it is on any account the clank can reach.
          locked: (existing?.locked ?? false) || risk === 'outbound',
          read: (existing?.read ?? true) && risk === 'read',
        });
      }
    }
    return [...seen.values()];
  }

  /** One line per integration for a project's facts: which account, which mode, who can use it. */
  facts(projectId: string, name: (clankId: string) => string): string[] {
    return this.forProject(projectId)
      .filter((p) => p.clanks.length > 0)
      .map(
        (p) =>
          `${p.name}, ${p.mode} mode (account "${p.label}"), for ${p.clanks.map(name).join(', ')}`,
      );
  }

  // Routines

  /** Every declarative integration, with the account a project uses for each, for routines. */
  forRoutines(projectId: string): {
    id: string;
    name: string;
    connection: string | null;
    operations: { id: string; parameters: string[]; required: string[]; schedule: string | null }[];
  }[] {
    const enabled = this.forProject(projectId);
    const out = [];
    for (const loaded of this.loaded().values()) {
      const { integration } = loaded;
      if (integration.kind !== 'declarative' || this.disabledWhy(loaded) !== null) continue;
      out.push({
        id: integration.manifest.id,
        name: integration.manifest.name,
        connection: enabled.find((e) => e.integrationId === integration.manifest.id)?.label ?? null,
        operations: integration.operations.map((operation) => ({
          id: operation.id,
          parameters: Object.keys(operation.parameters.properties ?? {}),
          required: Array.isArray(operation.parameters.required)
            ? (operation.parameters.required as string[])
            : [],
          schedule: operation.schedule,
        })),
      });
    }
    return out;
  }

  /** The account a project uses for an integration, if it has one turned on. */
  connectionFor(projectId: string, integrationId: string): ProjectIntegration | null {
    return this.forProject(projectId).find((e) => e.integrationId === integrationId) ?? null;
  }

  /**
   * An operation as a scheduled action shows it: what it does, on which account, and at what
   * risk. Null when the integration or the operation is gone.
   */
  operationInfo(
    integrationId: string,
    operationId: string,
    connectionId: string | null,
  ): {
    integrationName: string;
    summary: string;
    connectionLabel: string | null;
    mode: ConnectionMode | null;
    risk: OperationRisk | null;
    schedule: string | null;
    verify: string | null;
    cancel: string | null;
    /** Why it can't be called now. */
    problem: string | null;
  } | null {
    const loaded = this.loaded().get(integrationId);
    if (!loaded || loaded.integration.kind !== 'declarative') return null;
    const operation = loaded.integration.operations.find((o) => o.id === operationId);
    if (!operation) return null;
    const row = connectionId ? this.connectionRow(connectionId) : undefined;
    const { name } = loaded.integration.manifest;
    return {
      integrationName: name,
      summary: operation.summary,
      connectionLabel: row?.label ?? null,
      mode: row?.mode ?? null,
      risk: row ? riskOn(operation, row.mode) : null,
      schedule: operation.schedule,
      verify: operation.verify,
      cancel: operation.cancel,
      problem:
        this.disabledWhy(loaded) ??
        (row
          ? null
          : connectionId
            ? `The ${name} account it was set up with was disconnected. Connect one again.`
            : `No ${name} account is turned on in this project.`),
    };
  }

  /**
   * Checks a payload against an operation's arguments, reading them the forgiving way tools do.
   * Throws an `IntegrationError` saying what doesn't fit.
   */
  fitArguments(
    integrationId: string,
    operationId: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const integration = this.declarative(integrationId);
    const operation = integration.operations.find((o) => o.id === operationId);
    if (!operation) {
      throw new IntegrationError(`${integration.manifest.name} has no ${operationId}`);
    }
    try {
      return parseArgs(operation.parameters, payload);
    } catch (error) {
      if (error instanceof ToolArgumentsError) throw new IntegrationError(error.message);
      throw error;
    }
  }

  /**
   * Makes an operation's calls as a connection, with no model anywhere near: how an approved
   * action goes out at its time. The outcome says whether the service answered, turned it down,
   * or never answered, in which case it may or may not have gone through.
   */
  async call(
    connectionId: string,
    operationId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<IntegrationCall> {
    const row = this.connectionRow(connectionId);
    if (!row) {
      return { kind: 'unavailable', message: 'Its account was disconnected. Connect it again.' };
    }
    let integration: DeclarativeIntegration;
    try {
      integration = this.declarative(row.integration);
    } catch (error) {
      return {
        kind: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const operation = integration.operations.find((o) => o.id === operationId);
    if (!operation) {
      return {
        kind: 'unavailable',
        message: `${integration.manifest.name} no longer has ${operationId}.`,
      };
    }
    try {
      const result = await runOperation(
        integration,
        operation,
        this.toolConnection(integration, row),
        args,
        { fetch: this.fetch(), lookup: this.lookup(), signal, maxChars: 4000 },
      );
      if (result.error) {
        return {
          kind: 'refused',
          status: result.status ?? 0,
          message: result.reason ?? result.content,
        };
      }
      return { kind: 'answered', body: result.body, text: result.content };
    } catch (error) {
      if (error instanceof OperationUnanswered)
        return { kind: 'unanswered', message: error.message };
      if (error instanceof ToolFailure || error instanceof RequestFailure) {
        // A credential that's gone or revoked, or a request that couldn't be built.
        return { kind: 'unavailable', message: error.message };
      }
      throw error;
    }
  }

  /**
   * Where what an operation made can be seen, from the `link` its integration gives for it and
   * what the service answered. Null when it gives none, or the link would lead anywhere but a
   * host the integration declares.
   */
  linkFor(integrationId: string, operationId: string, body: unknown): string | null {
    const loaded = this.loaded().get(integrationId);
    if (!loaded || loaded.integration.kind !== 'declarative') return null;
    const template = loaded.integration.operations.find((o) => o.id === operationId)?.link;
    if (!template) return null;
    let missing = false;
    const filled = template.replace(/\{([^{}]+)\}/g, (_match, path: string) => {
      const value = pick(body, path);
      if (typeof value !== 'string' && typeof value !== 'number') {
        missing = true;
        return '';
      }
      return encodeURIComponent(String(value));
    });
    if (missing) return null;
    try {
      const url = new URL(filled);
      const hosts = [...loaded.integration.hosts, ...(loaded.integration.manifest.links ?? [])];
      return url.protocol === 'https:' && hosts.includes(url.host) ? url.toString() : null;
    } catch {
      return null;
    }
  }

  // Installing

  /**
   * Installs an integration's files into the app data folder, once they've been checked. A
   * marketplace's must name public hosts; one the user wrote may call their own computer.
   */
  async install(files: Map<string, string>, source: Exclude<Source, 'bundled'>): Promise<string> {
    const read: IntegrationFiles = {
      manifest: files.get(MANIFEST_FILE) ?? '',
      openapi: files.get(OPENAPI_FILE) ?? null,
      guide: files.get(GUIDE_FILE) ?? null,
    };
    if (!read.manifest) throw new IntegrationError(`It has no ${MANIFEST_FILE}`);
    const integration = loadIntegration(read, { allowLocal: source === 'local' });
    const { id } = integration.manifest;
    if (integration.kind === 'mcp') await this.checkPinned(integration);

    const dir = join(this.options.installedDir, id);
    const staging = `${dir}.new`;
    await removeTree(staging);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, MANIFEST_FILE), read.manifest);
    if (read.openapi) writeFileSync(join(staging, OPENAPI_FILE), read.openapi);
    if (read.guide) writeFileSync(join(staging, GUIDE_FILE), read.guide);
    // Swapped in whole, so a crash never leaves half an integration.
    await removeTree(dir);
    renameSync(staging, dir);
    this.cache = null;

    if (integration.kind === 'mcp') {
      const server = this.options.mcp.forIntegration(id);
      if (server) {
        await this.options.mcp.repin(server.id, {
          ...mcpCommand(integration.manifest, { docker: server.docker }),
          docker: server.docker,
        });
      }
    }
    this.emit('change');
    return id;
  }

  /** Adds an integration from a folder the user picked: their own, for a service or a server of theirs. */
  async addFromFolder(folder: string): Promise<string> {
    const read = (file: string) => {
      const path = join(folder, file);
      return existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n?/g, '\n') : null;
    };
    const manifest = read(MANIFEST_FILE);
    if (manifest === null) {
      throw new IntegrationError(
        `There's no ${MANIFEST_FILE} in that folder. An integration is a ${MANIFEST_FILE}, an ${OPENAPI_FILE} and a ${GUIDE_FILE}.`,
      );
    }
    const openapi = read(OPENAPI_FILE) ?? read('openapi.yml') ?? read('openapi.json');
    const guide = read(GUIDE_FILE);
    const integration = loadIntegration({ manifest, openapi, guide }, { allowLocal: true });
    const { id, name } = integration.manifest;
    const existing = this.loaded().get(id);
    if (existing && existing.source !== 'local') {
      throw new IntegrationError(
        existing.source === 'bundled'
          ? `${existing.integration.manifest.name} ships with the app under the id ${id}. Give yours another id.`
          : `${name}'s id, ${id}, belongs to an integration you installed from a marketplace. Give yours another id, or uninstall that one.`,
      );
    }
    const files = new Map<string, string>([[MANIFEST_FILE, manifest]]);
    if (openapi) files.set(OPENAPI_FILE, openapi);
    if (guide) files.set(GUIDE_FILE, guide);
    return this.install(files, 'local');
  }

  /**
   * Removes an installed integration. One that also ships with the app goes back to the shipped
   * one and keeps its accounts; otherwise its accounts and its server go with it.
   */
  async uninstall(id: string): Promise<void> {
    integrationIdSchema.parse(id);
    const loaded = this.loaded().get(id);
    if (!loaded || loaded.source === 'bundled') {
      throw new IntegrationError(
        loaded ? `${loaded.integration.manifest.name} ships with the app` : `There's no ${id}`,
      );
    }
    await removeTree(join(this.options.installedDir, id));
    this.cache = null;
    if (!this.loaded().has(id)) {
      for (const row of this.connections(id)) this.disconnect(row.id);
      const server = this.options.mcp.forIntegration(id);
      if (server) await this.options.mcp.remove(server.id);
    }
    this.emit('change');
  }

  /**
   * Sets up an MCP integration's server: its environment variables into the keychain, the clanks
   * that get its tools, and whether it runs in Docker.
   */
  async setUpServer(input: {
    integrationId: string;
    env: Record<string, string> | null;
    clanks: string[];
    docker: boolean;
  }): Promise<void> {
    const loaded = this.loaded().get(input.integrationId);
    if (loaded?.integration.kind !== 'mcp') {
      throw new IntegrationError("That integration doesn't run a server");
    }
    const why = this.disabledWhy(loaded);
    if (why) throw new IntegrationError(why);
    const { manifest } = loaded.integration;
    if (input.docker) {
      const docker = await this.options.docker?.();
      if (!docker?.running) {
        throw new IntegrationError(
          docker?.problem ?? "Docker isn't available here, so it can't run in a container.",
        );
      }
    }
    const existing = this.options.mcp.forIntegration(manifest.id);
    if (input.env) {
      const known = new Set(manifest.server.env.map((e) => e.name));
      for (const name of Object.keys(input.env)) {
        if (!known.has(name)) throw new IntegrationError(`${manifest.name} takes no ${name}`);
      }
      const missing = manifest.server.env
        .filter((e) => e.required && !input.env![e.name]?.trim())
        .map((e) => e.label);
      if (missing.length > 0) throw new IntegrationError(`It needs: ${missing.join(', ')}`);
    } else if (!existing && manifest.server.env.some((e) => e.required)) {
      throw new IntegrationError('Fill in what it needs first');
    }
    const command = mcpCommand(manifest, { docker: input.docker });
    const secrets = input.env
      ? Object.fromEntries(Object.entries(input.env).filter(([, value]) => value.trim() !== ''))
      : null;
    if (existing) {
      await this.options.mcp.update(existing.id, {
        name: existing.name,
        transport: 'stdio',
        command: existing.command,
        args: existing.args,
        url: '',
        secrets,
        clanks: input.clanks,
      });
      await this.options.mcp.repin(existing.id, { ...command, docker: input.docker });
    } else {
      this.options.mcp.add(
        {
          name: manifest.name,
          transport: 'stdio',
          ...command,
          url: '',
          secrets: secrets ?? {},
          clanks: input.clanks,
        },
        { integration: manifest.id, docker: input.docker },
      );
    }
    this.emit('change');
  }

  /** Forgets the cached integrations, after something installed or revoked one. */
  reload(): void {
    this.cache = null;
    this.emit('change');
  }

  close(): void {
    if (this.oauth) {
      clearTimeout(this.oauth.timer);
      this.oauth.controller.abort();
      this.oauth.server.close();
      this.oauth.server.closeAllConnections();
      this.oauth = null;
    }
  }

  // Inside

  /**
   * An MCP integration pins its package by checksum. Before it's installed, the checksum is
   * checked against what the npm registry serves for that exact version.
   */
  private async checkPinned(integration: McpIntegration): Promise<void> {
    const { npm, version, integrity } = integration.manifest.server;
    const url = `https://registry.npmjs.org/${npm.replace('/', '%2F')}/${version}`;
    let body: { dist?: { integrity?: string } };
    try {
      const response = await this.fetch()(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'clanks' },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) {
        throw new IntegrationError(`npm has no ${mcpPinned(integration.manifest)}`);
      }
      if (!response.ok) throw new IntegrationError(`npm answered ${response.status}`);
      body = (await response.json()) as typeof body;
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError(
        `Couldn't check ${mcpPinned(integration.manifest)} against npm, so it wasn't installed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (body.dist?.integrity !== integrity) {
      throw new IntegrationError(
        `${mcpPinned(integration.manifest)} on npm doesn't match the checksum this integration pins, so it wasn't installed.`,
      );
    }
  }

  private declarative(id: string): DeclarativeIntegration {
    const loaded = this.loaded().get(id);
    if (!loaded) throw new IntegrationError(`There's no integration called ${id}`);
    if (loaded.integration.kind !== 'declarative') {
      throw new IntegrationError(
        `${loaded.integration.manifest.name} runs a server, which is set up rather than connected`,
      );
    }
    const why = this.disabledWhy(loaded);
    if (why) throw new IntegrationError(why);
    return loaded.integration;
  }

  /** Which mode a credential is for: what the integration can tell, else what the user said. */
  private modeOf(
    integration: DeclarativeIntegration,
    secret: string,
    chosen: ConnectionMode | undefined,
  ): ConnectionMode {
    const { auth, name } = integration.manifest;
    const detected = detectMode(auth, secret);
    if (detected) return detected;
    if (auth.type !== 'none' && auth.modes?.test && auth.modes.live) {
      const prefixes = [...auth.modes.test.prefix, ...auth.modes.live.prefix];
      throw new IntegrationError(
        `That doesn't look like a ${name} ${labelOf(integration).toLowerCase()}: it would start with ${prefixes.join(', ')}.`,
      );
    }
    // Nothing says it's a test account, so it's treated as the real one.
    return chosen ?? 'live';
  }

  private checkSettings(
    integration: DeclarativeIntegration,
    given: Record<string, string>,
  ): Record<string, string> {
    const settings: Record<string, string> = {};
    for (const setting of integration.manifest.settings) {
      const value = (given[setting.id] ?? '').trim();
      if (!new RegExp(setting.pattern).test(value)) {
        throw new IntegrationError(
          value
            ? `"${value}" isn't a valid ${setting.label.toLowerCase()}`
            : `Fill in ${setting.label}`,
        );
      }
      settings[setting.id] = value;
    }
    return settings;
  }

  /**
   * Proves a credential works by calling the integration's check, before anything is saved.
   * Resolves with who the account is, when the service says.
   */
  private async verify(
    integration: DeclarativeIntegration,
    settings: Record<string, string>,
    stored: Stored | null,
    mode: ConnectionMode,
    existing?: ToolConnection,
  ): Promise<string | null> {
    const { manifest } = integration;
    if (!manifest.check) return null;
    const connection: ToolConnection = existing ?? {
      id: 'new',
      label: manifest.name,
      mode,
      settings,
      hosts: integration.hosts,
      allowLocal: this.sourceOf(manifest.id) === 'local',
      credential: () => Promise.resolve(credentialOf(stored)),
    };
    const operation = integration.operations.find((o) => o.id === manifest.check)!;
    let result;
    try {
      result = await runOperation(
        integration,
        operation,
        connection,
        {},
        {
          fetch: this.fetch(),
          lookup: this.lookup(),
          signal: AbortSignal.timeout(60_000),
          maxChars: 4000,
        },
      );
    } catch (error) {
      if (error instanceof ToolFailure || error instanceof RequestFailure) {
        throw new IntegrationError(error.message);
      }
      throw error;
    }
    if (result.error) {
      // The service's own words: what a clank is told besides is no use to someone connecting.
      throw new IntegrationError(
        `${manifest.name} turned it down: ${result.reason ?? result.content}`,
      );
    }
    if (!manifest.account) return null;
    const account = pick(result.body, manifest.account);
    return typeof account === 'string' && account.trim() ? account.trim().slice(0, 80) : null;
  }

  private save(
    integration: DeclarativeIntegration,
    input: {
      label: string;
      mode: ConnectionMode;
      account: string | null;
      settings: Record<string, string>;
      stored: Stored | null;
      scopes: string[];
      expiresAt: Date | null;
    },
  ): ConnectionInfo {
    const { manifest } = integration;
    const id = randomUUID();
    if (input.stored) this.options.secrets.set(secretRef(id), JSON.stringify(input.stored));
    const row: ConnectionRow = {
      id,
      integration: manifest.id,
      label:
        input.label ||
        (input.account
          ? `${input.account} (${MODE_NAMES[input.mode].toLowerCase()})`
          : `${manifest.name} (${MODE_NAMES[input.mode].toLowerCase()})`),
      authType: manifest.auth.type,
      mode: input.mode,
      account: input.account,
      settings: input.settings,
      hosts: integration.hosts,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      connectedAt: this.now(),
    };
    this.options.db.insert(connectionTable).values(row).run();
    this.emit('change');
    return this.connectionInfo(row, integration);
  }

  /** A connection as an operation's tool uses it: its credential read only when a call is made. */
  private toolConnection(integration: DeclarativeIntegration, row: ConnectionRow): ToolConnection {
    return {
      id: row.id,
      label: row.label,
      mode: row.mode,
      settings: row.settings,
      // Only hosts the user agreed to when connecting, that the integration still declares.
      hosts: row.hosts.filter((host) => integration.hosts.includes(host)),
      allowLocal: this.sourceOf(integration.manifest.id) === 'local',
      credential: (signal) => this.credential(integration, row.id, signal),
    };
  }

  /** Reads a connection's credential from the keychain, renewing an OAuth token that's run out. */
  private async credential(
    integration: DeclarativeIntegration,
    connectionId: string,
    signal: AbortSignal,
  ): Promise<Credential> {
    const row = this.connectionRow(connectionId);
    const { name, auth } = integration.manifest;
    if (!row) throw new ToolFailure(`The ${name} account was disconnected.`);
    if (auth.type === 'none') return { kind: 'none' };
    let stored = this.stored(connectionId);
    if (!stored) {
      throw new ToolFailure(
        `The ${name} account's credential is missing from the keychain. It needs connecting again, in Settings.`,
      );
    }
    if (
      stored.kind === 'oauth2' &&
      auth.type === 'oauth2' &&
      row.expiresAt &&
      row.expiresAt.getTime() - this.now().getTime() < REFRESH_EARLY_MS
    ) {
      if (!stored.refreshToken) {
        throw new ToolFailure(
          `The sign-in to ${name} has run out, and it gave nothing to renew it with. It needs connecting again, in Settings.`,
        );
      }
      // The refresh token goes only to a host the user agreed to when they connected.
      const tokenHost = new URL(auth.token_url).host.toLowerCase();
      if (!row.hosts.includes(tokenHost)) {
        throw new ToolFailure(
          `This version of ${name} renews its sign-in at ${tokenHost}, which it didn't when the account was connected. It needs allowing in Settings, under Integrations.`,
        );
      }
      const current = stored;
      let renewal = this.refreshing.get(connectionId);
      if (!renewal) {
        renewal = (async () => {
          const tokens = await refreshTokens(
            auth,
            {
              clientId: current.clientId,
              clientSecret: current.clientSecret,
              refreshToken: current.refreshToken!,
            },
            { fetch: this.fetch(), signal, now: () => this.now() },
          );
          const next: Stored = {
            ...current,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? current.refreshToken,
          };
          this.options.secrets.set(secretRef(connectionId), JSON.stringify(next));
          this.options.db
            .update(connectionTable)
            .set({ expiresAt: tokens.expiresAt })
            .where(eq(connectionTable.id, connectionId))
            .run();
          return next;
        })().finally(() => this.refreshing.delete(connectionId));
        this.refreshing.set(connectionId, renewal);
      }
      try {
        stored = await renewal;
      } catch (error) {
        if (error instanceof RequestFailure) {
          throw new ToolFailure(
            `The sign-in to ${name} couldn't be renewed: ${error.message}. It may need connecting again, in Settings.`,
          );
        }
        throw error;
      }
    }
    return credentialOf(stored);
  }

  private stored(connectionId: string): Stored | null {
    const text = this.options.secrets.get(secretRef(connectionId));
    if (!text) return null;
    try {
      return JSON.parse(text) as Stored;
    } catch {
      return null;
    }
  }

  private info(loaded: Loaded): IntegrationInfo {
    const { integration, source } = loaded;
    const { manifest } = integration;
    const installed =
      source === 'marketplace'
        ? this.options.db
            .select()
            .from(pkg)
            .where(eq(pkg.key, `integration/${manifest.id}`))
            .get()
        : undefined;
    const base = {
      id: manifest.id,
      name: manifest.name,
      summary: manifest.summary,
      source,
      version: installed?.version ?? null,
      hosts: integration.hosts,
      guide: integration.guide,
      guideTokens: estimateTokens(integration.guide),
      disabled: this.disabledWhy(loaded),
    };
    if (integration.kind === 'mcp') {
      const { manifest } = integration;
      const server = this.options.mcp.forIntegration(manifest.id);
      const docker = server?.docker ?? false;
      const command = mcpCommand(manifest, { docker });
      return {
        ...base,
        kind: 'mcp',
        auth: {
          type: 'none',
          label: '',
          hint: '',
          detectsMode: false,
          ownClient: false,
          scopes: [],
        },
        settings: [],
        operations: [],
        connections: [],
        server: {
          pinned: mcpPinned(manifest),
          command: [command.command, ...command.args].join(' '),
          env: manifest.server.env.map(({ name, label, secret }) => ({ name, label, secret })),
          dockerImage: manifest.server.docker.image,
          serverId: server?.id ?? null,
          docker,
        },
      };
    }
    const { auth, settings } = integration.manifest;
    return {
      ...base,
      kind: 'declarative',
      auth: {
        type: auth.type,
        label: labelOf(integration),
        hint: auth.type === 'none' ? '' : (auth.hint ?? ''),
        detectsMode: detectsMode(auth),
        ownClient: auth.type === 'oauth2' && !auth.client_id,
        scopes: auth.type === 'oauth2' ? auth.scopes : [],
      },
      settings: settings.map(({ id, label, hint, placeholder }) => ({
        id,
        label,
        hint,
        placeholder,
      })),
      operations: integration.operations.map((operation) => ({
        id: operation.id,
        tool: operation.tool,
        summary: operation.summary,
        calls: operation.steps.map((s) => `${s.call.method} ${s.call.path}`),
        risk: operation.risk,
        testRisk: operation.testRisk,
      })),
      connections: this.connections(manifest.id).map((row) =>
        this.connectionInfo(row, integration),
      ),
      server: null,
    };
  }

  private connectionInfo(row: ConnectionRow, integration: Integration): ConnectionInfo {
    return {
      id: row.id,
      integrationId: row.integration,
      label: row.label,
      mode: row.mode,
      authType: row.authType,
      account: row.account,
      settings: row.settings,
      connectedAt: row.connectedAt,
      expiresAt: row.expiresAt,
      newHosts: integration.hosts.filter((host) => !row.hosts.includes(host)),
    };
  }

  /** Why an integration is off: its marketplace took it down. */
  private disabledWhy(loaded: Loaded): string | null {
    if (loaded.source !== 'marketplace') return null;
    const row = this.options.db
      .select()
      .from(pkg)
      .where(eq(pkg.key, `integration/${loaded.integration.manifest.id}`))
      .get();
    if (row?.status !== 'revoked') return null;
    return `${loaded.integration.manifest.name} was taken down from its marketplace${row.notice ? `: ${row.notice}` : '.'} It's off until you uninstall it.`;
  }

  private connections(integrationId: string): ConnectionRow[] {
    return this.options.db
      .select()
      .from(connectionTable)
      .where(eq(connectionTable.integration, integrationId))
      .orderBy(asc(connectionTable.connectedAt))
      .all();
  }

  private connectionRow(id: string): ConnectionRow | undefined {
    return this.options.db.select().from(connectionTable).where(eq(connectionTable.id, id)).get();
  }

  private requireConnection(id: string): ConnectionRow {
    const row = this.connectionRow(id);
    if (!row) throw new IntegrationError("That account isn't connected any more");
    return row;
  }

  private projectsUsing(connectionId: string): string[] {
    return this.options.db
      .select({ projectId: projectIntegration.projectId })
      .from(projectIntegration)
      .where(eq(projectIntegration.connectionId, connectionId))
      .all()
      .map((r) => r.projectId);
  }

  private changed(connectionId: string): void {
    this.emit('change');
    for (const projectId of this.projectsUsing(connectionId)) {
      this.options.onProjectChange?.(projectId);
    }
  }

  /** Every integration, by id. An installed one stands in for a shipped one of the same id. */
  private loaded(): Map<string, Loaded> {
    if (this.cache) return this.cache;
    const found = new Map<string, Loaded>();
    const broken: string[] = [];
    const marketplace = new Set(
      this.options.db
        .select({ id: pkg.packageId, kind: pkg.kind })
        .from(pkg)
        .all()
        .filter((row) => row.kind === 'integration')
        .map((row) => row.id),
    );
    const scan = (dir: string | null, bundled: boolean) => {
      if (!dir || !existsSync(dir)) return;
      for (const id of readdirSync(dir).sort()) {
        const read = (file: string) => {
          const path = join(dir, id, file);
          return existsSync(path) ? readFileSync(path, 'utf8') : null;
        };
        const manifest = read(MANIFEST_FILE);
        if (manifest === null) continue;
        const source: Source = bundled ? 'bundled' : marketplace.has(id) ? 'marketplace' : 'local';
        const files: IntegrationFiles = {
          manifest,
          openapi: read(OPENAPI_FILE),
          guide: read(GUIDE_FILE),
        };
        try {
          const integration = loadIntegration(files, { allowLocal: source === 'local' });
          if (integration.manifest.id !== id) {
            throw new IntegrationError(`its manifest says its id is ${integration.manifest.id}`);
          }
          found.set(id, { integration, source, files });
        } catch (error) {
          // A shipped one that doesn't load is a bug; an installed one may have been edited by hand.
          if (bundled) throw error;
          broken.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    scan(this.options.bundledDir, true);
    scan(this.options.installedDir, false);
    this.broken = broken;
    this.cache = found;
    return found;
  }

  private fetch(): typeof fetch {
    return this.options.fetch ?? fetch;
  }

  /**
   * How a host's addresses are looked up before it's called. With the real network, through DNS;
   * a stand-in for the services, as tests use, has no addresses to look up.
   */
  private lookup(): ((host: string) => Promise<string[]>) | undefined {
    if (this.options.lookup) return this.options.lookup;
    if (this.options.fetch) return undefined;
    return async (host) => (await lookup(host, { all: true })).map((found) => found.address);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function labelOf(integration: DeclarativeIntegration): string {
  const { auth } = integration.manifest;
  if (auth.type === 'none') return '';
  return (
    auth.label ??
    (auth.type === 'api_key' ? 'API key' : auth.type === 'basic' ? 'Password' : 'Account')
  );
}

function credentialOf(stored: Stored | null): Credential {
  if (!stored) return { kind: 'none' };
  if (stored.kind === 'oauth2') return { kind: 'oauth2', accessToken: stored.accessToken };
  return stored;
}
