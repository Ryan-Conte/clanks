import { type ChatEvent, defaultSettings } from '@clanks/core';
import { createBuiltinProvider } from '@clanks/providers';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ModelManager } from './manager';
import { type ModelRepository, memoryRepository } from './store';
import { tempDir } from './test/fixtures';

const llamaDir =
  process.env.CLANKS_LLAMA_DIR ??
  fileURLToPath(new URL('../../../apps/desktop/resources/llama', import.meta.url));
// A 19 MB model, so CI can pull it every run. Override to try a real one.
const ref = process.env.CLANKS_E2E_MODEL ?? 'hf.co/ggml-org/tiny-llamas:Q4_0';

/** A model manager as the app makes one, over the given folder and records. */
function manager(root: string, repo: ModelRepository): ModelManager {
  const models = new ModelManager({
    runtimeDir: join(root, 'runtime'),
    logsDir: join(root, 'logs'),
    defaultModelsDir: join(root, 'models'),
    modelsDir: { get: () => null, set: () => {} },
    bundledRuntimeDir: llamaDir,
    repo,
    settings: () => ({ ...defaultSettings, contextPerSlot: 4096, parallelSlots: 1 }),
  });
  onTestFinished(() => models.close());
  return models;
}

/** Only loopback from here: anything else fails as if the network were unplugged. */
function unplugNetwork(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      return Promise.reject(new TypeError(`fetch failed: the network is unplugged (${url.host})`));
    }
    return real(input, init);
  };
  onTestFinished(() => {
    globalThis.fetch = real;
  });
}

describe.skipIf(!existsSync(llamaDir))('the bundled runtime, for real', () => {
  it('pulls a model, then starts offline, loads it and answers a prompt', async () => {
    const root = tempDir();
    const repo = memoryRepository();

    const online = manager(root, repo);
    await online.start();
    const hardware = online.hardware()!;
    console.log(
      `Running on ${hardware.backend}, ${hardware.gpus.map((g) => g.name).join(', ') || 'CPU'}`,
    );
    expect(online.runtime().builds.length).toBeGreaterThan(0);
    const pull = online.pull(ref);
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        const status = online.pulls.get(pull.id);
        if (status?.state === 'done') resolve();
        if (status?.state === 'failed') reject(new Error(status.error ?? 'pull failed'));
      };
      online.on('change', check);
      check();
    });
    online.close();

    // A fresh start with the network gone: the probe, the load and the reply must all work.
    unplugNetwork();
    const offline = manager(root, repo);
    await offline.start();
    const [model] = offline.library();
    expect(model?.missing).toBe(false);
    const provider = createBuiltinProvider({
      models: () => offline.library().map((m) => ({ ...m, contextLength: m.facts.contextLength })),
      acquire: (id, signal) => offline.acquire(id, signal),
    });
    const events: ChatEvent[] = [];
    for await (const event of provider.stream(
      {
        model: model!.id,
        messages: [{ role: 'user', content: 'Once upon a time' }],
        maxTokens: 24,
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
    console.log(`${model!.id} said: ${text}`);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    const usage = events.find((e) => e.type === 'usage');
    expect(usage?.type === 'usage' && usage.usage.completionTokens).toBeGreaterThan(0);

    const [loaded] = offline.runtime().loaded;
    expect(loaded).toMatchObject({ modelId: model!.id, state: 'ready' });
    expect(loaded!.placement).not.toBeNull();
    expect(loaded!.tokensPerSecond).toBeGreaterThan(0);
  });
});
