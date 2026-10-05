import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  ChatUsage,
  FinishReason,
  ModelCapabilities,
  ToolCall,
} from '@clanks/core';
import { type ModelInfo, type Provider, ProviderError } from './provider';
import { sseData } from './sse';

/** A loaded model held for one request. The model manager's `Lease` satisfies this. */
export interface RuntimeLease {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  report(usage: { tokensPerSecond: number | null; promptTokensPerSecond: number | null }): void;
  release(): void;
}

/** What the built-in provider needs from the model manager. */
export interface BuiltinRuntime {
  models(): { id: string; title: string; capabilities: ModelCapabilities; contextLength: number }[];
  acquire(model: string, signal?: AbortSignal): Promise<RuntimeLease>;
}

export const BUILTIN_PROVIDER = 'builtin';

/**
 * The built-in runtime: models clanks pulled itself, run by the llama-server it manages. Each
 * request holds the model for its duration, so the model can't unload mid-reply.
 */
export function createBuiltinProvider(runtime: BuiltinRuntime): Provider {
  const find = (model: string) => runtime.models().find((m) => m.id === model);
  return {
    id: BUILTIN_PROVIDER,

    listModels(): Promise<ModelInfo[]> {
      return Promise.resolve(
        runtime.models().map((m) => ({
          id: m.id,
          title: m.title,
          capabilities: m.capabilities,
          contextWindow: m.contextLength,
        })),
      );
    },

    capabilities(model) {
      const info = find(model);
      return {
        tools: info?.capabilities.tools ?? false,
        vision: info?.capabilities.vision ?? false,
        contextWindow: info?.contextLength ?? 0,
      };
    },

    stream(request, signal) {
      return streamChat(runtime, request, signal);
    },
  };
}

interface Chunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  timings?: { predicted_per_second?: number; prompt_per_second?: number };
  error?: { message?: string };
}

async function* streamChat(
  runtime: BuiltinRuntime,
  request: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const started = Date.now();
  let lease: RuntimeLease;
  try {
    lease = await runtime.acquire(request.model, signal);
  } catch (error) {
    if (signal.aborted) {
      yield { type: 'done', finishReason: 'cancelled' };
      return;
    }
    throw new ProviderError(`Couldn't load ${request.model}: ${message(error)}`, { cause: error });
  }

  try {
    let response: Response;
    try {
      response = await fetch(`${lease.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${lease.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(toOpenAI(request, lease.model)),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        yield { type: 'done', finishReason: 'cancelled' };
        return;
      }
      throw new ProviderError(`The model stopped responding: ${message(error)}`, { cause: error });
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(`The model answered HTTP ${response.status}: ${errorText(text)}`);
    }

    const calls = new Map<number, ToolCall>();
    let finish: FinishReason = 'stop';
    let usage: ChatUsage | null = null;
    try {
      for await (const data of sseData(response.body)) {
        if (data === '[DONE]') break;
        const chunk = JSON.parse(data) as Chunk;
        if (chunk.error) throw new ProviderError(chunk.error.message ?? 'The model failed');
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};
          if (delta.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
          if (delta.content) yield { type: 'text', text: delta.content };
          for (const part of delta.tool_calls ?? []) {
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
      throw new ProviderError(`The reply was cut off: ${message(error)}`, { cause: error });
    }

    for (const [index, call] of [...calls].sort(([a], [b]) => a - b)) {
      yield { type: 'tool_call', call: { ...call, id: call.id || `call_${index}` } };
    }
    if (usage) {
      usage.durationMs = Date.now() - started;
      lease.report({
        tokensPerSecond: usage.tokensPerSecond,
        promptTokensPerSecond: usage.promptTokensPerSecond,
      });
      yield { type: 'usage', usage };
    }
    yield { type: 'done', finishReason: calls.size > 0 ? 'tool_calls' : finish };
  } finally {
    lease.release();
  }
}

function toOpenAI(request: ChatRequest, model: string) {
  return {
    model,
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
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
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
  return 'stop';
}

function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Not JSON.
  }
  return body.slice(0, 300) || 'no details';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
