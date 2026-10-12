import {
  type ConnectionMode,
  type IntegrationApproval,
  type OperationRisk,
  effectiveRisk,
} from '@clanks/core';
import { LOW_RISK, type Risk, ToolArgumentsError, ToolFailure, type ToolSpec } from '@clanks/tools';
import type { DeclarativeIntegration, ResolvedOperation, ResolvedStep } from './load';
import type { JsonSchema } from './openapi';
import {
  type BuiltRequest,
  type Credential,
  RequestFailure,
  buildRequest,
  describeRequest,
  errorMessage,
  fit,
  parseJson,
  pick,
  redact,
  secretsOf,
  sendRequest,
  serverBase,
  signRequest,
  trimJson,
} from './request';

/** A connected account, as an operation's tool uses it. */
export interface ToolConnection {
  id: string;
  /** What the user calls it. */
  label: string;
  mode: ConnectionMode;
  settings: Record<string, string>;
  /** The hosts the user agreed its credential may go to. */
  hosts: readonly string[];
  /** The user wrote the integration for a server of their own, so it may call this computer. */
  allowLocal: boolean;
  /** Reads the credential from the keychain, renewing an OAuth token that has run out. */
  credential(signal: AbortSignal): Promise<Credential>;
}

type Args = Record<string, unknown>;

/** The risk a call carries on this connection. */
export function riskOn(operation: ResolvedOperation, mode: ConnectionMode): OperationRisk {
  return effectiveRisk({ risk: operation.risk, test: operation.testRisk }, mode);
}

/** One tool per operation: `int_<integration>_<operation>`, calling the service as the connection. */
export function integrationTools(
  integration: DeclarativeIntegration,
  connection: ToolConnection,
  deps: { fetch: typeof fetch; lookup?: ((host: string) => Promise<string[]>) | undefined },
): ToolSpec<Args>[] {
  const { manifest } = integration;
  const where = `${manifest.name} (${connection.label}, ${connection.mode} mode)`;
  const hostOf = () => {
    try {
      return new URL(serverBase(manifest, integration.openapiServer, connection.settings)).host;
    } catch {
      return manifest.hosts[0] ?? '';
    }
  };

  return integration.operations.map((operation): ToolSpec<Args> => {
    const risk = riskOn(operation, connection.mode);
    const about: IntegrationApproval = {
      name: manifest.name,
      account: connection.label,
      mode: connection.mode,
      host: hostOf(),
      risk,
    };

    /** The requests a call would make, as far as they're known before anything is sent. */
    const planned = (args: Args): string => {
      const base = serverBase(manifest, integration.openapiServer, connection.settings);
      if (operation.steps.length === 1) {
        const [step] = operation.steps as [ResolvedStep];
        return describeRequest(
          buildRequest({
            call: step.call,
            shape: step.shape,
            args,
            base: step.call.server ?? base,
            headers: {},
          }),
        );
      }
      return operation.steps
        .map((step, i) => {
          const filled = fillArgs(step.with ?? {}, args, false);
          return `${i + 1}. ${step.call.method} ${step.call.server ?? base}${step.call.path}\n${JSON.stringify(filled, null, 2)}`;
        })
        .join('\n');
    };

    return {
      name: operation.tool,
      description:
        `${manifest.name}: ${operation.summary}${risk === 'read' ? '' : risk === 'outbound' ? ' Waits for approval every time.' : ' Changes data there.'}`.slice(
          0,
          1024,
        ),
      parameters: operation.parameters,
      parse: (raw) => parseArgs(operation.parameters, raw),
      needs: [],
      mutates: false,
      // It asks every time: no rule, setting or policy lets an outbound call through unasked.
      ...(risk === 'outbound' ? { locked: true } : {}),
      label: () => `Calling ${manifest.name}: \`${operation.id}\``,
      approval: (args) => {
        let subject: string;
        try {
          subject = planned(args);
        } catch {
          subject = `${operation.id} ${JSON.stringify(args, null, 2)}`;
        }
        return { kind: 'tool', subject, pattern: '*', integration: about };
      },
      risk: (): Risk => {
        if (risk === 'read') return LOW_RISK;
        if (risk === 'write') {
          return { level: 'high', reason: `It changes data in ${where}` };
        }
        return {
          level: 'high',
          reason:
            connection.mode === 'live' && operation.risk !== 'outbound'
              ? `${connection.label} is a live ${manifest.name} account, where every change asks`
              : `It can spend money, publish, delete or contact people through ${where}`,
        };
      },
      run: (args, ctx) =>
        runOperation(integration, operation, connection, args, {
          fetch: deps.fetch,
          lookup: deps.lookup,
          signal: ctx.signal,
          maxChars: ctx.maxChars,
        }),
    };
  });
}

