import {
  type DeclarativeManifest,
  IntegrationError,
  hostAllowed,
  isLocalIntegrationHost,
} from './manifest';
import type { ApiCall, ToolShape } from './openapi';

/** A request ready to send, but for its credential. */
export interface BuiltRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/** What signs a connection's requests. Read from the keychain; never shown to a model. */
export type Credential =
  | { kind: 'none' }
  | { kind: 'api_key'; secret: string }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'oauth2'; accessToken: string };

/** A call the service turned down, or that never reached it, worded for the clank. */
export class RequestFailure extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'RequestFailure';
  }
}

const TIMEOUT_MS = 60_000;
/** The most of a response that's read. More than any model could use. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** The address an integration's calls start from, with the connection's settings filled in. */
export function serverBase(
  manifest: DeclarativeManifest,
  openapiServer: string | null,
  settings: Record<string, string>,
): string {
  const template = manifest.server ?? openapiServer;
  if (!template) {
    throw new IntegrationError(
      'Neither the manifest nor the OpenAPI document says where the API is: add `server`',
    );
  }
  const filled = template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const setting = manifest.settings.find((s) => s.id === name);
    const value = settings[name] ?? '';
    if (!setting) throw new IntegrationError(`The server address uses {${name}}, which isn't set`);
    if (!new RegExp(setting.pattern).test(value)) {
      throw new IntegrationError(`"${value}" isn't a valid ${setting.label.toLowerCase()}`);
    }
    return value;
  });
  return filled.replace(/\/+$/, '');
}

/**
 * Builds the request for one call from a tool's arguments. Path values are escaped, so an argument
 * can never change which host or path is called.
 */
export function buildRequest(input: {
  call: ApiCall;
  shape: ToolShape;
  args: Record<string, unknown>;
  base: string;
  headers: Record<string, string>;
}): BuiltRequest {
  const { call, shape, args, base } = input;
  let path = call.path;
  const query: [string, string][] = [];
  const body: Record<string, unknown> = {};
  let wholeBody: unknown;
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const place = shape.places.get(name);
    if (place === 'path') {
      const text = scalar(value);
      if (text === '' || text === '.' || text === '..') {
        throw new RequestFailure(`\`${name}\` can't be "${text}"`);
      }
      path = path.replace(`{${name}}`, encodeURIComponent(text));
    } else if (place === 'query') {
      query.push(...flatten(name, value));
    } else if (place === 'body') {
      if (shape.nested) wholeBody = value;
      else body[name] = value;
    }
  }
  const missing = /\{([^}]+)\}/.exec(path);
  if (missing) throw new RequestFailure(`\`${missing[1]}\` is required`);

  const url = new URL(`${base}${path}`);
  for (const [name, value] of query) url.searchParams.append(name, value);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'clanks',
    ...input.headers,
  };
  let text: string | null = null;
  if (call.body) {
    const payload = shape.nested ? wholeBody : body;
    const empty =
      payload === undefined ||
      (typeof payload === 'object' && payload !== null && Object.keys(payload).length === 0);
    if (!empty || call.body.required || call.method !== 'GET') {
      if (call.body.encoding === 'json') {
        headers['Content-Type'] = 'application/json';
        text = JSON.stringify(payload ?? {});
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        text = new URLSearchParams(flatten('', payload ?? {}, true)).toString();
      }
    }
  }
  return { method: call.method, url: url.toString(), headers, body: text };
}

/**
 * A value as form fields, the way most form-encoded APIs take nested ones: `a[b]=1`, and
 * `list[0][id]=x` for a list of objects. In a body every list is numbered; in a query a plain
 * list repeats its name, which is what OpenAPI's default style means.
 */
function flatten(name: string, value: unknown, numbered = false): [string, string][] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown, i) =>
      numbered || (typeof item === 'object' && item !== null)
        ? flatten(`${name}[${i}]`, item, numbered)
        : flatten(name, item, numbered),
    );
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) =>
      flatten(name ? `${name}[${key}]` : key, entry, numbered),
    );
  }
  return name ? [[name, scalar(value)]] : [];
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** A request as the user reads it before approving: what goes where, without the credential. */
export function describeRequest(request: BuiltRequest): string {
  const lines = [`${request.method} ${request.url}`];
  if (request.body) {
    if (request.headers['Content-Type'] === 'application/json') {
      try {
        lines.push(JSON.stringify(JSON.parse(request.body), null, 2));
      } catch {
        lines.push(request.body);
      }
    } else {
      for (const [name, value] of new URLSearchParams(request.body)) {
        lines.push(`${name} = ${value}`);
      }
    }
  }
  return lines.join('\n');
}

