import type { ChatEvent, ChatLiveEvent, ChatRequest, ModelRecord } from '@clanks/core';
import { type Provider, createFakeProvider } from '@clanks/providers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sqliteModelRepository } from '../store/models';
import { startTestOrchestrator, tempDir } from '../test-helpers';
import { fitHistory, titleFrom, toTurns } from './service';

const MODEL = 'tiny:1b';

function pulled(id = MODEL, contextLength = 32_768): ModelRecord {
  return {
    id,
    source: 'catalog',
    title: id,
    repo: 'test/repo',
    revision: 'a'.repeat(40),
    quant: 'Q4_0',
    params: '1B',
    license: 'mit',
    tags: ['general'],
    capabilities: { tools: true, vision: false, reasoning: false },
    files: [{ role: 'model', path: 'm.gguf', sha256: 'b'.repeat(64), size: 1000 }],
    facts: {
      architecture: 'llama',
      blockCount: 2,
      contextLength,
      kvPerToken: 10,
      swaKvPerToken: 0,
      slidingWindow: 0,
      parameterCount: null,
    },
    size: 1000,
    keepLoaded: false,
    pulledAt: new Date(),
  };
}

/** A provider whose replies wait until the test lets each event through. */
function gatedProvider() {
  const requests: ChatRequest[] = [];
  const pending: ((event: ChatEvent | null) => void)[] = [];
  const queued: (ChatEvent | null)[] = [];
  const next = () =>
    new Promise<ChatEvent | null>((resolve) => {
      const event = queued.shift();
      if (event !== undefined) resolve(event);
      else pending.push(resolve);
    });
  const provider: Provider = {
    id: 'builtin',
    listModels: () => Promise.resolve([]),
    capabilities: () => ({ tools: true, vision: false, contextWindow: 0 }),
    async *stream(request, signal) {
      requests.push(structuredClone(request));
      for (;;) {
        const event = await Promise.race([
          next(),
          new Promise<'aborted'>((resolve) =>
            signal.addEventListener('abort', () => resolve('aborted'), { once: true }),
          ),
        ]);
        if (event === 'aborted' || signal.aborted) {
          yield { type: 'done', finishReason: 'cancelled' };
          return;
        }
        if (event === null) return;
        yield event;
        if (event.type === 'done') return;
      }
    },
  };
  return {
    provider,
    requests,
    /** Lets one event through; null ends the stream without a `done`. */
    push(event: ChatEvent | null) {
      const resolve = pending.shift();
      if (resolve) resolve(event);
      else queued.push(event);
    },
  };
}

function setup(options: { dataDir?: string; provider?: Provider } = {}) {
  const orchestrator = startTestOrchestrator(options.dataDir ? { dataDir: options.dataDir } : {});
  const { context } = orchestrator;
  sqliteModelRepository(context.store.db).putModel(pulled());
  // The model's file, as if it had been pulled.
  const blobs = join(orchestrator.paths.models, 'blobs');
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(blobs, `sha256-${'b'.repeat(64)}`), 'gguf');
  context.settings.update({
    crewModel: MODEL,
    profile: { name: 'Sam', timeZone: 'UTC', language: '', preferences: '' },
  });
  const fake =
    options.provider ??
    createFakeProvider({
      id: 'builtin',
      replies: () => [
        { type: 'reasoning', text: 'Hm.' },
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'Sam.' },
        {
          type: 'usage',
          usage: {
            promptTokens: 1200,
            completionTokens: 3,
            tokensPerSecond: 50,
            promptTokensPerSecond: 900,
            durationMs: 800,
          },
        },
        { type: 'done', finishReason: 'stop' },
      ],
    });
  context.providers.replace(fake);
  return { orchestrator, chat: context.chat, context };
}

