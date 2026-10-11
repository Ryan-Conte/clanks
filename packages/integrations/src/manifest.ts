import { integrationIdSchema, operationIdSchema, operationRiskSchema } from '@clanks/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** An integration that can't be used, with a reason a person can act on. */
export class IntegrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IntegrationError';
  }
}

/** The files an integration is made of, by their fixed names. */
export const MANIFEST_FILE = 'manifest.yaml';
export const OPENAPI_FILE = 'openapi.yaml';
export const GUIDE_FILE = 'guide.md';

/** What a guide may take of a clank's prompt, in tokens. */
export const GUIDE_TOKEN_BUDGET = 300;

/** A public host name, or `*.example.com` for any name under one. Never an address. */
const PUBLIC_HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,22}[a-z]$/;
/** A host on this computer, for an integration the user wrote for their own server. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d{2,5})?$/;

const headerName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, 'Use a header name such as Authorization');

/** Headers a manifest can't set: the runtime and the connection own them. */
const RESERVED_HEADERS = new Set([
  'host',
  'cookie',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'proxy-authorization',
]);

/** `GET /v1/products`: a method and a path in the OpenAPI document. */
const callSchema = z
  .string()
  .regex(
    /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/,
    'Write a call as a method and a path: GET /v1/items',
  );

/** How a credential of one mode starts: one prefix, or any of several. */
const prefixSchema = z
  .union([z.string().min(1).max(40), z.array(z.string().min(1).max(40)).min(1).max(8)])
  .transform((prefix) => (typeof prefix === 'string' ? [prefix] : prefix));

const modesSchema = z
  .object({
    test: z.object({ prefix: prefixSchema }).strict().optional(),
    live: z.object({ prefix: prefixSchema }).strict().optional(),
  })
  .strict();

const wording = {
  label: z.string().trim().min(1).max(40).optional(),
  hint: z.string().trim().max(300).optional(),
};

const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z
    .object({
      type: z.literal('api_key'),
      in: z.enum(['header', 'query']).default('header'),
      /** The header or query parameter the key goes in. */
      header: headerName.optional(),
      name: z
        .string()
        .regex(/^[A-Za-z][\w.-]{0,63}$/)
        .optional(),
      /** How the key is written there. `{secret}` is the key. */
      format: z.string().min(1).max(120).default('Bearer {secret}'),
      modes: modesSchema.optional(),
      ...wording,
    })
    .strict(),
  z
    .object({
      type: z.literal('basic'),
      /** What the form calls the user name, such as "Account SID". */
      username_label: z.string().trim().min(1).max(40).optional(),
      modes: modesSchema.optional(),
      ...wording,
    })
    .strict(),
  z
    .object({
      type: z.literal('oauth2'),
      authorize_url: z.string().url(),
      token_url: z.string().url(),
      scopes: z.array(z.string().min(1).max(200)).max(40).default([]),
      /** A public client the service lets anyone use. Without one, the user brings their own. */
      client_id: z.string().min(1).max(300).optional(),
      /** Extra parameters for the sign-in page, such as `access_type: offline`. */
      extra: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.string().max(200)).default({}),
      header: headerName.default('Authorization'),
      format: z.string().min(1).max(120).default('Bearer {secret}'),
      modes: modesSchema.optional(),
      ...wording,
    })
    .strict(),
]);

export type ManifestAuth = z.infer<typeof authSchema>;

const settingSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/),
    label: z.string().trim().min(1).max(40),
    hint: z.string().trim().max(300).default(''),
    placeholder: z.string().trim().max(80).default(''),
    /** What a value must match. It goes into addresses, so the default takes no dots or slashes. */
    pattern: z.string().max(200).default('^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$'),
  })
  .strict();

const stepSchema = z
  .object({
    call: callSchema,
    /** Its arguments: values, or `{name}` for one of the tool's arguments or an earlier step's. */
    with: z.record(z.string(), z.unknown()).default({}),
    /** Values to keep from its response for later steps, by a path such as `data.0.id`. */
    save: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), z.string().max(120)).default({}),
  })
  .strict();

const inputSchema = z
  .object({
    type: z.enum(['string', 'number', 'integer', 'boolean']).default('string'),
    description: z.string().trim().max(300).default(''),
    required: z.boolean().default(false),
  })
  .strict();

