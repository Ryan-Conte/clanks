import type { ChatEvent, ChatRequest } from '@clanks/core';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from './anthropic';
import { ProviderError } from './provider';
import { collect, fakeApi, json, sse } from './test/http';

const MODEL = 'claude-test-1';

function modelsPage(res: ServerResponse, adaptive = true) {
  json(res, {
    data: [
      {
        type: 'model',
        id: MODEL,
        display_name: 'Claude Test 1',
        created_at: '2026-09-01T00:00:00Z',
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          image_input: { supported: true },
          thinking: {
            supported: adaptive,
            types: { adaptive: { supported: adaptive }, enabled: { supported: false } },
          },
        },
      },
    ],
    has_more: false,
    first_id: MODEL,
    last_id: MODEL,
  });
}

const event = (type: string, data: Record<string, unknown>) => ({
  event: type,
  data: { type, ...data },
});

function reply(
  res: ServerResponse,
  blocks: (
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'tool_use'; id: string; name: string; input: string }
  )[],
  stopReason = 'end_turn',
  { end = true } = {},
) {
  const events: unknown[] = [
    event('message_start', {
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 20,
          output_tokens: 1,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 1000,
        },
      },
    }),
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(
        event('content_block_start', { index, content_block: { type: 'text', text: '' } }),
      );
      events.push(
        event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } }),
      );
    } else if (block.type === 'thinking') {
      events.push(
        event('content_block_start', {
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }),
      );
      events.push(
        event('content_block_delta', {
          index,
          delta: { type: 'thinking_delta', thinking: block.thinking },
        }),
      );
      events.push(
        event('content_block_delta', {
          index,
          delta: { type: 'signature_delta', signature: 'sig' },
        }),
      );
    } else {
      events.push(
        event('content_block_start', {
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        }),
      );
      events.push(
        event('content_block_delta', {
          index,
          delta: { type: 'input_json_delta', partial_json: block.input },
        }),
      );
    }
    events.push(event('content_block_stop', { index }));
  });
  if (end) {
    events.push(
      event('message_delta', {
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 42 },
      }),
    );
    events.push(event('message_stop', {}));
  }
  sse(res, events, { end });
}

const request: ChatRequest = {
  model: MODEL,
  messages: [
    { role: 'system', content: 'You are Atlas.' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello.' },
    { role: 'user', content: 'Weather?' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tu_1', name: 'now', arguments: '{}' },
        { id: 'tu_2', name: 'where', arguments: '{"x":1}' },
      ],
    },
    { role: 'tool', toolCallId: 'tu_1', content: '12:00' },
    { role: 'tool', toolCallId: 'tu_2', content: 'Perth' },
    // Review notes the user left while the tools ran.
    { role: 'user', content: 'Use Celsius.' },
  ],
  temperature: 0.3,
};

function provider(url: string, key: string | undefined = 'sk-ant-test') {
  return createAnthropicProvider({ apiKey: () => key, baseURL: url });
}

