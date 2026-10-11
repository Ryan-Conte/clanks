import {
  type OperationRisk,
  effectiveRisk,
  estimateTokens,
  integrationToolName,
} from '@clanks/core';
import {
  type DeclarativeManifest,
  GUIDE_TOKEN_BUDGET,
  IntegrationError,
  type ManifestOptions,
  type McpManifest,
  allHosts,
  hostAllowed,
  isLocalIntegrationHost,
  parseManifest,
} from './manifest';
import {
  type ApiCall,
  type JsonSchema,
  type ToolShape,
  findCall,
  parseOpenApi,
  toolShape,
} from './openapi';

/** An integration's files, as text. */
export interface IntegrationFiles {
  manifest: string;
  openapi?: string | null | undefined;
  guide?: string | null | undefined;
}

/** One call of an operation, ready to be made. */
export interface ResolvedStep {
  call: ApiCall;
  shape: ToolShape;
  /** A sequence's step: where its arguments come from. Null for an operation of one call. */
  with: Record<string, unknown> | null;
  save: Record<string, string>;
}

/** An operation with everything its tool needs. */
export interface ResolvedOperation {
  id: string;
  tool: string;
  summary: string;
  risk: OperationRisk;
  testRisk: OperationRisk;
  /** The tool's arguments, as a JSON schema for the model. */
  parameters: JsonSchema;
  steps: ResolvedStep[];
  verify: string | null;
  schedule: string | null;
}

export interface DeclarativeIntegration {
  kind: 'declarative';
  manifest: DeclarativeManifest;
  operations: ResolvedOperation[];
  guide: string;
  /** The OpenAPI document's own server, used when the manifest names none. */
  openapiServer: string | null;
  /** Every host it reaches, the token endpoint included. */
  hosts: string[];
}

export interface McpIntegration {
  kind: 'mcp';
  manifest: McpManifest;
  guide: string;
  hosts: string[];
}

export type Integration = DeclarativeIntegration | McpIntegration;

/**
 * Reads an integration from its files and checks it against itself: every operation is in the
 * OpenAPI document, its server is one of its hosts, and its guide fits the prompt.
 */
export function loadIntegration(
  files: IntegrationFiles,
  options: ManifestOptions = {},
): Integration {
  const manifest = parseManifest(files.manifest, options);
  const guide = (files.guide ?? '').replace(/\r\n?/g, '\n').trim();
  const guideTokens = estimateTokens(guide);
  if (guideTokens > GUIDE_TOKEN_BUDGET) {
    throw new IntegrationError(
      `The guide is about ${guideTokens} tokens. It goes into every prompt of a clank that uses the integration, so keep it under ${GUIDE_TOKEN_BUDGET}.`,
    );
  }
  if (manifest.kind === 'mcp') {
    return { kind: 'mcp', manifest, guide, hosts: manifest.hosts };
  }
  if (!files.openapi) {
    throw new IntegrationError(`The integration has no ${manifest.openapi}`);
  }
  const doc = parseOpenApi(files.openapi);
  checkServer(manifest, doc.server, options);

  const operations = manifest.operations.map((operation): ResolvedOperation => {
    const tool = integrationToolName(manifest.id, operation.id);
    if (tool.length > 64) {
      throw new IntegrationError(`${tool} is longer than the 64 characters a tool name can be`);
    }
    const base = {
      id: operation.id,
      tool,
      risk: operation.risk,
      testRisk: effectiveRisk(operation, 'test'),
      verify: operation.verify ?? null,
      schedule: operation.schedule ?? null,
    };
    if (operation.op) {
      const call = findCall(doc, operation.op);
      if (call.server) checkAddress(manifest, call.server, options);
      const shape = toolShape(call);
      return {
        ...base,
        summary: operation.summary ?? call.summary ?? operation.op,
        parameters: shape.parameters,
        steps: [{ call, shape, with: null, save: {} }],
      };
    }
    const input = operation.input ?? {};
    const known = new Set(Object.keys(input));
    const steps = operation.steps!.map((step, i): ResolvedStep => {
      const call = findCall(doc, step.call);
      if (call.server) checkAddress(manifest, call.server, options);
      const shape = toolShape(call);
      for (const name of Object.keys(step.with)) {
        if (!shape.places.has(name)) {
          throw new IntegrationError(
            `${operation.id}, step ${i + 1}: ${step.call} takes no \`${name}\``,
          );
        }
      }
      for (const used of JSON.stringify(step.with).matchAll(/\{([a-z][a-z0-9_]*)\}/g)) {
        if (!known.has(used[1]!)) {
          throw new IntegrationError(
            `${operation.id}, step ${i + 1} uses {${used[1]}}, which is neither one of its inputs nor saved by an earlier step`,
          );
        }
      }
      for (const name of Object.keys(step.save)) known.add(name);
      return { call, shape, with: step.with, save: step.save };
    });
    const required = Object.entries(input)
      .filter(([, field]) => field.required)
      .map(([name]) => name);
    return {
      ...base,
      summary: operation.summary ?? steps.map((s) => s.call.summary).join(', then '),
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(input).map(([name, field]) => [
            name,
            { type: field.type, ...(field.description ? { description: field.description } : {}) },
          ]),
        ),
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      },
      steps,
    };
  });

  if (manifest.check) {
    const check = operations.find((o) => o.id === manifest.check)!;
    const required = check.parameters.required;
    if (Array.isArray(required) && required.length > 0) {
      throw new IntegrationError(
        `\`check: ${manifest.check}\` needs arguments (${required.join(', ')}), so it can't be called to test a connection`,
      );
    }
  }
  return {
    kind: 'declarative',
    manifest,
    operations,
    guide,
    openapiServer: doc.server,
    hosts: allHosts(manifest),
  };
}

