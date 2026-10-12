import type { ChatEvent, ChatRequest } from '@clanks/core';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { type BuiltinRuntime, createBuiltinProvider } from './builtin';
import { ProviderError } from './provider';
import { sseData } from './sse';

type Handler = (body: Record<string, unknown>, res: ServerResponse) => void;

/** A llama-server stand-in that answers chat completions with `handler`. */
async function server(handler: Handler) {
  const requests: { auth: string | undefined; body: Record<string, unknown> }[] = [];
  const http = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (data: Buffer) => (raw += data.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ auth: req.headers.authorization, body });
      handler(body, res);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, requests };
}

function sse(res: ServerResponse, chunks: unknown[], done = true) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (done) res.end('data: [DONE]\n\n');
}

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

function runtime(url: string) {
  const state = { acquired: 0, released: 0, reported: [] as unknown[] };
  const rt: BuiltinRuntime = {
    models: () => [
      {
        id: 'tiny:1b',
        title: 'Tiny',
        capabilities: { tools: true, vision: false, reasoning: true },
        contextLength: 4096,
      },
    ],
    acquire: (model) => {
      state.acquired++;
      return Promise.resolve({
        baseUrl: url,
        apiKey: 'per-launch-key',
        model,
        report: (usage) => state.reported.push(usage),
        release: () => state.released++,
      });
    },
  };
  return { rt, state };
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const request: ChatRequest = {
  model: 'tiny:1b',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hi' },
  ],
  temperature: 0.2,
  maxTokens: 64,
};

describe('the built-in provider', () => {
  it('streams reasoning, text and usage, and reports the speed', async () => {
    const llama = await server((_body, res) =>
      sse(res, [
        delta({ role: 'assistant', content: null }),
        delta({ reasoning_content: 'Thinking.' }),
        delta({ content: 'Hello' }),
        delta({ content: ' there' }),
        delta({}, 'stop'),
        {
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
          timings: { predicted_per_second: 240.5, prompt_per_second: 900 },
        },
      ]),
    );
    const { rt, state } = runtime(llama.url);
    const events = await collect(
      createBuiltinProvider(rt).stream(request, new AbortController().signal),
    );

    expect(events.slice(0, 3)).toEqual([
      { type: 'reasoning', text: 'Thinking.' },
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' there' },
    ]);
    expect(events[3]).toMatchObject({
      type: 'usage',
      usage: {
        promptTokens: 12,
        completionTokens: 3,
        tokensPerSecond: 240.5,
        promptTokensPerSecond: 900,
      },
    });
    expect(events[4]).toEqual({ type: 'done', finishReason: 'stop' });
    expect(state).toMatchObject({ acquired: 1, released: 1 });
    expect(state.reported).toEqual([{ tokensPerSecond: 240.5, promptTokensPerSecond: 900 }]);

    expect(llama.requests[0]!.auth).toBe('Bearer per-launch-key');
    expect(llama.requests[0]!.body).toMatchObject({
      model: 'tiny:1b',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
      ],
      temperature: 0.2,
      max_tokens: 64,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('assembles tool calls from their deltas', async () => {
    const llama = await server((_body, res) =>
      sse(res, [
        delta({
          tool_calls: [
            { index: 0, id: 'call_a', function: { name: 'get_weather', arguments: '' } },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"Perth"}' } }] }),
        delta({}, 'tool_calls'),
      ]),
    );
    const { rt } = runtime(llama.url);
    const events = await collect(
      createBuiltinProvider(rt).stream(
        {
          ...request,
          tools: [{ name: 'get_weather', description: 'Weather', parameters: { type: 'object' } }],
          messages: [
            { role: 'user', content: 'Weather?' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call_0', name: 'now', arguments: '{}' }],
            },
            { role: 'tool', toolCallId: 'call_0', content: '12:00' },
          ],
        },
        new AbortController().signal,
      ),
    );
    expect(events).toEqual([
      {
        type: 'tool_call',
        call: { id: 'call_a', name: 'get_weather', arguments: '{"city":"Perth"}' },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
    expect(llama.requests[0]!.body).toMatchObject({
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
      messages: [
        { role: 'user' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'now' } }],
        },
        { role: 'tool', tool_call_id: 'call_0', content: '12:00' },
      ],
    });
  });

  it('turns an HTTP error into a provider error and still releases the model', async () => {
    const llama = await server((_body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: 'the request exceeds the available context size' } }),
      );
    });
    const { rt, state } = runtime(llama.url);
    const stream = createBuiltinProvider(rt).stream(request, new AbortController().signal);
    await expect(collect(stream)).rejects.toThrow(
      /HTTP 400: the request exceeds the available context/,
    );
    expect(state.released).toBe(1);
  });

  it('ends quietly when the caller stops it', async () => {
    const llama = await server((_body, res) => sse(res, [delta({ content: 'Once' })], false));
    const { rt, state } = runtime(llama.url);
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    for await (const event of createBuiltinProvider(rt).stream(request, controller.signal)) {
      events.push(event);
      if (event.type === 'text') controller.abort();
    }
    expect(events).toEqual([
      { type: 'text', text: 'Once' },
      { type: 'done', finishReason: 'cancelled' },
    ]);
    expect(state.released).toBe(1);
  });

  it('explains a model that would not load', async () => {
    const rt: BuiltinRuntime = {
      models: () => [],
      acquire: () => Promise.reject(new Error('out of memory')),
    };
    const stream = createBuiltinProvider(rt).stream(request, new AbortController().signal);
    await expect(collect(stream)).rejects.toThrow(ProviderError);
  });

  it('lists the pulled models and their capabilities', async () => {
    const { rt } = runtime('http://unused');
    const provider = createBuiltinProvider(rt);
    expect(await provider.listModels()).toEqual([
      {
        id: 'tiny:1b',
        title: 'Tiny',
        capabilities: { tools: true, vision: false, reasoning: true },
        contextWindow: 4096,
      },
    ]);
    expect(provider.capabilities('tiny:1b')).toEqual({
      tools: true,
      vision: false,
      contextWindow: 4096,
    });
    expect(provider.capabilities('other')).toEqual({
      tools: false,
      vision: false,
      contextWindow: 0,
    });
  });
});

describe('sseData', () => {
  it('splits events across chunk boundaries and joins multi-line data', async () => {
    const text = 'data: one\n\nevent: ping\n\ndata: two\ndata: lines\r\n\r\ndata: [DONE]';
    const encoded = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < encoded.length; i += 3) controller.enqueue(encoded.slice(i, i + 3));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const data of sseData(body)) out.push(data);
    expect(out).toEqual(['one', 'two\nlines', '[DONE]']);
  });
});
