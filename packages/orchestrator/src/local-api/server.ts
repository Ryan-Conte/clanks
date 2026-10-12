import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  ChatUsage,
  FinishReason,
  LoadedModelStatus,
  PullStatus,
  ToolCall,
} from '@clanks/core';
import type { LibraryItem } from '@clanks/models';
import { BUILTIN_PROVIDER, ProviderError, type ProviderRegistry } from '@clanks/providers';
import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

/** What the local API needs from the model manager. */
export interface LocalApiModels {
  library(): LibraryItem[];
  loaded(): LoadedModelStatus[];
  pull(ref: string): PullStatus;
  pulls(): PullStatus[];
}

export interface LocalApiOptions {
  providers: ProviderRegistry;
  models: LocalApiModels;
}

export interface LocalApiStatus {
  running: boolean;
  /** Where other apps reach it, such as `http://127.0.0.1:11434`. */
  url: string | null;
  error: string | null;
}

/** Requests bigger than this are refused. Prompts are text, so it's generous. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Serves the models clanks pulled to other apps on 127.0.0.1: OpenAI-compatible `/v1/models` and
 * `/v1/chat/completions`, and the common Ollama endpoints, so editors and scripts that speak
 * either can use them. Requests go through the built-in provider like any clank's, so they wait
 * for the same loaded models rather than fight them for memory.
 */
export class LocalApi {
  private server: Server | null = null;
  private port: number | null = null;
  private error: string | null = null;

  constructor(private readonly options: LocalApiOptions) {}

  status(): LocalApiStatus {
    const address = this.server?.address() as AddressInfo | null | undefined;
    return {
      running: Boolean(address),
      url: address ? `http://127.0.0.1:${address.port}` : null,
      error: this.error,
    };
  }

  /** Starts, stops or moves the server to match the settings. Port 0 picks a free one. */
  async apply(enabled: boolean, port: number): Promise<LocalApiStatus> {
    if (!enabled) {
      await this.stop();
      this.error = null;
      return this.status();
    }
    if (this.server && this.port === port) return this.status();
    await this.stop();
    const server = createServer((req, res) => void this.handle(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        // Loopback only: nothing else on the network can reach it.
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      this.server = server;
      this.port = port;
      this.error = null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.error =
        code === 'EADDRINUSE'
          ? `Port ${port} is already in use${port === 11434 ? ', perhaps by Ollama' : ''}. Pick another port.`
          : `The local API couldn't start: ${(error as Error).message}`;
    }
    return this.status();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ollama = req.url?.startsWith('/api/') ?? false;
    try {
      // A web page could otherwise reach a loopback server through the user's browser: by a
      // hostname it rebinds to 127.0.0.1, or straight from its own origin.
      if (!allowedHost(req.headers.host)) return fail(res, 403, 'Host not allowed', ollama);
      if (!allowedOrigin(req.headers.origin)) return fail(res, 403, 'Origin not allowed', ollama);

      const path = (req.url ?? '/').split('?')[0];
      const route = `${req.method} ${path}`;
      switch (route) {
        case 'GET /':
        case 'HEAD /':
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          return void res.end(req.method === 'HEAD' ? undefined : 'clanks is running');
        case 'GET /v1/models':
          return json(res, 200, {
            object: 'list',
            data: this.models().map((m) => ({
              id: m.id,
              object: 'model',
              created: Math.floor(+m.pulledAt / 1000),
              owned_by: 'clanks',
            })),
          });
        case 'POST /v1/chat/completions':
          return await this.openAIChat(req, res);
        case 'GET /api/tags':
          return json(res, 200, { models: this.models().map(ollamaModel) });
        case 'GET /api/ps':
          return json(res, 200, {
            models: this.options.models
              .loaded()
              .filter((l) => l.state === 'ready')
              .flatMap((l) => {
                const model = this.models().find((m) => m.id === l.modelId);
                if (!model) return [];
                return [
                  {
                    ...ollamaModel(model),
                    expires_at: (
                      l.idleUnloadAt ?? new Date(Date.now() + 365 * 86_400_000)
                    ).toISOString(),
                    size_vram: l.memory?.gpuBytes ?? 0,
                  },
                ];
              }),
          });
        case 'POST /api/chat':
          return await this.ollamaChat(req, res);
        case 'POST /api/generate':
          return await this.ollamaGenerate(req, res);
        case 'POST /api/pull':
          return await this.ollamaPull(req, res);
        default:
          return fail(res, 404, `No route for ${route}`, ollama);
      }
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof RequestError) return fail(res, error.status, error.message, ollama);
      if (error instanceof ProviderError) return fail(res, 500, error.message, ollama);
      console.error('The local API failed', error);
      return fail(res, 500, 'Something went wrong', ollama);
    }
  }