/** Signs a request with a connection's credential, the way its manifest says. */
export function signRequest(
  request: BuiltRequest,
  auth: DeclarativeManifest['auth'],
  credential: Credential,
): BuiltRequest {
  if (auth.type === 'none' || credential.kind === 'none') return request;
  const headers = { ...request.headers };
  if (auth.type === 'basic' && credential.kind === 'basic') {
    const pair = Buffer.from(`${credential.username}:${credential.password}`, 'utf8');
    headers.Authorization = `Basic ${pair.toString('base64')}`;
    return { ...request, headers };
  }
  const secret =
    credential.kind === 'api_key'
      ? credential.secret
      : credential.kind === 'oauth2'
        ? credential.accessToken
        : '';
  if (!secret) throw new RequestFailure("This connection's credential doesn't fit its integration");
  if (/[\r\n]/.test(secret)) throw new RequestFailure('The credential has a line break in it');
  if (auth.type === 'api_key' && auth.in === 'query') {
    const url = new URL(request.url);
    url.searchParams.set(auth.name!, auth.format.replace('{secret}', secret));
    return { ...request, url: url.toString() };
  }
  if (auth.type === 'api_key' || auth.type === 'oauth2') {
    headers[auth.header ?? 'Authorization'] = auth.format.replace('{secret}', secret);
  }
  return { ...request, headers };
}

/** Everything in a credential that must never appear in what a model or a log sees. */
export function secretsOf(credential: Credential): string[] {
  switch (credential.kind) {
    case 'api_key':
      return [credential.secret];
    case 'basic':
      return [
        credential.password,
        Buffer.from(`${credential.username}:${credential.password}`).toString('base64'),
      ];
    case 'oauth2':
      return [credential.accessToken];
    default:
      return [];
  }
}

export interface SendOptions {
  /** The hosts this connection's credential may go to. */
  hosts: readonly string[];
  /** Calls to this computer are fine: the user wrote the integration for their own server. */
  allowLocal: boolean;
  fetch: typeof fetch;
  signal: AbortSignal;
  timeoutMs?: number;
  /**
   * Looks a host's addresses up before it's called, so a public name that points at this computer
   * or the local network is refused: an integration from somewhere else has no business there.
   */
  lookup?: ((host: string) => Promise<string[]>) | undefined;
}

/**
 * Whether an address is this computer's or the local network's: loopback, private ranges,
 * link-local, and their IPv6 counterparts.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  const v4 = mapped ?? (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null);
  if (v4) {
    const [a = 0, b = 0] = v4.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

export interface Reply {
  status: number;
  contentType: string;
  text: string;
  /** More came back than was read. */
  cut: boolean;
  host: string;
}

/** Refuses any address that isn't one of the integration's declared hosts, over https. */
export function assertAllowed(url: URL, options: Pick<SendOptions, 'hosts' | 'allowLocal'>): void {
  const local = options.allowLocal && isLocalIntegrationHost(url.host);
  if (url.username || url.password) {
    throw new RequestFailure("The address has a login in it, which isn't allowed");
  }
  if (local) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new RequestFailure(`${url.protocol} isn't a web address`);
    }
    if (!hostAllowed(url.host, options.hosts) && !hostAllowed(url.hostname, options.hosts)) {
      throw new RequestFailure(`${url.host} isn't one of the hosts this integration declares`);
    }
    return;
  }
  if (url.protocol !== 'https:') {
    throw new RequestFailure(`Integrations only call https addresses, not ${url.protocol}//`);
  }
  if (url.port !== '') {
    throw new RequestFailure(`${url.host} names a port, which integrations don't call`);
  }
  if (!hostAllowed(url.hostname, options.hosts)) {
    throw new RequestFailure(`${url.hostname} isn't one of the hosts this integration declares`);
  }
}

/**
 * Sends a signed request, only ever to a declared host. A redirect is followed only to another
 * declared host, and loses the credential if it leaves the one it was signed for.
 */