describe('the Anthropic provider', () => {
  it('streams thinking and text, and counts cached tokens', async () => {
    const api = await fakeApi((req, res) =>
      req.method === 'GET'
        ? modelsPage(res)
        : reply(res, [
            { type: 'thinking', thinking: 'They want the weather.' },
            { type: 'text', text: 'Sunny in Perth.' },
          ]),
    );
    const events = await collect(provider(api.url).stream(request, new AbortController().signal));
    expect(events.slice(0, 2)).toEqual([
      { type: 'reasoning', text: 'They want the weather.' },
      { type: 'text', text: 'Sunny in Perth.' },
    ]);
    expect(events[2]).toMatchObject({
      type: 'usage',
      usage: { promptTokens: 1120, completionTokens: 42, promptTokensPerSecond: null },
    });
    expect(events[3]).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('asks for what the model can do, and nothing it would refuse', async () => {
    const api = await fakeApi((req, res) =>
      req.method === 'GET' ? modelsPage(res) : reply(res, [{ type: 'text', text: 'Ok' }]),
    );
    await collect(provider(api.url).stream(request, new AbortController().signal));
    const sent = api.requests.find((r) => r.method === 'POST')!;
    expect(sent.path).toBe('/v1/messages');
    expect(sent.headers['x-api-key']).toBe('sk-ant-test');
    expect(sent.body).toMatchObject({
      model: MODEL,
      max_tokens: 64_000,
      system: 'You are Atlas.',
      thinking: { type: 'adaptive', display: 'summarized' },
      cache_control: { type: 'ephemeral' },
      stream: true,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'now', input: {} },
            { type: 'tool_use', id: 'tu_2', name: 'where', input: { x: 1 } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: '12:00' },
            { type: 'tool_result', tool_use_id: 'tu_2', content: 'Perth' },
            { type: 'text', text: 'Use Celsius.' },
          ],
        },
      ],
    });
    expect(sent.body).not.toHaveProperty('temperature');
  });

  it('leaves thinking alone on models without adaptive thinking', async () => {
    const api = await fakeApi((req, res) =>
      req.method === 'GET' ? modelsPage(res, false) : reply(res, [{ type: 'text', text: 'Ok' }]),
    );
    await collect(provider(api.url).stream(request, new AbortController().signal));
    expect(api.requests.find((r) => r.method === 'POST')!.body).not.toHaveProperty('thinking');
  });

  it('returns tool calls with their arguments as JSON', async () => {
    const api = await fakeApi((req, res) =>
      req.method === 'GET'
        ? modelsPage(res)
        : reply(
            res,
            [{ type: 'tool_use', id: 'tu_9', name: 'fs_read', input: '{"path":"README.md"}' }],
            'tool_use',
          ),
    );
    const events = await collect(provider(api.url).stream(request, new AbortController().signal));
    expect(events[0]).toEqual({
      type: 'tool_call',
      call: { id: 'tu_9', name: 'fs_read', arguments: '{"path":"README.md"}' },
    });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('says when Claude declines', async () => {
    const api = await fakeApi((req, res) =>
      req.method === 'GET' ? modelsPage(res) : reply(res, [{ type: 'text', text: '' }], 'refusal'),
    );
    const events = await collect(provider(api.url).stream(request, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'refusal' });
  });

  it('lists models with their context and abilities', async () => {
    const api = await fakeApi((_req, res) => modelsPage(res));
    const anthropic = provider(api.url);
    expect(await anthropic.listModels()).toEqual([
      expect.objectContaining({
        id: MODEL,
        title: 'Claude Test 1',
        contextWindow: 1_000_000,
        capabilities: { tools: true, vision: true, reasoning: true },
      }),
    ]);
    expect(anthropic.capabilities(MODEL)).toEqual({
      tools: true,
      vision: true,
      contextWindow: 1_000_000,
    });
  });

  it('explains a rejected key, and a missing one', async () => {
    const api = await fakeApi((_req, res) =>
      json(
        res,
        { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        401,
      ),
    );
    await expect(provider(api.url).listModels()).rejects.toThrow(
      'Anthropic rejected the API key. Check it in Settings.',
    );
    await expect(
      collect(provider(api.url, undefined).stream(request, new AbortController().signal)),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('ends quietly when stopped mid-reply', async () => {
    const api = await fakeApi((req, res) =>
      req.method === 'GET'
        ? modelsPage(res)
        : reply(res, [{ type: 'text', text: 'Once upon' }], 'end_turn', { end: false }),
    );
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    for await (const e of provider(api.url).stream(request, controller.signal)) {
      events.push(e);
      if (e.type === 'text') controller.abort();
    }
    expect(events).toEqual([
      { type: 'text', text: 'Once upon' },
      { type: 'done', finishReason: 'cancelled' },
    ]);
  });
});