const operationSchema = z
  .object({
    id: operationIdSchema,
    /** One call. A sequence uses `steps` instead. */
    op: callSchema.optional(),
    /** A short fixed sequence of calls, each able to use what the ones before it returned. */
    steps: z.array(stepSchema).min(2).max(4).optional(),
    /** For a sequence: the arguments its tool takes. */
    input: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), inputSchema).optional(),
    risk: operationRiskSchema,
    /** Its risk on a test-mode connection, when that's gentler: a charge that moves no money. */
    test: operationRiskSchema.optional(),
    summary: z.string().trim().max(300).optional(),
    /** A read operation that tells whether this one happened, for after an interruption. */
    verify: operationIdSchema.optional(),
    /** The argument that has the service send it later itself, when it can. */
    schedule: z
      .string()
      .regex(/^[a-z][\w.]{0,40}$/)
      .optional(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (!operation.op === !operation.steps) {
      ctx.addIssue({ code: 'custom', message: 'Give it one `op`, or `steps` for a sequence' });
    }
    if (operation.input && !operation.steps) {
      ctx.addIssue({ code: 'custom', message: '`input` is for a sequence of steps' });
    }
    const order = ['read', 'write', 'outbound'];
    if (operation.test && order.indexOf(operation.test) > order.indexOf(operation.risk)) {
      ctx.addIssue({
        code: 'custom',
        path: ['test'],
        message: "Its risk in test mode can't be higher than its usual one",
      });
    }
  });

export type ManifestOperation = z.infer<typeof operationSchema>;

const fileName = (name: string, extensions: string[]) =>
  z
    .string()
    .refine(
      (value) => extensions.some((ext) => value === `${name}.${ext}`),
      `Name it ${name}.${extensions[0]}`,
    );

const common = {
  id: integrationIdSchema,
  name: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(200),
  /** Every host it calls. Nothing else is reached, and the user sees these before installing. */
  hosts: z.array(z.string().toLowerCase().max(253)).max(20),
  guide: fileName('guide', ['md']).optional(),
};

const declarativeSchema = z
  .object({
    ...common,
    kind: z.literal('declarative').default('declarative'),
    hosts: common.hosts.min(1),
    /** Where its API is, if not the OpenAPI document's first server. `{setting}` fills in. */
    server: z.string().max(300).optional(),
    auth: authSchema,
    /** What the user fills in when connecting that isn't a secret. */
    settings: z.array(settingSchema).max(6).default([]),
    /** Headers sent with every call, such as an API version. */
    headers: z.record(headerName, z.string().max(200)).default({}),
    openapi: fileName('openapi', ['yaml', 'yml', 'json']).default(OPENAPI_FILE),
    /** For a service that answers 200 when a call failed: where it says so. */
    response: z
      .object({
        /** A field that's false when the call failed. */
        ok: z.string().max(80).optional(),
        /** Where the reason is. */
        error: z.string().max(80).optional(),
      })
      .strict()
      .default({}),
    /** A read operation that proves a credential works, called when connecting. */
    check: operationIdSchema.optional(),
    /** Where the check's response names the account, such as `email`. */
    account: z.string().max(80).optional(),
    operations: z.array(operationSchema).min(1).max(60),
  })
  .strict();

const envSchema = z
  .object({
    name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'Use a variable name such as API_KEY'),
    label: z.string().trim().min(1).max(60),
    hint: z.string().trim().max(300).default(''),
    secret: z.boolean().default(true),
    required: z.boolean().default(true),
  })
  .strict();

const mcpSchema = z
  .object({
    ...common,
    kind: z.literal('mcp'),
    /** The server: an npm package at one exact version, whose contents are pinned by checksum. */
    server: z
      .object({
        npm: z
          .string()
          .regex(
            /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,100}$/,
            'Use an npm package name',
          ),
        version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,40})?$/, 'Pin an exact version'),
        /** As the npm registry reports it for that version. */
        integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/, 'Use the sha512 integrity'),
        args: z.array(z.string().max(300)).max(20).default([]),
        env: z.array(envSchema).max(12).default([]),
        docker: z
          .object({
            image: z
              .string()
              .regex(/^[\w./:@-]{1,200}$/)
              .default('node:22-bookworm-slim'),
          })
          .strict()
          .default({ image: 'node:22-bookworm-slim' }),
      })
      .strict(),
  })
  .strict();

export type DeclarativeManifest = z.infer<typeof declarativeSchema>;
export type McpManifest = z.infer<typeof mcpSchema>;
export type Manifest = DeclarativeManifest | McpManifest;

export interface ManifestOptions {
  /**
   * Let it call this computer (`localhost`, over http). Only for an integration the user added
   * from a folder of their own; never for one from a marketplace or one being published.
   */
  allowLocal?: boolean;
}

