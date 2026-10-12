import type { ChatEvent, ChatRequest, ModelCapabilities } from '@clanks/core';
import { streamOpenAI } from './openai';
import { type ModelInfo, type Provider, ProviderError, messageOf } from './provider';

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

async function* streamChat(
  runtime: BuiltinRuntime,
  request: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  // Loading counts toward the reply's time: it's what the user waited for.
  const started = Date.now();
  let lease: RuntimeLease;
  try {
    lease = await runtime.acquire(request.model, signal);
  } catch (error) {
    if (signal.aborted) {
      yield { type: 'done', finishReason: 'cancelled' };
      return;
    }
    throw new ProviderError(`Couldn't load ${request.model}: ${messageOf(error)}`, {
      cause: error,
    });
  }

  try {
    const events = streamOpenAI(
      {
        baseUrl: `${lease.baseUrl}/v1`,
        apiKey: lease.apiKey,
        label: 'The model',
        maxTokensParam: 'max_tokens',
        temperature: true,
      },
      // llama-server knows the model by the alias it was started with.
      { ...request, model: lease.model },
      signal,
      started,
    );
    for await (const event of events) {
      if (event.type === 'usage') {
        lease.report({
          tokensPerSecond: event.usage.tokensPerSecond,
          promptTokensPerSecond: event.usage.promptTokensPerSecond,
        });
      }
      yield event;
    }
  } finally {
    lease.release();
  }
}