/** Waits until a conversation has no reply being written. */
async function settled(chat: ReturnType<typeof setup>['chat'], id: string) {
  for (let i = 0; i < 200 && chat.get(id).conversation.replying; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(chat.get(id).conversation.replying).toBe(false);
}

describe('ChatService', () => {
  it('starts a chat, writes the reply and saves it with its usage', async () => {
    const { chat, context } = setup();
    const events: ChatLiveEvent[] = [];
    chat.on('live', (_id, event) => events.push(event));
    const { conversation, reply } = chat.start('atlas', '  Build me a surf shop website  ');
    expect(conversation).toMatchObject({ clankId: 'atlas', title: 'Build me a surf shop website' });
    expect(reply).toMatchObject({ role: 'assistant', status: 'streaming', content: '' });
    await settled(chat, conversation.id);

    const { messages } = chat.get(conversation.id);
    expect(messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ['user', 'Build me a surf shop website', 'done'],
      ['assistant', 'Hello Sam.', 'done'],
    ]);
    expect(messages[1]).toMatchObject({
      reasoning: 'Hm.',
      model: { provider: 'builtin', model: MODEL },
      finishReason: 'stop',
      usage: { promptTokens: 1200, completionTokens: 3, durationMs: 800 },
    });
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => e.type === 'delta' && e.text + e.reasoning),
    ).toEqual(['Hm.', 'Hello ', 'Sam.']);

    const request = (context.providers.get('builtin') as ReturnType<typeof createFakeProvider>)
      .requests[0]!;
    expect(request.model).toBe(MODEL);
    expect(request.temperature).toBe(0.3);
    expect(request.messages[0]!.role).toBe('system');
    expect(request.messages[0]!.content).toMatch(/^You are Atlas, one of the clanks/);
    expect(request.messages[0]!.content).toContain(
      'Mode: chat. You are talking with Sam directly.',
    );
    expect(request.messages.slice(1)).toEqual([
      { role: 'user', content: 'Build me a surf shop website' },
    ]);
    // A 32k slot, less the prompt: the reply gets the most a local model is asked for.
    expect(request.maxTokens).toBe(16_384);
  });

  it('sends the whole conversation, without the thinking', async () => {
    const { chat, context } = setup();
    const { conversation } = chat.start('forge', 'Hi');
    await settled(chat, conversation.id);
    chat.send(conversation.id, 'And again');
    await settled(chat, conversation.id);
    const fake = context.providers.get('builtin') as ReturnType<typeof createFakeProvider>;
    expect(fake.requests[1]!.messages.slice(1)).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello Sam.' },
      { role: 'user', content: 'And again' },
    ]);
    expect(chat.list()[0]).toMatchObject({ id: conversation.id, replying: false });
  });

  it('needs a model before anything is saved', () => {
    const { chat, context } = setup();
    context.settings.update({ crewModel: null });
    expect(() => chat.start('atlas', 'Hi')).toThrow(
      'Pick a model for the crew on the Models screen first.',
    );
    expect(chat.list()).toEqual([]);
    context.crew.updateProfile('quill', { model: { provider: 'anthropic', model: 'claude-x' } });
    expect(() => chat.start('quill', 'Hi')).toThrow(
      /runs on claude-x at Anthropic, which isn't set up/,
    );
  });

  it('stops a reply and keeps what it had written', async () => {
    const gate = gatedProvider();
    const { chat } = setup({ provider: gate.provider });
    const { conversation, reply } = chat.start('scout', 'Research surfboards');
    gate.push({ type: 'text', text: 'Fibreglass boards' });
    for (let i = 0; i < 50 && chat.inFlight(conversation.id)?.content === ''; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(chat.inFlight(conversation.id)).toMatchObject({
      id: reply.id,
      content: 'Fibreglass boards',
    });
    expect(() => chat.send(conversation.id, 'More')).toThrow(/still being written/);
    chat.stop(conversation.id);
    await settled(chat, conversation.id);
    expect(chat.get(conversation.id).messages[1]).toMatchObject({
      status: 'cancelled',
      finishReason: 'cancelled',
      content: 'Fibreglass boards',
    });
  });

  it('shows why a reply failed, and writes it again on retry', async () => {
    let calls = 0;
    const provider = createFakeProvider({
      id: 'builtin',
      replies: () => {
        calls++;
        if (calls === 1) throw new (class extends Error {})('boom');
        return [{ type: 'text', text: 'Second time lucky.' }];
      },
    });
    const { chat } = setup({ provider });
    const { conversation } = chat.start('atlas', 'Hi');
    await settled(chat, conversation.id);
    expect(chat.get(conversation.id).messages[1]).toMatchObject({
      status: 'failed',
      error: 'Something went wrong: boom',
    });
    const reply = chat.retry(conversation.id);
    await settled(chat, conversation.id);
    const { messages } = chat.get(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: reply.id,
      status: 'done',
      content: 'Second time lucky.',
    });
  });

  it("follows a folder's CLANKS.md", async () => {
    const { chat, context } = setup();
    const folder = join(tempDir(), 'surf');
    mkdirSync(folder);
    writeFileSync(
      join(folder, 'CLANKS.md'),
      '# Surf\n\nPrices include GST.\n\n## For Gauge\n\nTest on mobile.',
    );
    const { conversation } = chat.start('forge', 'Hi');
    await settled(chat, conversation.id);
    expect(chat.setFolder(conversation.id, folder).folder).toBe(folder);
    expect(() => chat.setFolder(conversation.id, join(folder, 'nope'))).toThrow(/isn't a folder/);
    chat.send(conversation.id, 'What do prices include?');
    await settled(chat, conversation.id);
    const fake = context.providers.get('builtin') as ReturnType<typeof createFakeProvider>;
    const system = fake.requests[1]!.messages[0]!.content;
    expect(system).toContain('Sam wrote these in `CLANKS.md` for this project.');
    expect(system).toContain('Prices include GST.');
    expect(system).not.toContain('Test on mobile.');
    expect((await chat.preview('forge', conversation.id)).layers.map((l) => l.id)).toContain(
      'instructions',
    );
  });

  it('keeps conversations across restarts, and marks replies a crash cut off', async () => {
    const dataDir = join(tempDir(), 'clanks');
    const gate = gatedProvider();
    const first = setup({ dataDir, provider: gate.provider });
    const { conversation } = first.chat.start('quill', 'Write a tagline');
    gate.push({ type: 'text', text: 'Ride the' });
    for (let i = 0; i < 50 && first.chat.inFlight(conversation.id)?.content === ''; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Quitting saves the reply as far as it got.
    first.orchestrator.close();

    const second = setup({ dataDir });
    expect(second.chat.list().map((c) => c.title)).toEqual(['Write a tagline']);
    const { messages } = second.chat.get(conversation.id);
    expect(messages[1]).toMatchObject({ status: 'cancelled', content: 'Ride the' });
    second.chat.send(conversation.id, 'Finish it');
    await settled(second.chat, conversation.id);
    expect(second.chat.get(conversation.id).messages).toHaveLength(4);
  });

  it('renames and deletes chats, even mid-reply', async () => {
    const gate = gatedProvider();
    const { chat } = setup({ provider: gate.provider });
    const { conversation } = chat.start('buzz', 'Plan a launch');
    expect(chat.rename(conversation.id, '  Launch plan ').title).toBe('Launch plan');
    await chat.delete(conversation.id);
    expect(chat.list()).toEqual([]);
    expect(() => chat.get(conversation.id)).toThrow('That chat was deleted');
  });
});