/** The API's own address must be one of the hosts the manifest declares, over https. */
function checkServer(
  manifest: DeclarativeManifest,
  openapiServer: string | null,
  options: ManifestOptions,
): void {
  const template = manifest.server ?? openapiServer;
  if (!template) {
    throw new IntegrationError(
      'Neither the manifest nor the OpenAPI document says where the API is: add `server`',
    );
  }
  checkAddress(manifest, template, options);
}

function checkAddress(
  manifest: DeclarativeManifest,
  template: string,
  options: ManifestOptions,
): void {
  let url: URL;
  try {
    url = new URL(template.replace(/\{\w+\}/g, 'x'));
  } catch {
    throw new IntegrationError(`${template} isn't an address`);
  }
  const local = options.allowLocal === true && isLocalIntegrationHost(url.host);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new IntegrationError(`${template} must be an https:// address`);
  }
  const declared = local
    ? hostAllowed(url.host, manifest.hosts) || hostAllowed(url.hostname, manifest.hosts)
    : url.port === '' && hostAllowed(url.hostname, manifest.hosts);
  if (!declared) {
    throw new IntegrationError(
      `The API is at ${url.host}, which isn't one of the hosts the manifest declares (${manifest.hosts.join(', ')})`,
    );
  }
}

/** How the app runs an MCP integration's server: the pinned package, on this computer or in Docker. */
export function mcpCommand(
  manifest: McpManifest,
  options: { docker: boolean },
): { command: string; args: string[] } {
  const { server } = manifest;
  const run = ['-y', `${server.npm}@${server.version}`, ...server.args];
  if (!options.docker) return { command: 'npx', args: run };
  return {
    command: 'docker',
    args: [
      'run',
      '--rm',
      '-i',
      // Each variable is passed by name, so its value comes from the environment, never the command.
      ...server.env.flatMap((variable) => ['-e', variable.name]),
      server.docker.image,
      'npx',
      ...run,
    ],
  };
}

/** `@scope/name@1.2.3`: what an MCP integration is pinned to. */
export function mcpPinned(manifest: McpManifest): string {
  return `${manifest.server.npm}@${manifest.server.version}`;
}
