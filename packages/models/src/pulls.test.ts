import type { Catalog, CatalogEntry, PullStatus } from '@clanks/core';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ggufFacts } from './gguf';
import { HuggingFaceClient } from './huggingface';
import { PullManager } from './pulls';
import { resolveModelRef } from './resolve';
import { BlobStore, type ModelRepository, memoryRepository } from './store';
import {
  type FakeRepo,
  type FileOptions,
  bytes,
  fakeHuggingFace,
  ggufFile,
  llamaMetadata,
  sha256,
  startServer,
  tempDir,
} from './test/fixtures';

const KB = 1024;
const weights = ggufFile(llamaMetadata(), 600 * KB);
const projector = bytes(80 * KB, 3);
const fakeRepo: FakeRepo = {
  repo: 'test/Tiny-GGUF',
  revision: 'a'.repeat(40),
  license: 'mit',
  files: { 'Tiny-Q4_0.gguf': weights, 'mmproj-Tiny-F16.gguf': projector, 'README.md': bytes(10) },
};

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
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
    ...overrides,
  };
}

interface SetupOptions {
  catalog?: CatalogEntry[];
  server?: FileOptions;
  repo?: ModelRepository;
  dir?: string;
  freeBytes?: number;
}

async function setup(options: SetupOptions = {}) {
  const server = await startServer(fakeHuggingFace([fakeRepo], options.server));
  const hf = new HuggingFaceClient({ endpoint: server.url });
  const catalog: Catalog = { version: 1, models: options.catalog ?? [entry()] };
  const repo = options.repo ?? memoryRepository();
  const dir = options.dir ?? tempDir();
  const store = new BlobStore(dir);
  if (options.freeBytes !== undefined) store.freeBytes = () => Promise.resolve(options.freeBytes!);
  const pulls = new PullManager({
    repo,
    store: () => store,
    resolve: (ref, signal) => resolveModelRef(ref, { catalog, hf }, signal),
    connections: 2,
    retryDelayMs: () => 1,
  });
  await pulls.start();
  return { server, repo, dir, store, pulls };
}

function until(
  pulls: PullManager,
  check: (statuses: PullStatus[]) => boolean,
  timeoutMs = 10_000,
): Promise<PullStatus[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pulls.off('change', onChange);
      reject(new Error(`Timed out: ${JSON.stringify(pulls.list())}`));
    }, timeoutMs);
    const onChange = () => {
      const statuses = pulls.list();
      if (!check(statuses)) return;
      clearTimeout(timer);
      pulls.off('change', onChange);
      resolve(statuses);
    };
    pulls.on('change', onChange);
    onChange();
  });
}

const settled = (id: string) => (statuses: PullStatus[]) =>
  statuses.some((s) => s.id === id && (s.state === 'done' || s.state === 'failed'));

