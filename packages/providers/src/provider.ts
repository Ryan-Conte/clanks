import type { ChatEvent, ChatRequest, ModelCapabilities } from '@clanks/core';

export interface ModelInfo {
  id: string;
  title: string;
  capabilities: ModelCapabilities;
  /** Tokens. Zero when the provider doesn't say. */
  contextWindow: number;
}

/**
 * Something that runs models: the built-in runtime, a cloud provider or a model server the user
 * runs elsewhere. The orchestrator is the only caller, so keys never leave it.
 */
export interface Provider {
  id: string;
  /** Throws a `ProviderError` when the provider can't be reached or rejects the key. */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Streams one reply. Ends with a `done` event, or throws a `ProviderError`. */
  stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  /** What's known about a model, from its last listing. */
  capabilities(model: string): { tools: boolean; vision: boolean; contextWindow: number };
}

/** A provider's failure, worded for the user: a rejected key, a model that won't load. */
export class ProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // fetch hides the real reason, such as ECONNREFUSED, in its cause.
    const cause = (error as Error & { cause?: unknown }).cause;
    if (error.message === 'fetch failed' && cause instanceof Error) return cause.message;
    return error.message;
  }
  return String(error);
}
