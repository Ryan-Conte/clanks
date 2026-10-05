import { type Catalog, type HardwareInfo, defaultSettings } from '@clanks/core';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { GIB } from './fit';
import { ggufFacts } from './gguf';
import { ModelManager } from './manager';
import { memoryRepository } from './store';
import {
  type FakeRepo,
  fakeBuild,
  fakeHuggingFace,
  ggufFile,
  llamaMetadata,
  sha256,
  startServer,
  tempDir,
} from './test/fixtures';

const KB = 1024;
const weights = ggufFile(llamaMetadata(), 300 * KB);
const other = ggufFile(llamaMetadata({ 'general.name': 'Other' }), 200 * KB);
const fakeRepo: FakeRepo = {
  repo: 'test/Tiny-GGUF',
  revision: 'b'.repeat(40),
  license: 'mit',
  files: { 'Tiny-Q4_0.gguf': weights, 'Tiny-Q8_0.gguf': other },
};

const catalog: Catalog = {
  version: 1,
  models: [
    {
      name: 'tiny',
      tag: '1b',
      title: 'Tiny 1B',
      summary: 'For tests.',
      repo: fakeRepo.repo,
      revision: fakeRepo.revision,
      quant: 'Q4_0',
      params: '1B',
      license: 'mit',
      tags: ['general'],
      capabilities: { tools: true, vision: false, reasoning: false },
      files: [
        { role: 'model', path: 'Tiny-Q4_0.gguf', sha256: sha256(weights), size: weights.length },
      ],
      facts: ggufFacts(llamaMetadata()),
    },
  ],
};

const hardware: HardwareInfo = {
  platform: process.platform,
  arch: process.arch,
  cpu: { model: 'Test CPU', threads: 8 },
  memory: { totalBytes: 32 * GIB, freeBytes: 16 * GIB, unified: false },
  gpus: [
    { id: 'CUDA0', name: 'Test GPU', backend: 'cuda', totalBytes: 24 * GIB, freeBytes: 24 * GIB },
  ],
  nvidia: true,
  backend: 'cuda',
  budget: { gpuBytes: 22 * GIB, systemBytes: 24 * GIB },
  problems: [],
  probedAt: new Date(),
};

async function setup() {
  const root = tempDir();
  const server = await startServer(fakeHuggingFace([fakeRepo]));
  const fake = fakeBuild(root);
  let movedTo: string | null = null;
  const repo = memoryRepository();
  const manager = new ModelManager({
    runtimeDir: join(root, 'runtime'),
    logsDir: join(root, 'logs'),
    defaultModelsDir: join(root, 'models'),
    modelsDir: { get: () => movedTo, set: (dir) => (movedTo = dir) },
    repo,
    settings: () => ({ ...defaultSettings, contextPerSlot: 2048 }),
    hfEndpoint: server.url,
    catalog,
    builds: () => [fake.build],
    probe: (builds) => Promise.resolve({ hardware, build: builds[0]! }),
    retryDelayMs: () => 1,
  });
  onTestFinished(() => manager.close());
  await manager.start();
  return { root, manager, repo, server, movedTo: () => movedTo };
}

function pulled(manager: ModelManager, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const pull = manager.pulls.get(id);
      if (pull?.state === 'done') {
        manager.off('change', check);
        resolve();
      } else if (pull?.state === 'failed') {
        manager.off('change', check);
        reject(new Error(pull.error ?? 'failed'));
      }
    };
    manager.on('change', check);
    check();
  });
}

