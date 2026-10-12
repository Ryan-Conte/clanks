import type { ChatEvent, ChatRequest } from '@clanks/core';
import { type OpenAIEndpoint, listOpenAIModels, streamOpenAI } from './openai';
import { type ModelInfo, type Provider, ProviderError } from './provider';

/** How long a model listing is trusted before it's fetched again. */
const LIST_TTL_MS = 5 * 60_000;

export interface CompatibleProviderOptions {
  id: string;
  /** Shown in errors: "OpenRouter answered HTTP 401". */
  label: string;
  baseUrl: string;
  /** Read when needed, so a key saved or removed in Settings applies at once. */
  apiKey: () => string | undefined;
  /** Cloud providers can't be used without a key; servers usually take any, or none. */
  requiresKey: boolean;
  maxTokensParam: OpenAIEndpoint['maxTokensParam'];
  temperature: boolean;
  headers?: Record<string, string>;
  /** Keeps the models worth chatting with, and tidies their ids. */
  models?: (models: ModelInfo[]) => ModelInfo[];
  fetch?: typeof fetch;
}

/** A provider that speaks the OpenAI chat completions API. */
export function createCompatibleProvider(options: CompatibleProviderOptions): Provider {
  let listed: { key: string | undefined; at: number; models: ModelInfo[] } | null = null;

  const endpoint = (): OpenAIEndpoint => {
    const apiKey = options.apiKey();
    if (options.requiresKey && !apiKey) {
      throw new ProviderError(`Add your ${options.label} API key in Settings to use its models`);
    }
    return {
      baseUrl: options.baseUrl,
      apiKey,
      label: options.label,
      maxTokensParam: options.maxTokensParam,
      temperature: options.temperature,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    };
  };

  return {
    id: options.id,

    async listModels(signal) {
      const target = endpoint();
      if (listed && listed.key === target.apiKey && Date.now() - listed.at < LIST_TTL_MS) {
        return listed.models;
      }
      const raw = await listOpenAIModels(target, signal);
      const models = raw.map((m) => ({
        id: m.id,
        title: m.name ?? m.id,
        // The listing doesn't say; chat models at these providers almost all call tools.
        capabilities: { tools: true, vision: false, reasoning: false },
        contextWindow: m.contextLength ?? 0,
      }));
      const kept = (options.models ?? ((all) => all))(models).sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      listed = { key: target.apiKey, at: Date.now(), models: kept };
      return kept;
    },

    capabilities(model) {
      const info = listed?.models.find((m) => m.id === model);
      return { tools: true, vision: false, contextWindow: info?.contextWindow ?? 0 };
    },

    // A generator, so a missing key fails while iterating, like every other failure.
    async *stream(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
      yield* streamOpenAI(endpoint(), request, signal);
    },
  };
}

/** Models at OpenAI that aren't for chat, or only work through its Responses API. */
const OPENAI_SKIP =
  /audio|realtime|transcribe|tts|whisper|dall-e|image|embedding|moderation|search|codex|computer-use|deep-research|-pro\b|babbage|davinci|instruct/;

export function createOpenAIProvider(
  options: Pick<CompatibleProviderOptions, 'apiKey' | 'fetch'> & { baseUrl?: string },
): Provider {
  return createCompatibleProvider({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: options.baseUrl ?? 'https://api.openai.com/v1',
    apiKey: options.apiKey,
    requiresKey: true,
    // Its reasoning models refuse max_tokens and any temperature but the default.
    maxTokensParam: 'max_completion_tokens',
    temperature: false,
    models: (models) =>
      models.filter((m) => /^(?:gpt-|o\d|chatgpt-)/.test(m.id) && !OPENAI_SKIP.test(m.id)),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export function createGoogleProvider(
  options: Pick<CompatibleProviderOptions, 'apiKey' | 'fetch'> & { baseUrl?: string },
): Provider {
  return createCompatibleProvider({
    id: 'google',
    label: 'Google',
    // Gemini's OpenAI-compatible endpoint.
    baseUrl: options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: options.apiKey,
    requiresKey: true,
    maxTokensParam: null,
    temperature: true,
    models: (models) =>
      models
        .map((m) => ({
          ...m,
          id: m.id.replace(/^models\//, ''),
          title: m.title.replace(/^models\//, ''),
        }))
        .filter((m) => m.id.startsWith('gemini') && !/embedding|tts|image|live|audio/.test(m.id)),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export function createOpenRouterProvider(
  options: Pick<CompatibleProviderOptions, 'apiKey' | 'fetch'> & { baseUrl?: string },
): Provider {
  return createCompatibleProvider({
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: options.baseUrl ?? 'https://openrouter.ai/api/v1',
    apiKey: options.apiKey,
    requiresKey: true,
    maxTokensParam: 'max_tokens',
    temperature: true,
    // OpenRouter shows the app's name on the user's activity page.
    headers: { 'HTTP-Referer': 'https://clanks.si', 'X-Title': 'clanks' },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

/** A model server the user runs elsewhere: vLLM, LM Studio, Ollama or anything OpenAI-style. */
export function createServerProvider(options: {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: () => string | undefined;
  fetch?: typeof fetch;
}): Provider {
  return createCompatibleProvider({
    id: options.id,
    label: options.name,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    requiresKey: false,
    maxTokensParam: 'max_tokens',
    temperature: true,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