export async function sendRequest(request: BuiltRequest, options: SendOptions): Promise<Reply> {
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
  ]);
  let current = request;
  for (let hop = 0; ; hop++) {
    const url = new URL(current.url);
    assertAllowed(url, options);
    if (options.lookup && !(options.allowLocal && isLocalIntegrationHost(url.host))) {
      const addresses = await options.lookup(url.hostname).catch(() => [] as string[]);
      if (addresses.some(isPrivateAddress)) {
        throw new RequestFailure(
          `${url.hostname} points at this computer or the local network, which integrations don't call`,
        );
      }
    }
    let response: Response;
    try {
      response = await options.fetch(current.url, {
        method: current.method,
        headers: current.headers,
        ...(current.body !== null ? { body: current.body } : {}),
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (options.signal.aborted) throw error;
      const why =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'it took too long to answer'
          : error instanceof Error
            ? causeOf(error)
            : String(error);
      throw new RequestFailure(`Couldn't reach ${url.host}: ${why}`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new RequestFailure(`${url.host} keeps redirecting`);
      const next = new URL(response.headers.get('location')!, url);
      assertAllowed(next, options);
      if (current.method !== 'GET') {
        throw new RequestFailure(
          `${url.host} redirected a ${current.method} to ${next.host}${next.pathname}, which isn't followed. Nothing was changed.`,
        );
      }
      const headers = { ...current.headers };
      if (next.host !== url.host) {
        for (const name of Object.keys(headers)) {
          if (!['accept', 'user-agent'].includes(name.toLowerCase())) delete headers[name];
        }
      }
      current = { method: 'GET', url: next.toString(), headers, body: null };
      continue;
    }
    const { text, cut } = await readText(response);
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text,
      cut,
      host: url.host,
    };
  }
}

async function readText(response: Response): Promise<{ text: string; cut: boolean }> {
  if (!response.body) return { text: '', cut: false };
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= MAX_RESPONSE_BYTES) {
      cut = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), cut };
}

function causeOf(error: Error): string {
  const cause = error.cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return error.message;
}

/** A value inside a response, by a path such as `data.0.id`. Undefined when it isn't there. */
export function pick(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.replace(/^\$\.?/, '').split('.')) {
    if (part === '') continue;
    if (Array.isArray(current)) current = current[Number(part)];
    else if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else return undefined;
  }
  return current;
}

/** Field names whose values are credentials, whatever service they come from. */
const SECRET_FIELD =
  /(^|_)(secret|password|passwd|token|api_?key|private_?key|authorization|credential)s?($|_)/i;

const MAX_ITEMS = 25;
const MAX_STRING = 600;

/**
 * A response's JSON cut down to what a model can use: long lists and strings shortened, empty
 * values dropped, and anything that looks like a credential hidden.
 */
export function trimJson(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}… (${value.length - MAX_STRING} more characters)`
      : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= 8) return '(more, cut)';
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ITEMS).map((item) => trimJson(item, depth + 1) ?? null);
    if (value.length > MAX_ITEMS) kept.push(`(${value.length - MAX_ITEMS} more, not shown)`);
    return kept;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD.test(key) && typeof entry === 'string' && entry !== '') {
      out[key] = '[hidden]';
      continue;
    }
    const trimmed = trimJson(entry, depth + 1);
    if (trimmed === undefined) continue;
    if (Array.isArray(trimmed) && trimmed.length === 0) continue;
    out[key] = trimmed;
  }
  return out;
}

/** Takes every copy of a credential out of some text. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** Text cut to fit, keeping its start and its end, with a note of what went. */
export function fit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(0, maxChars - head - 80);
  return `${text.slice(0, head)}\n… (${text.length - head - tail} characters cut) …\n${tail > 0 ? text.slice(-tail) : ''}`;
}

/** Why a service turned a call down, from the shapes error replies usually take. */
export function errorMessage(body: unknown, text: string): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    const error = record.error;
    const candidates = [
      typeof error === 'object' && error !== null
        ? (error as Record<string, unknown>).message
        : null,
      typeof error === 'string' ? error : null,
      record.message,
      record.error_description,
      record.detail,
      Array.isArray(record.errors) ? JSON.stringify(record.errors).slice(0, 400) : null,
    ];
    const found = candidates.find((c): c is string => typeof c === 'string' && c.trim() !== '');
    if (found) return found.trim().slice(0, 600);
  }
  const line = text.replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, 300) : 'no reason given';
}

export function parseJson(reply: Reply): unknown {
  if (!reply.text.trim()) return undefined;
  if (!/json/i.test(reply.contentType) && !/^\s*[[{]/.test(reply.text)) return undefined;
  try {
    return JSON.parse(reply.text) as unknown;
  } catch {
    return undefined;
  }
}