  private models(): LibraryItem[] {
    return this.options.models.library().filter((m) => !m.missing);
  }

  private requireModel(id: string): void {
    if (!this.models().some((m) => m.id === id)) {
      throw new RequestError(404, `model '${id}' not found. Pull it in clanks first.`);
    }
  }

  /** The model's reply as events, stopped if the client hangs up first. */
  private stream(res: ServerResponse, request: ChatRequest): AsyncIterable<ChatEvent> {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    return this.options.providers.stream(BUILTIN_PROVIDER, request, controller.signal);
  }

  private async openAIChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = parse(openAIChatSchema, await readBody(req));
    this.requireModel(body.model);
    const request: ChatRequest = {
      model: body.model,
      messages: body.messages.map(fromOpenAIMessage),
      ...(body.tools?.length ? { tools: body.tools.map((t) => t.function) } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...((body.max_completion_tokens ?? body.max_tokens) !== undefined
        ? { maxTokens: (body.max_completion_tokens ?? body.max_tokens)! }
        : {}),
    };
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const base = { id, created, model: body.model };

    if (!body.stream) {
      const reply = await collect(this.stream(res, request));
      return json(res, 200, {
        ...base,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: reply.text,
              ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
              ...(reply.calls.length ? { tool_calls: reply.calls.map(openAIToolCall) } : {}),
            },
            finish_reason: openAIFinish(reply.finish),
          },
        ],
        ...(reply.usage ? { usage: openAIUsage(reply.usage) } : {}),
      });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      sseWrite(res, {
        ...base,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
    chunk({ role: 'assistant', content: '' });
    let calls = 0;
    try {
      for await (const event of this.stream(res, request)) {
        if (event.type === 'text') chunk({ content: event.text });
        else if (event.type === 'reasoning') chunk({ reasoning_content: event.text });
        else if (event.type === 'tool_call') {
          chunk({ tool_calls: [{ index: calls++, ...openAIToolCall(event.call) }] });
        } else if (event.type === 'usage' && body.stream_options?.include_usage) {
          sseWrite(res, {
            ...base,
            object: 'chat.completion.chunk',
            choices: [],
            usage: openAIUsage(event.usage),
          });
        } else if (event.type === 'done') chunk({}, openAIFinish(event.finishReason));
      }
    } catch (error) {
      sseWrite(res, { error: { message: errorMessage(error), type: 'server_error' } });
    }
    res.end('data: [DONE]\n\n');
  }

  private async ollamaChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = parse(ollamaChatSchema, await readBody(req));
    this.requireModel(body.model);
    const request: ChatRequest = {
      model: body.model,
      messages: body.messages.map(fromOllamaMessage),
      ...(body.tools?.length ? { tools: body.tools.map((t) => t.function) } : {}),
      ...ollamaOptions(body.options),
    };
    await this.ollamaReply(
      res,
      body.model,
      body.stream !== false,
      request,
      (text, thinking, calls) => ({
        message: {
          role: 'assistant',
          content: text,
          ...(thinking ? { thinking } : {}),
          ...(calls?.length
            ? {
                tool_calls: calls.map((c) => ({
                  function: { name: c.name, arguments: parseArguments(c) },
                })),
              }
            : {}),
        },
      }),
    );
  }

  private async ollamaGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = parse(ollamaGenerateSchema, await readBody(req));
    this.requireModel(body.model);
    // An empty prompt only asks for the model to be loaded; it loads on first use anyway.
    if (!body.prompt) {
      return json(res, 200, {
        model: body.model,
        created_at: new Date().toISOString(),
        response: '',
        done: true,
        done_reason: 'load',
      });
    }
    const request: ChatRequest = {
      model: body.model,
      messages: [
        ...(body.system ? [{ role: 'system' as const, content: body.system }] : []),
        { role: 'user', content: body.prompt },
      ],
      ...ollamaOptions(body.options),
    };
    await this.ollamaReply(res, body.model, body.stream !== false, request, (text, thinking) => ({
      response: text,
      ...(thinking ? { thinking } : {}),
    }));
  }

  /** Writes a reply the Ollama way: newline-delimited JSON, or one object when not streaming. */
  private async ollamaReply(
    res: ServerResponse,
    model: string,
    stream: boolean,
    request: ChatRequest,
    shape: (text: string, thinking: string, calls?: ToolCall[]) => Record<string, unknown>,
  ): Promise<void> {
    const started = process.hrtime.bigint();
    const line = (fields: Record<string, unknown>) => ({
      model,
      created_at: new Date().toISOString(),
      ...fields,
    });
    const final = (reply: Collected) => {
      const total = Number(process.hrtime.bigint() - started);
      const evalMs = reply.usage?.tokensPerSecond
        ? (reply.usage.completionTokens / reply.usage.tokensPerSecond) * 1000
        : 0;
      return {
        done: true,
        done_reason: reply.finish === 'length' ? 'length' : 'stop',
        total_duration: total,
        prompt_eval_count: reply.usage?.promptTokens ?? 0,
        eval_count: reply.usage?.completionTokens ?? 0,
        eval_duration: Math.round(evalMs * 1e6),
      };
    };

    if (!stream) {
      const reply = await collect(this.stream(res, request));
      return json(
        res,
        200,
        line({ ...shape(reply.text, reply.reasoning, reply.calls), ...final(reply) }),
      );
    }

    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const reply: Collected = { text: '', reasoning: '', calls: [], usage: null, finish: 'stop' };
    try {
      for await (const event of this.stream(res, request)) {
        if (event.type === 'text') {
          res.write(JSON.stringify(line({ ...shape(event.text, ''), done: false })) + '\n');
        } else if (event.type === 'reasoning') {
          res.write(JSON.stringify(line({ ...shape('', event.text), done: false })) + '\n');
        } else {
          absorb(reply, event);
        }
      }
      res.end(JSON.stringify(line({ ...shape('', '', reply.calls), ...final(reply) })) + '\n');
    } catch (error) {
      res.end(JSON.stringify({ error: errorMessage(error) }) + '\n');
    }
  }

  private async ollamaPull(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = parse(ollamaPullSchema, await readBody(req));
    const ref = body.model ?? body.name;
    if (!ref) throw new RequestError(400, 'model is required');
    let pull: PullStatus;
    try {
      pull = this.options.models.pull(ref);
    } catch (error) {
      throw new RequestError(400, errorMessage(error));
    }
    const stream = body.stream !== false;
    if (stream) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
    }
    let closed = false;
    res.once('close', () => (closed = true));
    for (;;) {
      const status = this.options.models.pulls().find((p) => p.id === pull.id);
      // A finished pull leaves the list, or shows as done.
      if (!status || status.state === 'done') {
        if (stream) res.end(JSON.stringify({ status: 'success' }) + '\n');
        else json(res, 200, { status: 'success' });
        return;
      }
      if (status.state === 'failed') {
        const error = status.error ?? 'The pull failed';
        if (stream) res.end(JSON.stringify({ error }) + '\n');
        else json(res, 500, { error });
        return;
      }
      if (closed) return;
      if (stream && status.totalBytes > 0) {
        res.write(
          JSON.stringify({
            status:
              status.state === 'verifying'
                ? 'verifying sha256 digest'
                : `pulling ${status.modelId ?? ref}`,
            total: status.totalBytes,
            completed: status.doneBytes,
          }) + '\n',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Collected {
  text: string;
  reasoning: string;
  calls: ToolCall[];
  usage: ChatUsage | null;
  finish: FinishReason;
}

function absorb(reply: Collected, event: ChatEvent): void {
  if (event.type === 'text') reply.text += event.text;
  else if (event.type === 'reasoning') reply.reasoning += event.text;
  else if (event.type === 'tool_call') reply.calls.push(event.call);
  else if (event.type === 'usage') reply.usage = event.usage;
  else reply.finish = event.finishReason;
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<Collected> {
  const reply: Collected = { text: '', reasoning: '', calls: [], usage: null, finish: 'stop' };
  for await (const event of events) absorb(reply, event);
  return reply;
}

// Requests are other apps' input, so their shape is checked like anything else from outside.

const toolSchema = z.object({
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  }),
});

const contentSchema = z.union([
  z.string(),
  z.null(),
  z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
]);

const openAIChatSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z
        .object({
          role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
          content: contentSchema.optional(),
          tool_call_id: z.string().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        })
        .loose(),
    )
    .min(1),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).loose().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  tools: z.array(toolSchema).optional(),
});

const ollamaOptionsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    num_predict: z.number().int().optional(),
  })
  .loose()
  .optional();

const ollamaChatSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z
        .object({
          role: z.enum(['system', 'user', 'assistant', 'tool']),
          content: z.string().default(''),
          images: z.array(z.string()).optional(),
          tool_name: z.string().optional(),
          tool_calls: z
            .array(z.object({ function: z.object({ name: z.string(), arguments: z.unknown() }) }))
            .optional(),
        })
        .loose(),
    )
    .min(1),
  stream: z.boolean().optional(),
  options: ollamaOptionsSchema,
  tools: z.array(toolSchema).optional(),
});

const ollamaGenerateSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().optional(),
  system: z.string().optional(),
  stream: z.boolean().optional(),
  options: ollamaOptionsSchema,
});

const ollamaPullSchema = z.object({
  model: z.string().optional(),
  name: z.string().optional(),
  stream: z.boolean().optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new RequestError(400, z.prettifyError(result.error));
  return result.data;
}

function textOf(content: z.infer<typeof contentSchema> | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (content.some((part) => part.type !== 'text')) {
    throw new RequestError(400, 'Only text messages are supported');
  }
  return content.map((part) => part.text ?? '').join('');
}

function fromOpenAIMessage(
  message: z.infer<typeof openAIChatSchema>['messages'][number],
): ChatMessage {
  const content = textOf(message.content);
  switch (message.role) {
    case 'system':
    case 'developer':
      return { role: 'system', content };
    case 'user':
      return { role: 'user', content };
    case 'assistant':
      return {
        role: 'assistant',
        content,
        ...(message.tool_calls?.length
          ? {
              toolCalls: message.tool_calls.map((c) => ({
                id: c.id,
                name: c.function.name,
                arguments: c.function.arguments,
              })),
            }
          : {}),
      };
    case 'tool':
      return { role: 'tool', toolCallId: message.tool_call_id ?? '', content };
  }
}

function fromOllamaMessage(
  message: z.infer<typeof ollamaChatSchema>['messages'][number],
  index: number,
): ChatMessage {
  if (message.images?.length) throw new RequestError(400, 'Images are not supported yet');
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.tool_calls?.length
          ? {
              toolCalls: message.tool_calls.map((c, i) => ({
                id: `call_${index}_${i}`,
                name: c.function.name,
                arguments:
                  typeof c.function.arguments === 'string'
                    ? c.function.arguments
                    : JSON.stringify(c.function.arguments ?? {}),
              })),
            }
          : {}),
      };
    case 'tool':
      // Ollama matches results to calls by order, not id.
      return {
        role: 'tool',
        toolCallId: message.tool_name ?? `call_${index}`,
        content: message.content,
      };
  }
}

