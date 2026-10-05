import { type ChatEvent, type ModelRecord, defaultSettings } from '@clanks/core';
import { ProviderRegistry, createFakeProvider } from '@clanks/providers';
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { appRouter, createAppCaller } from './router';
import { sqliteModelRepository } from './store/models';
import { startTestOrchestrator } from './test-helpers';

function setup() {
  const orchestrator = startTestOrchestrator();
  return { orchestrator, caller: createAppCaller(orchestrator.context) };
}

/** A model as if it had been pulled; its files aren't on disk. */
function pulledModel(id: string): ModelRecord {
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
      contextLength: 4096,
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

describe('app router', () => {
  it('reports the app, its data folder and the database', async () => {
    const { orchestrator, caller } = setup();
    const info = await caller.app.info();
    expect(info.version).toBe('0.0.0-test');
    expect(info.dataDir).toBe(orchestrator.paths.root);
    expect(info.store.file).toBe(orchestrator.paths.database);
    expect(info.store.migrations).toBeGreaterThan(0);
  });

  it('reads and updates settings', async () => {
    const { caller } = setup();
    expect(await caller.settings.get()).toEqual(defaultSettings);
    expect(await caller.settings.update({ closeToTray: false })).toEqual({
      ...defaultSettings,
      closeToTray: false,
    });
    expect((await caller.settings.get()).closeToTray).toBe(false);
  });

  it('validates settings input', async () => {
    const { caller } = setup();
    // @ts-expect-error wrong type
    await expect(caller.settings.update({ closeToTray: 'yes' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.settings.update({ crewModel: 'Not An Id' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('saves, checks and deletes secrets', async () => {
    const { orchestrator, caller } = setup();
    expect(await caller.secrets.status()).toEqual({ available: true, backend: 'fake' });
    await caller.secrets.set({ ref: 'provider:anthropic', value: 'sk-test' });
    expect(await caller.secrets.has('provider:anthropic')).toBe(true);
    expect(orchestrator.context.secrets.get('provider:anthropic')).toBe('sk-test');
    expect(await caller.secrets.delete('provider:anthropic')).toBe(true);
    expect(await caller.secrets.has('provider:anthropic')).toBe(false);
    await expect(caller.secrets.set({ ref: 'Bad Ref', value: 'x' })).rejects.toBeInstanceOf(
      TRPCError,
    );
  });

  it('never hands a secret to the window', () => {
    const paths = Object.keys(appRouter._def.procedures);
    expect(paths).toContain('secrets.set');
    expect(paths.filter((path) => path.startsWith('secrets.'))).toEqual([
      'secrets.status',
      'secrets.has',
      'secrets.set',
      'secrets.delete',
    ]);
  });
});

describe('models router', () => {
  it('shows the machine, the catalog and a suggestion once the hardware is probed', async () => {
    const { orchestrator, caller } = setup();
    await orchestrator.ready;
    const snapshot = await caller.models.snapshot();
    expect(snapshot.hardware?.backend).toBe('cuda');
    expect(snapshot.catalog.length).toBeGreaterThan(5);
    expect(snapshot.catalog.every((item) => item.fit !== null)).toBe(true);
    expect(snapshot.recommended).toBe('qwen3.6:35b');
    expect(snapshot).toMatchObject({ library: [], pulls: [], crewModel: null, move: null });
    expect(snapshot.runtime).toMatchObject({ version: 'b11146', loaded: [] });
  });

  it('streams a new snapshot when something changes', async () => {
    const { orchestrator } = setup();
    await orchestrator.ready;
    const controller = new AbortController();
    const live = (
      await createAppCaller(orchestrator.context, { signal: controller.signal }).models.live()
    )[Symbol.asyncIterator]();
    expect((await live.next()).value?.library).toEqual([]);
    sqliteModelRepository(orchestrator.context.store.db).putModel(pulledModel('tiny:1b'));
    orchestrator.context.models.emit('change');
    expect((await live.next()).value?.library.map((m) => m.id)).toEqual(['tiny:1b']);
    // Giving the crew a model is a settings change, and shows up too.
    await createAppCaller(orchestrator.context).models.useForCrew('tiny:1b');
    expect((await live.next()).value?.crewModel).toBe('tiny:1b');
    controller.abort();
    await live.return?.();
  });

  it('turns bad refs and unknown models into plain errors', async () => {
    const { orchestrator, caller } = setup();
    await orchestrator.ready;
    await expect(caller.models.pull('not a model')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/isn't a model name/) as string,
    });
    await expect(caller.models.useForCrew('tiny:1b')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: "tiny:1b isn't pulled",
    });
    await expect(caller.models.inspect('nonesuch:1b')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('gives the crew a model, and takes it back when the model is removed', async () => {
    const { orchestrator, caller } = setup();
    await orchestrator.ready;
    sqliteModelRepository(orchestrator.context.store.db).putModel(pulledModel('tiny:1b'));
    expect(await caller.models.useForCrew('tiny:1b')).toMatchObject({
      crewModel: 'tiny:1b',
      onboarded: true,
    });
    await caller.models.remove('tiny:1b');
    expect((await caller.settings.get()).crewModel).toBeNull();
    expect((await caller.models.snapshot()).library).toEqual([]);
  });

  it('streams a reply to try a model', async () => {
    const { orchestrator } = setup();
    const providers = new ProviderRegistry();
    const fake = createFakeProvider({
      id: 'builtin',
      replies: [
        [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: '!' },
        ],
      ],
    });
    providers.register(fake);
    const caller = createAppCaller({ ...orchestrator.context, providers });
    const events: ChatEvent[] = [];
    for await (const event of await caller.models.try({ model: 'tiny:1b', prompt: ' Hi ' })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: '!' },
      { type: 'done', finishReason: 'stop' },
    ]);
    expect(fake.requests[0]).toEqual({
      model: 'tiny:1b',
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 4096,
    });
  });

  it('reports a model that fails to answer as a plain error', async () => {
    const { orchestrator, caller } = setup();
    await orchestrator.ready;
    const stream = await caller.models.try({ model: 'tiny:1b', prompt: 'Hi' });
    const run = async () => {
      for await (const _ of stream) {
        // Nothing should arrive.
      }
    };
    await expect(run()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/Couldn't load tiny:1b/) as string,
    });
  });
});
