import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  ChatUsage,
  FinishReason,
  ToolCall,
} from '@clanks/core';
import { ProviderError, messageOf } from './provider';
import { sseData } from './sse';

/**
 * Where to send an OpenAI-style chat completion. llama-server, OpenAI, OpenRouter, Google's
 * compatibility endpoint, vLLM, LM Studio and Ollama all speak this, each with small differences.
 */
export interface OpenAIEndpoint {
  /** The API root, such as `https://api.openai.com/v1`. `/chat/completions` is added to it. */
  baseUrl: string;
  apiKey?: string | undefined;
  headers?: Record<string, string>;
  /** Who's answering, for error messages: "OpenAI answered HTTP 401". */
  label: string;
  /** How the endpoint takes a cap on the reply, or null to leave it to the server. */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens' | null;
  /** Reasoning models at some providers reject any temperature but their own. */
  temperature: boolean;
  fetch?: typeof fetch;
}

interface Chunk {
  choices?: {
    delta?: {
      content?: string | null;
      /** llama.cpp, vLLM and DeepSeek. */
      reasoning_content?: string | null;
      /** OpenRouter, Ollama and LM Studio. */
      reasoning?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  /** llama.cpp reports its own speeds. */
  timings?: { predicted_per_second?: number; prompt_per_second?: number };
  error?: { message?: string };
}

/**
 * Streams one chat completion. Ends with `done`, or throws a `ProviderError` that says what went
 * wrong. Stopping it through `signal` ends it quietly with `done: cancelled`.
 */
export async function* streamOpenAI(
  endpoint: OpenAIEndpoint,
  request: ChatRequest,
  signal: AbortSignal,
  started = Date.now(),
): AsyncGenerator<ChatEvent> {
  const doFetch = endpoint.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
        ...endpoint.headers,
      },
      body: JSON.stringify(toOpenAI(request, endpoint)),
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      yield { type: 'done', finishReason: 'cancelled' };
      return;
    }
    throw new ProviderError(`Couldn't reach ${endpoint.label}: ${messageOf(error)}`, {
      cause: error,
    });
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new ProviderError(
      `${endpoint.label} answered HTTP ${response.status}: ${errorText(text)}`,
    );
  }

  const calls = new Map<number, ToolCall>();
  let finish: FinishReason = 'stop';
  let usage: ChatUsage | null = null;
  let firstToken: number | null = null;
  try {
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') break;
      const chunk = JSON.parse(data) as Chunk;
      if (chunk.error) throw new ProviderError(chunk.error.message ?? `${endpoint.label} failed`);
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) {
          firstToken ??= Date.now();
          yield { type: 'reasoning', text: reasoning };
        }
        if (delta.content) {
          firstToken ??= Date.now();
          yield { type: 'text', text: delta.content };
        }
        for (const part of delta.tool_calls ?? []) {
          firstToken ??= Date.now();
          const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.arguments += part.function.arguments;
          calls.set(part.index, call);
        }
        if (choice.finish_reason) finish = finishReason(choice.finish_reason);
      }
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          tokensPerSecond: chunk.timings?.predicted_per_second ?? null,
          promptTokensPerSecond: chunk.timings?.prompt_per_second ?? null,
          durationMs: 0,
        };
      }
    }
  } catch (error) {
    if (signal.aborted) {
      yield { type: 'done', finishReason: 'cancelled' };
      return;
    }
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`The reply was cut off: ${messageOf(error)}`, { cause: error });
  }

  for (const [index, call] of [...calls].sort(([a], [b]) => a - b)) {
    yield { type: 'tool_call', call: { ...call, id: call.id || `call_${index}` } };
  }
  if (usage) {
    const ended = Date.now();
    usage.durationMs = ended - started;
    // Servers that don't report a speed get one measured from the first token.
    if (usage.tokensPerSecond === null && firstToken !== null && ended > firstToken) {
      usage.tokensPerSecond = usage.completionTokens / ((ended - firstToken) / 1000);
    }
    yield { type: 'usage', usage };
  }
  yield { type: 'done', finishReason: calls.size > 0 ? 'tool_calls' : finish };
}

function toOpenAI(request: ChatRequest, endpoint: OpenAIEndpoint) {
  return {
    model: request.model,
    messages: request.messages.map(toOpenAIMessage),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }
      : {}),
    ...(request.temperature !== undefined && endpoint.temperature
      ? { temperature: request.temperature }
      : {}),
    ...(request.maxTokens !== undefined && endpoint.maxTokensParam
      ? { [endpoint.maxTokensParam]: request.maxTokens }
      : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
}

function toOpenAIMessage(message: ChatMessage) {
  switch (message.role) {
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    default:
      return { role: message.role, content: message.content };
  }
}

function finishReason(reason: string): FinishReason {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls') return 'tool_calls';
  if (reason === 'content_filter') return 'refusal';
  return 'stop';
}

/** The message in an error body, which is usually `{ error: { message } }`. */
export function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as
      | { error?: { message?: string } | string; message?: string }
      | { error?: { message?: string } }[];
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const error = first?.error;
    if (typeof error === 'string') return error;
    if (error?.message) return error.message;
    if (first && 'message' in first && typeof first.message === 'string') return first.message;
  } catch {
    // Not JSON.
  }
  return body.slice(0, 300) || 'no details';
}

/** `GET /models` on an OpenAI-style API. */
export async function listOpenAIModels(
  endpoint: Pick<OpenAIEndpoint, 'baseUrl' | 'apiKey' | 'headers' | 'label' | 'fetch'>,
  signal?: AbortSignal,
): Promise<{ id: string; name?: string; contextLength: number | null }[]> {
  const doFetch = endpoint.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: {
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
        ...endpoint.headers,
      },
      signal: signal ?? AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ProviderError(`Couldn't reach ${endpoint.label}: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderError(
      `${endpoint.label} answered HTTP ${response.status}: ${errorText(text)}`,
    );
  }
  let body: { object?: unknown; data?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new ProviderError(`${endpoint.label} didn't answer like an OpenAI-compatible API`);
  }
  // Ollama with nothing pulled lists `data: null`.
  const data = body.data ?? (body.object === 'list' ? [] : undefined);
  if (!Array.isArray(data)) {
    throw new ProviderError(`${endpoint.label} didn't answer like an OpenAI-compatible API`);
  }
  return (data as Record<string, unknown>[])
    .filter((m) => typeof m.id === 'string')
    .map((m) => {
      // vLLM says max_model_len, OpenRouter context_length; most say nothing.
      const context = [m.context_length, m.max_model_len, m.context_window].find(
        (v): v is number => typeof v === 'number' && v > 0,
      );
      return {
        id: m.id as string,
        ...(typeof m.name === 'string' ? { name: m.name } : {}),
        contextLength: context ?? null,
      };
    });
}