/** What a call came to: what the model reads, and what the service actually sent. */
export interface OperationResult {
  content: string;
  error?: boolean;
  /** Everything that came back, for the activity log. */
  output: string;
  /** The last call's response as JSON, when it was JSON. */
  body?: unknown;
  /** For a call the service turned down: its own words for why, without the advice for a clank. */
  reason?: string;
  /** For a call the service turned down: the status it answered with. */
  status?: number;
}

/**
 * A call that got no answer: the service couldn't be reached, or the connection dropped. One that
 * changes things may or may not have gone through.
 */
export class OperationUnanswered extends ToolFailure {
  constructor(message: string) {
    super(message);
    this.name = 'OperationUnanswered';
  }
}

/**
 * Makes an operation's calls as a connection. Its credential is read here, used to sign each
 * request, and taken out of everything that's returned.
 */
export async function runOperation(
  integration: DeclarativeIntegration,
  operation: ResolvedOperation,
  connection: ToolConnection,
  args: Args,
  options: {
    fetch: typeof fetch;
    signal: AbortSignal;
    maxChars: number;
    lookup?: ((host: string) => Promise<string[]>) | undefined;
  },
): Promise<OperationResult> {
  const { manifest } = integration;
  const where = `${manifest.name} (${connection.label}, ${connection.mode} mode)`;
  const risk = riskOn(operation, connection.mode);
  const credential = await connection.credential(options.signal);
  const secrets = secretsOf(credential);
  const clean = (text: string) => redact(text, secrets);
  const base = serverBase(manifest, integration.openapiServer, connection.settings);
  const saved: Args = {};
  const done: string[] = [];
  let last = '';
  let lastBody: unknown;
  for (const [i, step] of operation.steps.entries()) {
    const stepArgs = step.with ? fillArgs(step.with, { ...args, ...saved }, true) : args;
    const named = `${step.call.method} ${step.call.path}`;
    let request: BuiltRequest;
    try {
      request = signRequest(
        buildRequest({
          call: step.call,
          shape: step.shape,
          args: stepArgs,
          base: step.call.server ?? base,
          headers: manifest.headers,
        }),
        manifest.auth,
        credential,
      );
    } catch (error) {
      if (error instanceof RequestFailure) {
        throw new ToolFailure(clean(`${error.message}.${alreadyDone(done)}`));
      }
      throw error;
    }
    let reply;
    try {
      reply = await sendRequest(request, {
        hosts: connection.hosts,
        allowLocal: connection.allowLocal,
        fetch: options.fetch,
        lookup: options.lookup,
        signal: options.signal,
      });
    } catch (error) {
      if (!(error instanceof RequestFailure)) throw error;
      // A call that changes things and got no answer may still have happened.
      const unsure =
        risk !== 'read' && error.status === null && /Couldn't reach/.test(error.message)
          ? ` It may or may not have gone through: ${operation.verify ? `check with int_${manifest.id}_${operation.verify}` : 'check'} before you try again.`
          : '';
      const message = clean(`${error.message}.${unsure}${alreadyDone(done)}`);
      throw error.status === null ? new OperationUnanswered(message) : new ToolFailure(message);
    }
    const body = parseJson(reply);
    const failed =
      reply.status >= 400 ||
      (manifest.response.ok !== undefined && pick(body, manifest.response.ok) === false);
    if (failed) {
      const why =
        manifest.response.error !== undefined &&
        typeof pick(body, manifest.response.error) === 'string'
          ? String(pick(body, manifest.response.error))
          : errorMessage(body, reply.text);
      const hint =
        reply.status === 401 || reply.status === 403
          ? " The connection's credential may have been revoked or lack permission. Say so; you can't fix it."
          : '';
      return {
        content: clean(
          `${where} turned ${named} down (${reply.status}): ${why}.${hint}${alreadyDone(done)}`,
        ),
        error: true,
        output: clean(reply.text),
        reason: clean(why),
        status: reply.status,
      };
    }
    for (const [name, path] of Object.entries(step.save)) {
      const value = pick(body, path);
      if (value === undefined || value === null) {
        return {
          content: clean(
            `${named} answered, but without \`${path}\`, which the next step needs.${alreadyDone([...done, named])}`,
          ),
          error: true,
          output: clean(reply.text),
        };
      }
      saved[name] = value;
    }
    done.push(named);
    lastBody = body;
    const shown =
      body === undefined
        ? reply.text.trim() || '(no content)'
        : JSON.stringify(trimJson(body) ?? {}, null, 1);
    last = `${where} answered ${reply.status} to ${named}${reply.cut ? ' (a long response, cut)' : ''}.${
      i < operation.steps.length - 1 ? '' : `\n${shown}`
    }`;
  }
  return { content: fit(clean(last), options.maxChars), output: clean(last), body: lastBody };
}

