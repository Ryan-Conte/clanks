import type { ChatEvent } from '@clanks/core';
import { describe, expect, it } from 'vitest';
import { createFakeProvider } from './fake';
import { ProviderError } from './provider';
import { ProviderRegistry } from './registry';

describe('ProviderRegistry', () => {
  it('routes a request to its provider', async () => {
    const registry = new ProviderRegistry();
    const fake = createFakeProvider({ replies: [[{ type: 'text', text: 'hi' }]] });
    registry.register(fake);
    const events: ChatEvent[] = [];
    const request = { model: 'm', messages: [{ role: 'user' as const, content: 'hello' }] };
    for await (const event of registry.stream('fake', request, new AbortController().signal)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'done', finishReason: 'stop' },
    ]);
    expect(fake.requests).toEqual([request]);
  });

  it('refuses unknown and duplicate providers', () => {
    const registry = new ProviderRegistry();
    registry.register(createFakeProvider({ replies: [] }));
    expect(() => registry.register(createFakeProvider({ replies: [] }))).toThrow(/already/);
    expect(() => registry.get('nope')).toThrow(ProviderError);
  });

  it('replays scripted replies in order, then runs out', async () => {
    const fake = createFakeProvider({
      replies: [[{ type: 'text', text: 'first' }], [{ type: 'done', finishReason: 'length' }]],
    });
    const run = async () => {
      const events: ChatEvent[] = [];
      for await (const e of fake.stream(
        { model: 'm', messages: [] },
        new AbortController().signal,
      )) {
        events.push(e);
      }
      return events;
    };
    expect((await run())[0]).toEqual({ type: 'text', text: 'first' });
    expect(await run()).toEqual([{ type: 'done', finishReason: 'length' }]);
    await expect(run()).rejects.toThrow(/no reply/);
  });
});