describe('PullManager', () => {
  it('pulls a model from a Hugging Face repo, projector and all', async () => {
    const { pulls, repo, store, dir } = await setup();
    const pulled: string[] = [];
    pulls.on('pulled', (model) => pulled.push(model.id));
    const { id } = pulls.pull('hf.co/test/Tiny-GGUF');
    const [status] = (await until(pulls, settled(id))).filter((s) => s.id === id);

    expect(status).toMatchObject({
      state: 'done',
      modelId: 'hf.co/test/Tiny-GGUF:Q4_0',
      error: null,
    });
    expect(status!.doneBytes).toBe(weights.length + projector.length);
    const model = repo.getModel('hf.co/test/Tiny-GGUF:Q4_0')!;
    expect(model).toMatchObject({
      source: 'huggingface',
      title: 'Tiny Llama',
      license: 'mit',
      params: '15M',
    });
    expect(model.capabilities.vision).toBe(true);
    expect(model.files.map((f) => f.role)).toEqual(['model', 'projector']);
    expect(readFileSync(store.blobPath(sha256(weights)))).toEqual(weights);
    expect(readFileSync(store.blobPath(sha256(projector)))).toEqual(projector);
    expect(readdirSync(`${dir}/partial`)).toEqual([]);
    expect(repo.listPulls()).toEqual([]);
    expect(pulled).toEqual(['hf.co/test/Tiny-GGUF:Q4_0']);
  });

  it('pulls a catalog model by name', async () => {
    const { pulls, repo } = await setup();
    const { id } = pulls.pull('tiny:1b');
    await until(pulls, settled(id));
    expect(repo.getModel('tiny:1b')).toMatchObject({ source: 'catalog', quant: 'Q4_0' });
  });

  it('returns the pull under way instead of starting another', async () => {
    const { pulls } = await setup({ server: { delayMs: 2 } });
    const first = pulls.pull('tiny:1b');
    expect(pulls.pull('tiny:1b').id).toBe(first.id);
    await until(pulls, settled(first.id));
  });

  it('pauses and resumes, keeping what it had', async () => {
    const { pulls, repo } = await setup({ server: { delayMs: 3 } });
    const { id } = pulls.pull('tiny:1b');
    await until(pulls, (s) => s[0]!.doneBytes > 100 * KB);
    pulls.pause(id);
    const [paused] = await until(pulls, (s) => s[0]!.state === 'paused');
    expect(repo.listPulls()[0]!.state).toBe('paused');
    expect(paused!.doneBytes).toBeGreaterThan(0);

    pulls.resume(id);
    await until(pulls, settled(id));
    expect(repo.getModel('tiny:1b')).toBeDefined();
  });

  it('carries on after a restart from what was saved', async () => {
    const shared = memoryRepository();
    const dir = tempDir();
    const first = await setup({ repo: shared, dir, server: { delayMs: 3 } });
    const { id } = first.pulls.pull('tiny:1b');
    await until(first.pulls, (s) => s[0]!.doneBytes > 200 * KB);
    // The app quits mid-download.
    await first.pulls.shutdown();
    const record = shared.listPulls()[0]!;
    expect(record.state).toBe('downloading');
    const saved = Object.values(record.chunks)[0]!.reduce((sum, c) => sum + c.done, 0);
    expect(saved).toBeGreaterThan(0);

    const second = await setup({ repo: shared, dir });
    await until(second.pulls, settled(id));
    expect(second.pulls.get(id)?.state).toBe('done');
    expect(readFileSync(second.store.blobPath(sha256(weights)))).toEqual(weights);
    const fetched = second.server.requests
      .filter((r) => r.method === 'GET' && r.path.startsWith('/cdn/'))
      .map((r) => /bytes=(\d+)-(\d+)/.exec(r.range!)!)
      .reduce((sum, m) => sum + Number(m[2]) - Number(m[1]) + 1, 0);
    expect(fetched).toBe(weights.length - saved);
  });

  it('cancels, deleting the partial download', async () => {
    const { pulls, repo, dir } = await setup({ server: { delayMs: 3 } });
    const { id } = pulls.pull('tiny:1b');
    await until(pulls, (s) => s[0]!.doneBytes > 50 * KB);
    await pulls.cancel(id);
    await until(pulls, (s) => s.length === 0);
    expect(repo.listPulls()).toEqual([]);
    expect(readdirSync(`${dir}/partial`)).toEqual([]);
  });

  it('throws away a download that fails its checksum', async () => {
    const bad = entry({
      files: [
        { role: 'model', path: 'Tiny-Q4_0.gguf', sha256: 'f'.repeat(64), size: weights.length },
      ],
    });
    const { pulls, repo, store, dir } = await setup({ catalog: [bad] });
    const { id } = pulls.pull('tiny:1b');
    const status = (await until(pulls, settled(id)))[0]!;
    expect(status.state).toBe('failed');
    expect(status.error).toMatch(/checksum/);
    expect(store.has('f'.repeat(64))).toBe(false);
    expect(repo.getModel('tiny:1b')).toBeUndefined();
    expect(readdirSync(`${dir}/partial/${id}`)).toEqual([]);
  });

  it('checks for disk space before downloading', async () => {
    const { pulls, server } = await setup({ freeBytes: 1000 });
    const { id } = pulls.pull('tiny:1b');
    const status = (await until(pulls, settled(id)))[0]!;
    expect(status.error).toMatch(/Not enough disk space/);
    expect(server.requests.filter((r) => r.path.startsWith('/cdn/'))).toEqual([]);
  });

  it('shares a file two models have in common', async () => {
    const { pulls, repo, server } = await setup({ catalog: [entry(), entry({ tag: 'again' })] });
    await until(pulls, settled(pulls.pull('tiny:1b').id));
    server.requests.length = 0;
    await until(pulls, settled(pulls.pull('tiny:again').id));
    expect(repo.getModel('tiny:again')).toBeDefined();
    expect(server.requests.filter((r) => r.path.startsWith('/cdn/'))).toEqual([]);
  });

  it('fails with a reason when the ref resolves to nothing', async () => {
    const { pulls } = await setup();
    const { id } = pulls.pull('hf.co/test/Missing-GGUF');
    const status = (await until(pulls, settled(id)))[0]!;
    expect(status.state).toBe('failed');
    expect(status.error).toMatch(/test\/Missing-GGUF/);
  });
});
