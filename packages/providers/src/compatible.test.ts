import type { ChatRequest } from '@clanks/core';
import { describe, expect, it } from 'vitest';
import {
  createGoogleProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
  createServerProvider,
} from './compatible';
import { ProviderError } from './provider';
import { collect, fakeApi, json, sse } from './test/http';

const request: ChatRequest = {
  model: 'm',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hi' },
  ],
  temperature: 0.3,
  maxTokens: 500,
};

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
});

describe('OpenAI', () => {
  it('sends its key, caps the reply its way and leaves the temperature alone', async () => {
    const api = await fakeApi((_req, res) =>
      sse(
        res,
        [
          chunk({ content: 'Hello' }, 'stop'),
          { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } },
        ],
        { done: true },
      ),
    );
    const provider = createOpenAIProvider({ apiKey: () => 'sk-test', baseUrl: api.url });
    const events = await collect(provider.stream(request, new AbortController().signal));
    expect(events[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(api.requests[0]!.path).toBe('/chat/completions');
    expect(api.requests[0]!.headers.authorization).toBe('Bearer sk-test');
    expect(api.requests[0]!.body).toMatchObject({ max_completion_tokens: 500 });
    expect(api.requests[0]!.body).not.toHaveProperty('temperature');
    expect(api.requests[0]!.body).not.toHaveProperty('max_tokens');
  });

  it('lists only models to chat with', async () => {
    const api = await fakeApi((_req, res) =>
      json(res, {
        data: [
          'gpt-5',
          'o4-mini',
          'text-embedding-3-large',
          'gpt-4o-realtime',
          'dall-e-3',
          'whisper-1',
        ].map((id) => ({ id, object: 'model' })),
      }),
    );
    const provider = createOpenAIProvider({ apiKey: () => 'sk-test', baseUrl: api.url });
    expect((await provider.listModels()).map((m) => m.id)).toEqual(['gpt-5', 'o4-mini']);
    // A second look within a few minutes comes from memory.
    await provider.listModels();
    expect(api.requests).toHaveLength(1);
  });

  it('asks for a key when there is none', async () => {
    const provider = createOpenAIProvider({ apiKey: () => undefined });
    await expect(collect(provider.stream(request, new AbortController().signal))).rejects.toThrow(
      'Add your OpenAI API key in Settings to use its models',
    );
    await expect(provider.listModels()).rejects.toBeInstanceOf(ProviderError);
  });

  it('says what the API said when it refuses', async () => {
    const api = await fakeApi((_req, res) =>
      json(res, { error: { message: 'Incorrect API key provided' } }, 401),
    );
    const provider = createOpenAIProvider({ apiKey: () => 'sk-bad', baseUrl: api.url });
    await expect(collect(provider.stream(request, new AbortController().signal))).rejects.toThrow(
      'OpenAI answered HTTP 401: Incorrect API key provided',
    );
  });
});

describe('Google', () => {
  it("tidies Gemini's model names and leaves the reply's length to it", async () => {
    const api = await fakeApi((req, res) => {
      if (req.method === 'GET') {
        json(res, {
          data: [
            { id: 'models/gemini-3-pro' },
            { id: 'models/gemini-embedding-001' },
            { id: 'models/imagen-4' },
          ],
        });
      } else {
        sse(res, [chunk({ content: 'Hi' }, 'stop')], { done: true });
      }
    });
    const provider = createGoogleProvider({ apiKey: () => 'g-key', baseUrl: api.url });
    expect((await provider.listModels()).map((m) => m.id)).toEqual(['gemini-3-pro']);
    await collect(provider.stream(request, new AbortController().signal));
    expect(api.requests[1]!.body).toMatchObject({ temperature: 0.3 });
    expect(api.requests[1]!.body).not.toHaveProperty('max_tokens');
    expect(api.requests[1]!.body).not.toHaveProperty('max_completion_tokens');
  });
});

describe('OpenRouter', () => {
  it('names the app, streams reasoning and measures the speed', async () => {
    const api = await fakeApi((_req, res) =>
      sse(
        res,
        [
          chunk({ reasoning: 'Weighing it up.' }),
          chunk({ content: 'Done' }, 'stop'),
          { choices: [], usage: { prompt_tokens: 4, completion_tokens: 40 } },
        ],
        { done: true },
      ),
    );
    const provider = createOpenRouterProvider({ apiKey: () => 'or-key', baseUrl: api.url });
    const events = await collect(provider.stream(request, new AbortController().signal));
    expect(events.slice(0, 2)).toEqual([
      { type: 'reasoning', text: 'Weighing it up.' },
      { type: 'text', text: 'Done' },
    ]);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ usage: { promptTokens: 4, completionTokens: 40 } });
    expect(api.requests[0]!.headers['x-title']).toBe('clanks');
    expect(api.requests[0]!.body).toMatchObject({ max_tokens: 500, temperature: 0.3 });
  });

  it('turns a filtered reply into a refusal', async () => {
    const api = await fakeApi((_req, res) =>
      sse(res, [chunk({ content: 'I' }, 'content_filter')], { done: true }),
    );
    const provider = createOpenRouterProvider({ apiKey: () => 'k', baseUrl: api.url });
    const events = await collect(provider.stream(request, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'refusal' });
  });
});

describe('model servers', () => {
  it('need no key, and report the context they were started with', async () => {
    const api = await fakeApi((_req, res) =>
      json(res, { object: 'list', data: [{ id: 'qwen', max_model_len: 65536 }] }),
    );
    const provider = createServerProvider({
      id: 'server-lab',
      name: 'Lab vLLM',
      baseUrl: `${api.url}/v1/`,
      apiKey: () => undefined,
    });
    expect(await provider.listModels()).toEqual([
      {
        id: 'qwen',
        title: 'qwen',
        capabilities: { tools: true, vision: false, reasoning: false },
        contextWindow: 65536,
      },
    ]);
    expect(provider.capabilities('qwen').contextWindow).toBe(65536);
    expect(api.requests[0]!.path).toBe('/v1/models');
    expect(api.requests[0]!.headers.authorization).toBeUndefined();
  });

  it('explain an address that is not an OpenAI-style API', async () => {
    const api = await fakeApi((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>Hello</html>');
    });
    const provider = createServerProvider({
      id: 'server-web',
      name: 'My server',
      baseUrl: api.url,
      apiKey: () => undefined,
    });
    await expect(provider.listModels()).rejects.toThrow(
      "My server didn't answer like an OpenAI-compatible API",
    );
  });

  it('take an empty list as Ollama writes it', async () => {
    // What Ollama answers with no models pulled.
    const api = await fakeApi((_req, res) => json(res, { object: 'list', data: null }));
    const provider = createServerProvider({
      id: 'server-ollama',
      name: 'Ollama',
      baseUrl: `${api.url}/v1`,
      apiKey: () => undefined,
    });
    expect(await provider.listModels()).toEqual([]);
  });

  it('explain a server that is not running', async () => {
    const provider = createServerProvider({
      id: 'server-off',
      name: 'LM Studio',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: () => undefined,
    });
    await expect(provider.listModels()).rejects.toThrow(/^Couldn't reach LM Studio: /);
  });
});
