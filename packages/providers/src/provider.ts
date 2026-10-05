import type { ChatEvent, ChatRequest, ModelCapabilities } from '@clanks/core';

export interface ModelInfo {
  id: string;
  title: string;
  capabilities: ModelCapabilities;
  contextWindow: number;
}

/**
 * Something that runs models: the built-in runtime first, cloud providers and external servers
 * later. The orchestrator is the only caller, so keys never leave it.
 */
export interface Provider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  /** Streams one reply. Ends with a `done` event, or throws a `ProviderError`. */
  stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  capabilities(model: string): { tools: boolean; vision: boolean; contextWindow: number };
}

export class ProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderError';
  }
}