describe('ModelManager', () => {
  it('shows the catalog with an estimate for this machine', async () => {
    const { manager } = await setup();
    const [item] = manager.catalog();
    expect(item).toMatchObject({ id: 'tiny:1b', pulled: false, size: weights.length });
    expect(item!.fit?.verdict).toBe('gpu');
    expect(manager.recommended()).toBe('tiny:1b');
    expect(manager.hardware()?.backend).toBe('cuda');
  });

  it('previews a Hugging Face model before pulling it', async () => {
    const { manager } = await setup();
    const preview = await manager.inspect('hf.co/test/Tiny-GGUF:Q8_0');
    expect(preview).toMatchObject({
      id: 'hf.co/test/Tiny-GGUF:Q8_0',
      title: 'Other',
      license: 'mit',
      size: other.length,
      downloadBytes: other.length,
      pulled: false,
    });
    expect(preview.fit?.verdict).toBe('gpu');
  });

  it('pulls what it just previewed without looking it up again', async () => {
    const { manager, server } = await setup();
    await manager.inspect('hf.co/test/Tiny-GGUF:Q8_0');
    await pulled(manager, manager.pull('hf.co/test/Tiny-GGUF:Q8_0').id);
    const lookups = server.requests.filter((r) =>
      r.path.startsWith('/api/models/test/Tiny-GGUF/tree'),
    );
    expect(lookups).toHaveLength(1);
  });

  it('pulls, runs and removes a model', async () => {
    const { manager, root } = await setup();
    await pulled(manager, manager.pull('tiny:1b').id);
    expect(manager.library()).toMatchObject([{ id: 'tiny:1b', loaded: false, missing: false }]);
    expect(manager.catalog()[0]!.pulled).toBe(true);
    expect((await manager.inspect('tiny:1b')).downloadBytes).toBe(0);

    const lease = await manager.acquire('tiny:1b');
    const response = await fetch(`${lease.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lease.apiKey}` },
      body: JSON.stringify({ model: lease.model, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.ok).toBe(true);
    lease.release();
    expect(manager.runtime().loaded).toMatchObject([{ modelId: 'tiny:1b', state: 'ready' }]);
    expect(manager.library()[0]!.loaded).toBe(true);

    await manager.remove('tiny:1b');
    expect(manager.library()).toEqual([]);
    expect(manager.runtime().loaded).toEqual([]);
    expect(readdirSync(join(root, 'models', 'blobs'))).toEqual([]);
  });

  it('keeps a file another model still uses', async () => {
    const { manager } = await setup();
    await pulled(manager, manager.pull('tiny:1b').id);
    await pulled(manager, manager.pull('hf.co/test/Tiny-GGUF:Q4_0').id);
    await manager.remove('tiny:1b');
    expect(manager.library()).toMatchObject([{ id: 'hf.co/test/Tiny-GGUF:Q4_0', missing: false }]);
  });

  it('remembers to keep a model loaded', async () => {
    const { manager, repo } = await setup();
    await pulled(manager, manager.pull('tiny:1b').id);
    manager.setKeepLoaded('tiny:1b', true);
    expect(repo.getModel('tiny:1b')?.keepLoaded).toBe(true);
    await manager.load('tiny:1b');
    expect(manager.runtime().loaded[0]).toMatchObject({ keepLoaded: true, idleUnloadAt: null });
  });

  it('moves the models folder and keeps running from the new place', async () => {
    const { manager, root, movedTo } = await setup();
    await pulled(manager, manager.pull('tiny:1b').id);
    await manager.load('tiny:1b');
    const busy = join(root, 'elsewhere');
    mkdirSync(busy);
    writeFileSync(join(busy, 'notes.txt'), 'not models');

    await manager.moveStorage(busy);
    const to = join(busy, 'clanks-models');
    expect(movedTo()).toBe(to);
    expect((await manager.storage()).dir).toBe(to);
    expect(readdirSync(join(to, 'blobs'))).toEqual([`sha256-${sha256(weights)}`]);
    expect(existsSync(join(root, 'models', 'blobs', `sha256-${sha256(weights)}`))).toBe(false);
    expect(manager.runtime().loaded).toEqual([]);

    (await manager.acquire('tiny:1b')).release();
    expect((await manager.storage()).usedBytes).toBeGreaterThanOrEqual(weights.length);
  });

  it("won't download a build this machine has no use for", async () => {
    const { manager } = await setup();
    await expect(manager.installRuntime('metal')).rejects.toThrow(/no metal build/);
  });

  it("explains a ref it can't find", async () => {
    const { manager } = await setup();
    await expect(manager.inspect('nothing:here')).rejects.toThrow(/isn't in the catalog/);
    await expect(manager.inspect('tiny:9b')).rejects.toThrow(/Try tiny:1b/);
  });
});