function alreadyDone(done: string[]): string {
  return done.length > 0
    ? ` These already went through and weren't undone: ${done.join(', ')}.`
    : '';
}

/**
 * A step's arguments, with `{name}` replaced by one of the tool's arguments or a value an earlier
 * step saved. A value that is exactly `{name}` keeps the type of what it stands for.
 */
function fillArgs(template: Record<string, unknown>, scope: Args, strict: boolean): Args {
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = /^\{([a-z][a-z0-9_]*)\}$/.exec(value);
      if (whole) {
        const found = scope[whole[1]!];
        if (found === undefined && strict) return undefined;
        return found === undefined ? value : found;
      }
      return value.replace(/\{([a-z][a-z0-9_]*)\}/g, (match, name: string) => {
        const found = scope[name];
        return found === undefined || found === null ? (strict ? '' : match) : scalarText(found);
      });
    }
    if (Array.isArray(value)) return value.map(fill).filter((v) => v !== undefined);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .map(([key, entry]) => [key, fill(entry)] as const)
          .filter(([, entry]) => entry !== undefined),
      );
    }
    return value;
  };
  return fill(template) as Args;
}

function scalarText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Checks a tool's arguments against its schema, forgiving the ways small models write them: an
 * object as JSON in a string, a number as text, a value wrapped as `{ "value": … }`.
 */
export function parseArgs(parameters: JsonSchema, raw: unknown): Args {
  let value: unknown = raw ?? {};
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      // Falls through to the check below.
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolArgumentsError('The arguments must be a JSON object');
  }
  const properties = (parameters.properties ?? {}) as Record<string, JsonSchema>;
  const names = Object.keys(properties);
  const args: Args = {};
  for (const [name, given] of Object.entries(value)) {
    const schema = properties[name];
    if (!schema) {
      throw new ToolArgumentsError(
        `There's no argument called \`${name}\`. ${names.length > 0 ? `This tool takes: ${names.join(', ')}.` : 'This tool takes no arguments.'}`,
      );
    }
    if (given === null || given === undefined || given === '') continue;
    args[name] = coerce(name, schema, given);
  }
  const required = Array.isArray(parameters.required) ? (parameters.required as string[]) : [];
  const missing = required.filter((name) => args[name] === undefined);
  if (missing.length > 0) {
    throw new ToolArgumentsError(
      `${missing.map((m) => `\`${m}\``).join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`,
    );
  }
  return args;
}

function coerce(name: string, schema: JsonSchema, given: unknown): unknown {
  const type = typeof schema.type === 'string' ? schema.type : null;
  let value = given;
  const structured = type === 'object' || type === 'array';
  if (
    !structured &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'value' in value
  ) {
    value = value.value;
  }
  if (structured && typeof value === 'string' && /^\s*[[{]/.test(value)) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new ToolArgumentsError(
        `\`${name}\` must be ${type === 'array' ? 'a list' : 'an object'}`,
      );
    }
  }
  if (type === 'array' && !Array.isArray(value)) value = [value];
  if (type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new ToolArgumentsError(`\`${name}\` must be an object`);
  }
  if (type === 'integer' || type === 'number') {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      throw new ToolArgumentsError(`\`${name}\` must be a number`);
    }
    if (type === 'integer' && !Number.isInteger(number)) {
      throw new ToolArgumentsError(`\`${name}\` must be a whole number`);
    }
    value = number;
  }
  if (type === 'boolean' && typeof value === 'string') {
    if (!/^(true|false)$/i.test(value)) {
      throw new ToolArgumentsError(`\`${name}\` must be true or false`);
    }
    value = value.toLowerCase() === 'true';
  }
  if (type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
    value = String(value);
  }
  if (type === 'string' && typeof value !== 'string') {
    throw new ToolArgumentsError(`\`${name}\` must be text`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new ToolArgumentsError(
      `\`${name}\` must be one of: ${schema.enum.map((e) => String(e)).join(', ')}`,
    );
  }
  return value;
}