describe('history', () => {
  const message = (role: 'user' | 'assistant', content: string) =>
    ({ role, content }) as Parameters<typeof toTurns>[0][number];

  it('joins turns by the same speaker and skips empty replies', () => {
    expect(
      toTurns([
        message('user', 'One'),
        message('assistant', ''),
        message('user', 'Two'),
        message('assistant', 'Reply'),
      ]),
    ).toEqual([
      { role: 'user', content: 'One\n\nTwo' },
      { role: 'assistant', content: 'Reply' },
    ]);
  });

  it('drops the oldest turns to fit, always keeping the latest and starting with the user', () => {
    const turns = [
      { role: 'user' as const, content: 'a'.repeat(400) },
      { role: 'assistant' as const, content: 'b'.repeat(400) },
      { role: 'user' as const, content: 'c'.repeat(400) },
      { role: 'assistant' as const, content: 'd'.repeat(400) },
      { role: 'user' as const, content: 'e'.repeat(400) },
    ];
    expect(fitHistory(turns, 1000)).toHaveLength(5);
    expect(fitHistory(turns, 300).map((t) => t.content[0])).toEqual(['c', 'd', 'e']);
    // Room for two turns, but the older is the model's, so only the latest goes.
    expect(fitHistory(turns, 250).map((t) => t.content[0])).toEqual(['e']);
    expect(fitHistory(turns, 10).map((t) => t.content[0])).toEqual(['e']);
  });

  it('titles a chat from its first words', () => {
    expect(titleFrom('Fix\nthe   footer link')).toBe('Fix the footer link');
    expect(
      titleFrom(
        'Build me a surfing website that sells surf boards, wetsuits and wax to Australians',
      ),
    ).toBe('Build me a surfing website that sells surf boards, wetsuits…');
  });
});
