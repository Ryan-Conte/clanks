import { parse as parseYaml } from 'yaml';
import { IntegrationError } from './manifest';

type Json = Record<string, unknown>;

/** A JSON schema, as OpenAPI writes them and as model APIs take them. */
export type JsonSchema = Record<string, unknown>;

/** An OpenAPI document, read but not yet looked into. */
export interface OpenApiDoc {
  raw: Json;
  /** The first server's address, if the document names one. */
  server: string | null;
}

export interface ApiParam {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: JsonSchema;
}

/** One call an integration can make, as its OpenAPI document describes it. */
export interface ApiCall {
  method: string;
  path: string;
  /** Where this call goes, when the document sends it somewhere other than its first server. */
  server: string | null;
  summary: string;
  params: ApiParam[];
  body: {
    encoding: 'json' | 'form';
    schema: JsonSchema;
    required: boolean;
  } | null;
}

const MAX_DEPTH = 5;
const DESCRIPTION_CHARS = 200;

/** Reads an OpenAPI 3 document, as YAML or JSON. */
export function parseOpenApi(text: string): OpenApiDoc {
  let raw: unknown;
  try {
    raw = parseYaml(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new IntegrationError(
      `The OpenAPI document isn't valid YAML or JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isObject(raw) || !isObject(raw.paths)) {
    throw new IntegrationError('The OpenAPI document has no `paths`');
  }
  if (typeof raw.openapi !== 'string' || !raw.openapi.startsWith('3.')) {
    throw new IntegrationError('The OpenAPI document must be version 3: `openapi: 3.0.3`');
  }
  const servers = Array.isArray(raw.servers) ? raw.servers : [];
  const first: unknown = servers[0];
  const server = isObject(first) && typeof first.url === 'string' ? first.url : null;
  return { raw, server };
}

/** Finds a call by method and path, with its parameters and body ready to use. */
export function findCall(doc: OpenApiDoc, call: string): ApiCall {
  const [method = '', path = ''] = call.split(' ');
  const paths = doc.raw.paths as Json;
  const item = paths[path];
  const operation = isObject(item) ? item[method.toLowerCase()] : undefined;
  if (!isObject(item) || !isObject(operation)) {
    throw new IntegrationError(`The OpenAPI document has no ${call}`);
  }

  const params: ApiParam[] = [];
  const listed: unknown[] = [
    ...(Array.isArray(item.parameters) ? (item.parameters as unknown[]) : []),
    ...(Array.isArray(operation.parameters) ? (operation.parameters as unknown[]) : []),
  ];
  for (const entry of listed) {
    const param = deref(doc, entry);
    if (!isObject(param) || typeof param.name !== 'string') continue;
    // Headers and cookies are the runtime's and the connection's, never the model's.
    if (param.in !== 'path' && param.in !== 'query') continue;
    const schema = resolveSchema(doc, param.schema ?? { type: 'string' }, 1, new Set());
    if (typeof param.description === 'string' && schema.description === undefined) {
      schema.description = brief(param.description);
    }
    const existing = params.findIndex((p) => p.name === param.name && p.in === param.in);
    const next: ApiParam = {
      name: param.name,
      in: param.in,
      required: param.in === 'path' || param.required === true,
      schema,
    };
    // The operation's own parameter wins over the path's.
    if (existing === -1) params.push(next);
    else params[existing] = next;
  }
  for (const used of path.matchAll(/\{([^}]+)\}/g)) {
    if (!params.some((p) => p.in === 'path' && p.name === used[1])) {
      params.push({ name: used[1]!, in: 'path', required: true, schema: { type: 'string' } });
    }
  }

  let body: ApiCall['body'] = null;
  const requestBody = deref(doc, operation.requestBody);
  if (isObject(requestBody) && isObject(requestBody.content)) {
    const content = requestBody.content;
    const json = content['application/json'];
    const form = content['application/x-www-form-urlencoded'];
    const chosen = isObject(json) ? json : isObject(form) ? form : null;
    if (!chosen) {
      throw new IntegrationError(
        `${call} takes ${Object.keys(content).join(', ')}, and only JSON and form bodies are supported`,
      );
    }
    body = {
      encoding: chosen === json ? 'json' : 'form',
      schema: resolveSchema(doc, chosen.schema ?? { type: 'object' }, 1, new Set()),
      required: requestBody.required === true,
    };
  }

  const summary = [operation.summary, operation.description]
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.trim())[0];
  return {
    method: method.toUpperCase(),
    path,
    server: ownServer(operation) ?? ownServer(item),
    summary: brief(summary ?? '', 300),
    params,
    body,
  };
}

/** A path's or an operation's own `servers`, which OpenAPI lets override the document's. */
function ownServer(holder: Json): string | null {
  const first: unknown = Array.isArray(holder.servers) ? holder.servers[0] : undefined;
  return isObject(first) && typeof first.url === 'string' ? first.url.replace(/\/+$/, '') : null;
}

/** Follows a `$ref` into the same document. Anything else comes back as it is. */
function deref(doc: OpenApiDoc, value: unknown, hops = 0): unknown {
  if (!isObject(value) || typeof value.$ref !== 'string') return value;
  if (hops > 8) throw new IntegrationError(`${value.$ref} refers to itself`);
  if (!value.$ref.startsWith('#/')) {
    throw new IntegrationError(`${value.$ref} points outside the document, which isn't supported`);
  }
  let target: unknown = doc.raw;
  for (const part of value.$ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    target = isObject(target) ? target[key] : undefined;
  }
  if (target === undefined) throw new IntegrationError(`${value.$ref} isn't in the document`);
  return deref(doc, target, hops + 1);
}

/** Keywords a model's tool schema keeps. The rest say nothing a model can use. */
const KEPT = new Set([
  'type',
  'description',
  'enum',
  'const',
  'default',
  'format',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'required',
  'additionalProperties',
]);

/**
 * A schema with its references followed and only what a model needs kept. Deep or circular
 * structures are cut off as "any value" rather than followed forever.
 */
export function resolveSchema(
  doc: OpenApiDoc,
  value: unknown,
  depth: number,
  seen: Set<string>,
): JsonSchema {
  if (isObject(value) && typeof value.$ref === 'string') {
    if (seen.has(value.$ref) || depth > MAX_DEPTH) return {};
    const next = new Set(seen).add(value.$ref);
    return resolveSchema(doc, deref(doc, value), depth, next);
  }
  if (!isObject(value)) return {};
  if (depth > MAX_DEPTH) return {};

  const out: JsonSchema = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!KEPT.has(key)) continue;
    if (key === 'description') {
      if (typeof entry === 'string') out.description = brief(entry);
    } else if (key === 'additionalProperties') {
      out.additionalProperties =
        typeof entry === 'boolean' ? entry : resolveSchema(doc, entry, depth + 1, seen);
    } else {
      out[key] = entry;
    }
  }
  if (Array.isArray(value.allOf)) {
    for (const part of value.allOf) {
      const resolved = resolveSchema(doc, part, depth, seen);
      const { properties, required, ...rest } = resolved;
      Object.assign(out, rest);
      if (isObject(properties)) {
        out.properties = { ...(isObject(out.properties) ? out.properties : {}), ...properties };
      }
      if (Array.isArray(required)) {
        const already = Array.isArray(out.required) ? (out.required as unknown[]) : [];
        out.required = [...new Set([...already, ...(required as unknown[])])];
      }
    }
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = value[key];
    if (Array.isArray(options)) {
      out[key] = options.slice(0, 6).map((o) => resolveSchema(doc, o, depth + 1, seen));
    }
  }
  if (isObject(value.properties)) {
    const properties: Json = isObject(out.properties) ? { ...out.properties } : {};
    for (const [name, property] of Object.entries(value.properties)) {
      if (isObject(property) && property.readOnly === true) continue;
      properties[name] = resolveSchema(doc, property, depth + 1, seen);
    }
    out.properties = properties;
    out.type ??= 'object';
  }
  if (value.items !== undefined) {
    out.items = resolveSchema(doc, value.items, depth + 1, seen);
    out.type ??= 'array';
  }
  return out;
}

