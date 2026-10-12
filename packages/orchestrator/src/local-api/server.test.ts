import type { ChatEvent, LoadedModelStatus, PullStatus } from '@clanks/core';
import type { LibraryItem } from '@clanks/models';
import { ProviderRegistry, createFakeProvider } from '@clanks/providers';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { LocalApi } from './server';

const MODEL = 'qwen3.5:9b';

const library = [
  {
    id: MODEL,
    source: 'catalog',
    title: 'Qwen 3.5 9B',
    repo: 'test/repo',
    revision: 'a'.repeat(40),
    quant: 'Q4_K_M',
    params: '9B',
    license: 'apache-2.0',
    tags: ['general'],
    capabilities: { tools: true, vision: false, reasoning: true },
    files: [{ role: 'model', path: 'm.gguf', sha256: 'c'.repeat(64), size: 5_000 }],
    facts: {
      architecture: 'qwen35',
      blockCount: 32,
      contextLength: 262_144,
      kvPerToken: 10,
      swaKvPerToken: 0,
      slidingWindow: 0,
      parameterCount: 9e9,
    },
    size: 5_000,
    keepLoaded: false,
    pulledAt: new Date('2026-10-01T00:00:00Z'),
    fit: null,
    loaded: true,
    missing: false,
  },
] satisfies LibraryItem[];

const reply: ChatEvent[] = [
  { type: 'reasoning', text: 'Short.' },
  { type: 'text', text: 'Hello' },
  { type: 'text', text: ' there' },
  {
    type: 'usage',
    usage: {
      promptTokens: 12,
      completionTokens: 2,
      tokensPerSecond: 40,
      promptTokensPerSecond: null,
      durationMs: 100,
    },
  },
  { type: 'done', finishReason: 'stop' },
];

async function start(options: { pulls?: PullStatus[] } = {}) {
  const providers = new ProviderRegistry();
  const fake = createFakeProvider({ id: 'builtin', replies: () => reply });
  providers.register(fake);
  const pulls = options.pulls ?? [];
  const api = new LocalApi({
    providers,
    models: {
      library: () => library,
      loaded: () => [
        {
          modelId: MODEL,
          state: 'ready',
          memory: { gpuBytes: 4_000, systemBytes: 0 },
          idleUnloadAt: new Date('2026-10-05T10:00:00Z'),
        } as LoadedModelStatus,
      ],
      pull: (ref) => {
        if (ref === 'nope:1b') throw new Error('nope:1b is not in the catalog');
        const status = { id: 'p1', ref, state: 'downloading' } as PullStatus;
        pulls.push(status);
        return status;
      },
      pulls: () => pulls,
    },
  });
  const status = await api.apply(true, 0);
  onTestFinished(() => api.stop());
  return { api, url: status.url!, fake };
}

