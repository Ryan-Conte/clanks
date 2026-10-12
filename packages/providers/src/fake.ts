import type { ChatEvent, ChatRequest } from '@clanks/core';
import type { ModelInfo, Provider } from './provider';

export interface FakeProvider extends Provider {
  /** Every request it was sent, in order. */
  requests: ChatRequest[];
}

/**
 * Replays scripted replies, one per request, so agent loops can be tested offline and
 * deterministically. A reply without a `done` event gets one.
 */
export function createFakeProvider(options: {
  id?: string;
  models?: ModelInfo[];
  replies: ChatEvent[][] | ((request: ChatRequest) => ChatEvent[]);
}): FakeProvider {
  const requests: ChatRequest[] = [];
  const models = options.models ?? [];
  let next = 0;
  return {
    id: options.id ?? 'fake',
    requests,
    listModels: () => Promise.resolve(models),
    capabilities(model) {
      const info = models.find((m) => m.id === model);
      return {
        tools: info?.capabilities.tools ?? true,
        vision: info?.capabilities.vision ?? false,
        contextWindow: info?.contextWindow ?? 32768,
      };
    },
    async *stream(request, signal) {
      requests.push(structuredClone(request));
      const reply =
        typeof options.replies === 'function' ? options.replies(request) : options.replies[next++];
      if (!reply) throw new Error(`The fake provider has no reply for request ${requests.length}`);
      for (const event of reply) {
        if (signal.aborted) {
          yield { type: 'done', finishReason: 'cancelled' };
          return;
        }
        await Promise.resolve();
        yield event;
      }
      if (!reply.some((e) => e.type === 'done')) yield { type: 'done', finishReason: 'stop' };
    },
  };
}