/** How one of a tool's arguments reaches the service. */
export type ArgumentPlace = 'path' | 'query' | 'body';

export interface ToolShape {
  /** The tool's arguments, as a JSON schema for the model. */
  parameters: JsonSchema;
  /** Where each top-level argument goes. */
  places: Map<string, ArgumentPlace>;
  /**
   * The body is one argument called `body`, rather than its fields spread among the others: it
   * isn't an object, or one of its fields is named like a parameter.
   */
  nested: boolean;
}

/**
 * The arguments a call's tool takes: its path and query parameters, and its body's fields beside
 * them, which small models fill in more reliably than a nested object.
 */
export function toolShape(call: ApiCall): ToolShape {
  const properties: Json = {};
  const required: string[] = [];
  const places = new Map<string, ArgumentPlace>();
  for (const param of call.params) {
    properties[param.name] = param.schema;
    places.set(param.name, param.in);
    if (param.required) required.push(param.name);
  }
  let nested = false;
  if (call.body) {
    const { schema } = call.body;
    const fields = isObject(schema.properties) ? schema.properties : null;
    const clash = fields !== null && Object.keys(fields).some((name) => places.has(name));
    if (!fields || clash || schema.type !== 'object') {
      nested = true;
      properties.body = schema;
      places.set('body', 'body');
      if (call.body.required) required.push('body');
    } else {
      for (const [name, field] of Object.entries(fields)) {
        properties[name] = field;
        places.set(name, 'body');
      }
      if (Array.isArray(schema.required)) {
        required.push(...schema.required.filter((r): r is string => typeof r === 'string'));
      }
    }
  }
  return {
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
      additionalProperties: false,
    },
    places,
    nested,
  };
}

function brief(text: string, max = DESCRIPTION_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