/** Reads a manifest, and checks everything that can be checked without its OpenAPI document. */
export function parseManifest(text: string, options: ManifestOptions = {}): Manifest {
  let data: unknown;
  try {
    data = parseYaml(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new IntegrationError(
      `The manifest isn't valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new IntegrationError('The manifest is a YAML document of fields, starting with `id`');
  }
  const schema = (data as { kind?: unknown }).kind === 'mcp' ? mcpSchema : declarativeSchema;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new IntegrationError(`The manifest has problems:\n${z.prettifyError(parsed.error)}`);
  }
  const manifest = parsed.data;
  for (const host of manifest.hosts) {
    if (PUBLIC_HOST.test(host)) continue;
    if (options.allowLocal && LOCAL_HOST.test(host)) continue;
    throw new IntegrationError(
      LOCAL_HOST.test(host) || /^[\d.:[\]]+$/.test(host)
        ? `${host} is on this computer or an address, not a service's name. An integration names the public hosts it calls.`
        : `${host} isn't a host name. Write hosts such as api.example.com, or *.example.com.`,
    );
  }
  if (manifest.kind === 'declarative') checkDeclarative(manifest);
  return manifest;
}

function checkDeclarative(manifest: DeclarativeManifest): void {
  const ids = new Set<string>();
  for (const operation of manifest.operations) {
    if (ids.has(operation.id)) {
      throw new IntegrationError(`Two operations are called ${operation.id}`);
    }
    ids.add(operation.id);
  }
  const byId = new Map(manifest.operations.map((o) => [o.id, o]));
  for (const operation of manifest.operations) {
    if (!operation.verify) continue;
    const verify = byId.get(operation.verify);
    if (!verify || verify.risk !== 'read') {
      throw new IntegrationError(
        `${operation.id} is verified by ${operation.verify}, which must be one of its read operations`,
      );
    }
  }
  if (manifest.check) {
    const check = byId.get(manifest.check);
    if (!check || check.risk !== 'read' || check.steps) {
      throw new IntegrationError(
        `\`check: ${manifest.check}\` must name a read operation that makes one call`,
      );
    }
  }
  for (const name of Object.keys(manifest.headers)) {
    if (RESERVED_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === 'authorization') {
      throw new IntegrationError(`A manifest can't set the ${name} header`);
    }
  }
  const { auth } = manifest;
  if (auth.type === 'api_key') {
    if (auth.in === 'query' && !auth.name) {
      throw new IntegrationError('A key sent in the query says which parameter: `name`');
    }
    if (auth.in === 'header' && RESERVED_HEADERS.has((auth.header ?? '').toLowerCase())) {
      throw new IntegrationError(`A key can't go in the ${auth.header} header`);
    }
    if (!auth.format.includes('{secret}')) {
      throw new IntegrationError('`format` says where the key goes with {secret}');
    }
  }
  if (auth.type === 'oauth2') {
    if (!auth.format.includes('{secret}')) {
      throw new IntegrationError('`format` says where the token goes with {secret}');
    }
    if (RESERVED_HEADERS.has(auth.header.toLowerCase())) {
      throw new IntegrationError(`A token can't go in the ${auth.header} header`);
    }
    for (const url of [auth.authorize_url, auth.token_url]) {
      if (!url.startsWith('https://')) {
        throw new IntegrationError(`${url} must be an https:// address`);
      }
    }
  }
  const settings = new Set(manifest.settings.map((s) => s.id));
  for (const setting of manifest.settings) {
    try {
      new RegExp(setting.pattern);
    } catch {
      throw new IntegrationError(`The pattern for ${setting.id} isn't a regular expression`);
    }
  }
  for (const used of (manifest.server ?? '').matchAll(/\{(\w+)\}/g)) {
    if (!settings.has(used[1]!)) {
      throw new IntegrationError(
        `The server address uses {${used[1]}}, which isn't one of its settings`,
      );
    }
  }
}

/** Whether a host is one of those a manifest declares. `*.example.com` covers names under it. */
export function hostAllowed(host: string, hosts: readonly string[]): boolean {
  const name = host.toLowerCase();
  return hosts.some((pattern) =>
    pattern.startsWith('*.')
      ? name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1
      : name === pattern,
  );
}

/** Whether a host is on this computer, which only the user's own integrations may call. */
export function isLocalIntegrationHost(host: string): boolean {
  return LOCAL_HOST.test(host);
}

/**
 * Every host an integration reaches: those it calls, and for OAuth the one that hands out tokens.
 * The sign-in page itself opens in the user's browser, so it isn't one of them.
 */
export function allHosts(manifest: Manifest): string[] {
  const hosts = new Set(manifest.hosts);
  if (manifest.kind === 'declarative' && manifest.auth.type === 'oauth2') {
    hosts.add(new URL(manifest.auth.token_url).host.toLowerCase());
  }
  return [...hosts];
}

/** Which mode a credential is for, when the manifest can tell from how it starts. */
export function detectMode(auth: ManifestAuth, secret: string): 'test' | 'live' | null {
  if (auth.type === 'none' || !auth.modes) return null;
  if (auth.modes.test?.prefix.some((prefix) => secret.startsWith(prefix))) return 'test';
  if (auth.modes.live?.prefix.some((prefix) => secret.startsWith(prefix))) return 'live';
  return null;
}

/** Whether a manifest can tell test credentials from live ones. */
export function detectsMode(auth: ManifestAuth): boolean {
  return auth.type !== 'none' && auth.modes !== undefined && Object.keys(auth.modes).length > 0;
}