function ollamaOptions(options: z.infer<typeof ollamaOptionsSchema>): Partial<ChatRequest> {
  return {
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.num_predict !== undefined && options.num_predict > 0
      ? { maxTokens: options.num_predict }
      : {}),
  };
}

function ollamaModel(model: LibraryItem) {
  const weights = model.files.find((f) => f.role === 'model');
  return {
    name: model.id,
    model: model.id,
    modified_at: model.pulledAt.toISOString(),
    size: model.size,
    digest: weights?.sha256 ?? '',
    details: {
      format: 'gguf',
      family: model.facts.architecture,
      families: [model.facts.architecture],
      parameter_size: model.params ?? '',
      quantization_level: model.quant ?? '',
    },
  };
}

function openAIToolCall(call: ToolCall) {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  };
}

function openAIFinish(finish: FinishReason): string {
  if (finish === 'length') return 'length';
  if (finish === 'tool_calls') return 'tool_calls';
  if (finish === 'refusal') return 'content_filter';
  return 'stop';
}

function openAIUsage(usage: ChatUsage) {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.promptTokens + usage.completionTokens,
  };
}

function parseArguments(call: ToolCall): unknown {
  try {
    return JSON.parse(call.arguments || '{}');
  } catch {
    return {};
  }
}

const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

function allowedHost(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK.test(host);
}

/** Like Ollama: pages on this machine and desktop apps' own schemes, never a website. */
function allowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === 'null') return origin === undefined;
  try {
    const url = new URL(origin);
    if (['app:', 'file:', 'tauri:', 'vscode-webview:', 'vscode-file:'].includes(url.protocol)) {
      return true;
    }
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.test(url.host);
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, 'The request is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestError(400, 'The body must be JSON');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sseWrite(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Errors as each API's clients expect them. */
function fail(res: ServerResponse, status: number, message: string, ollama: boolean): void {
  json(
    res,
    status,
    ollama ? { error: message } : { error: { message, type: 'invalid_request_error' } },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
