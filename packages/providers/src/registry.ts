import type { ChatEvent, ChatRequest } from '@clanks/core';
import { type Provider, ProviderError } from './provider';

/** The providers clanks can call, by id. The built-in runtime is registered first. */
export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  register(provider: Provider): void {
    if (this.providers.has(provider.id))
      throw new Error(`Provider ${provider.id} is already registered`);
    this.providers.set(provider.id, provider);
  }

  get(id: string): Provider {
    const provider = this.providers.get(id);
    if (!provider) throw new ProviderError(`There's no provider ${id}`);
    return provider;
  }

  list(): Provider[] {
    return [...this.providers.values()];
  }

  stream(providerId: string, request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    return this.get(providerId).stream(request, signal);
  }
}