describe('the local API', () => {
  it('is off until turned on, and listens on loopback only', async () => {
    const api = new LocalApi({ providers: new ProviderRegistry(), models: {} as never });
    expect(api.status()).toEqual({ running: false, url: null, error: null });
    const status = await api.apply(true, 0);
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(status.url!)).text()).toBe('clanks is running');
    expect(await api.apply(false, 0)).toEqual({ running: false, url: null, error: null });
  });

  it('says when its port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const port = (blocker.address() as { port: number }).port;
    const api = new LocalApi({ providers: new ProviderRegistry(), models: {} as never });
    expect(await api.apply(true, port)).toEqual({
      running: false,
      url: null,
      error: `Port ${port} is already in use. Pick another port.`,
    });
  });

  it('refuses web pages and hostnames that only point at it', async () => {
    const { url } = await start();
    const fromSite = await fetch(`${url}/v1/models`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(fromSite.status).toBe(403);
    const fromLocalTool = await fetch(`${url}/v1/models`, {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(fromLocalTool.status).toBe(200);
    // fetch won't send a Host of our choosing, so ask node:http directly.
    const status = await new Promise<number>((resolve) => {
      const req = httpRequest(
        `${url}/api/tags`,
        { headers: { host: 'rebound.example:11434' } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.end();
    });
    expect(status).toBe(403);
  });

  describe('OpenAI style', () => {
    it('lists the pulled models', async () => {
      const { url } = await start();
      expect(await (await fetch(`${url}/v1/models`)).json()).toEqual({
        object: 'list',
        data: [{ id: MODEL, object: 'model', created: 1_790_812_800, owned_by: 'clanks' }],
      });
    });

    it('answers a chat completion in one go', async () => {
      const { url, fake } = await start();
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'developer', content: 'Be brief.' },
            { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
          ],
          max_tokens: 50,
          temperature: 0.1,
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        object: 'chat.completion',
        model: MODEL,
        choices: [
          {
            message: { role: 'assistant', content: 'Hello there', reasoning_content: 'Short.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
      });
      expect(fake.requests[0]).toEqual({
        model: MODEL,
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hi' },
        ],
        temperature: 0.1,
        maxTokens: 50,
      });
    });

    it('streams a chat completion as server-sent events', async () => {
      const { url } = await start();
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const lines = (await res.text()).split('\n\n').filter(Boolean);
      expect(lines.at(-1)).toBe('data: [DONE]');
      const chunks = lines.slice(0, -1).map(
        (l) =>
          JSON.parse(l.slice(6)) as {
            choices: { delta: unknown; finish_reason: string | null }[];
            usage?: unknown;
          },
      );
      expect(chunks.map((c) => c.choices[0]?.delta ?? null)).toEqual([
        { role: 'assistant', content: '' },
        { reasoning_content: 'Short.' },
        { content: 'Hello' },
        { content: ' there' },
        null,
        {},
      ]);
      expect(chunks[4]!.usage).toEqual({
        prompt_tokens: 12,
        completion_tokens: 2,
        total_tokens: 14,
      });
      expect(chunks[5]!.choices[0]!.finish_reason).toBe('stop');
    });

    it('explains requests it can’t take', async () => {
      const { url } = await start();
      const unknown = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ model: 'other:1b', messages: [{ role: 'user', content: 'Hi' }] }),
      });
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { error: { message: string } }).error.message).toMatch(
        /model 'other:1b' not found/,
      );
      const bad = await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: '{"model":' });
      expect(bad.status).toBe(400);
    });
  });

  describe('Ollama style', () => {
    it('lists models and what is loaded', async () => {
      const { url } = await start();
      const tags = (await (await fetch(`${url}/api/tags`)).json()) as { models: unknown[] };
      expect(tags.models).toEqual([
        {
          name: MODEL,
          model: MODEL,
          modified_at: '2026-10-01T00:00:00.000Z',
          size: 5_000,
          digest: 'c'.repeat(64),
          details: {
            format: 'gguf',
            family: 'qwen35',
            families: ['qwen35'],
            parameter_size: '9B',
            quantization_level: 'Q4_K_M',
          },
        },
      ]);
      const ps = (await (await fetch(`${url}/api/ps`)).json()) as { models: unknown[] };
      expect(ps.models).toEqual([
        expect.objectContaining({
          name: MODEL,
          size_vram: 4_000,
          expires_at: '2026-10-05T10:00:00.000Z',
        }),
      ]);
    });

    it('streams a chat as lines of JSON', async () => {
      const { url, fake } = await start();
      const res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: 'Hi' }],
          options: { temperature: 0.2, num_predict: 30 },
        }),
      });
      const lines = (await res.text())
        .trim()
        .split('\n')
        .map(
          (l) =>
            JSON.parse(l) as { message: { content: string; thinking?: string }; done: boolean },
        );
      expect(lines.map((l) => [l.message.content, l.message.thinking, l.done])).toEqual([
        ['', 'Short.', false],
        ['Hello', undefined, false],
        [' there', undefined, false],
        ['', undefined, true],
      ]);
      expect(lines.at(-1)).toMatchObject({
        done_reason: 'stop',
        prompt_eval_count: 12,
        eval_count: 2,
      });
      expect(fake.requests[0]).toMatchObject({ temperature: 0.2, maxTokens: 30 });
    });

    it('generates without streaming when asked', async () => {
      const { url } = await start();
      const body = (await (
        await fetch(`${url}/api/generate`, {
          method: 'POST',
          body: JSON.stringify({ model: MODEL, prompt: 'Hi', system: 'Be brief.', stream: false }),
        })
      ).json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: MODEL,
        response: 'Hello there',
        thinking: 'Short.',
        done: true,
      });
    });

    it('pulls through the model manager, reporting progress', async () => {
      const pulls: PullStatus[] = [];
      const { url } = await start({ pulls });
      const pending = fetch(`${url}/api/pull`, {
        method: 'POST',
        body: JSON.stringify({ model: MODEL }),
      });
      setTimeout(() => {
        Object.assign(pulls[0]!, { totalBytes: 100, doneBytes: 100, state: 'done' });
      }, 100);
      const lines = (await (await pending).text())
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as unknown);
      expect(lines[0]).toEqual({ status: 'pulling manifest' });
      expect(lines.at(-1)).toEqual({ status: 'success' });

      const refused = await fetch(`${url}/api/pull`, {
        method: 'POST',
        body: JSON.stringify({ model: 'nope:1b' }),
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'nope:1b is not in the catalog' });
    });
  });
});
