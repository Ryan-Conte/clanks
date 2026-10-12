import type { HardwareInfo, LoadedModelStatus, ModelRecord } from '@clanks/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { GIB } from '../fit';
import { type FakeServerConfig, fakeBuild, tempDir } from '../test/fixtures';
import { type Lease, ModelLoadError, Supervisor } from './supervisor';

function model(id: string, sizeGiB: number, keepLoaded = false): ModelRecord {
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
    files: [{ role: 'model', path: `${id}.gguf`, sha256: 'a'.repeat(64), size: sizeGiB * GIB }],
    facts: {
      architecture: 'llama',
      blockCount: 6,
      contextLength: 4096,
      kvPerToken: 100,
      swaKvPerToken: 0,
      slidingWindow: 0,
      parameterCount: null,
    },
    size: sizeGiB * GIB,
    keepLoaded,
    pulledAt: new Date(),
  };
}

function hardware(gpuGiB: number): HardwareInfo {
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: { model: 'Test CPU', threads: 8 },
    memory: { totalBytes: 32 * GIB, freeBytes: 16 * GIB, unified: false },
    gpus: [
      {
        id: 'CUDA0',
        name: 'Test GPU',
        backend: 'cuda',
        totalBytes: gpuGiB * GIB,
        freeBytes: gpuGiB * GIB,
      },
    ],
    nvidia: true,
    backend: 'cuda',
    budget: { gpuBytes: gpuGiB * GIB, systemBytes: 0 },
    problems: [],
    probedAt: new Date(),
  };
}

interface SetupOptions {
  models: ModelRecord[];
  budgetGiB?: number;
  idleMs?: number;
  server?: FakeServerConfig;
}

function setup(options: SetupOptions) {
  const dir = tempDir();
  const argsFile = join(dir, 'args.jsonl');
  const fake = fakeBuild(dir, { argsFile, ...options.server });
  const models = new Map(options.models.map((m) => [m.id, m]));
  const supervisor = new Supervisor({
    build: () => fake.build,
    hardware: () => hardware(options.budgetGiB ?? 24),
    config: () => ({ idleMs: options.idleMs ?? 60_000, contextPerSlot: 2048, slots: 1 }),
    model: (id) => models.get(id),
    paths: (m) => Promise.resolve({ model: join(dir, `${m.id}.gguf`), projector: null }),
    logsDir: join(dir, 'logs'),
    pidFile: join(dir, 'servers.json'),
    restartDelayMs: () => 10,
  });
  onTestFinished(() => supervisor.close());
  const launches = () =>
    readFileSync(argsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
  return { supervisor, dir, fake, models, launches, argsFile };
}

function until(
  supervisor: Supervisor,
  check: (status: LoadedModelStatus[]) => boolean,
  timeoutMs = 10_000,
): Promise<LoadedModelStatus[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      supervisor.off('change', onChange);
      reject(new Error(`Timed out: ${JSON.stringify(supervisor.status())}`));
    }, timeoutMs);
    const onChange = () => {
      const status = supervisor.status();
      if (!check(status)) return;
      clearTimeout(timer);
      supervisor.off('change', onChange);
      resolve(status);
    };
    supervisor.on('change', onChange);
    onChange();
  });
}

async function ask(lease: Lease, content: string): Promise<string> {
  const response = await fetch(`${lease.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${lease.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: lease.model, messages: [{ role: 'user', content }] }),
  });
  const body = (await response.json()) as { choices: { message: { content: string } }[] };
  return body.choices[0]!.message.content;
}

describe('Supervisor', () => {
  it('loads a model on first use and shares it after', async () => {
    const { supervisor, launches } = setup({ models: [model('tiny:1b', 1)] });
    const first = await supervisor.acquire('tiny:1b');
    expect(await ask(first, 'hello')).toBe('echo: hello');
    const second = await supervisor.acquire('tiny:1b');
    expect(second.baseUrl).toBe(first.baseUrl);
    expect(launches()).toHaveLength(1);

    const [status] = supervisor.status();
    expect(status).toMatchObject({
      modelId: 'tiny:1b',
      state: 'ready',
      backend: 'cuda',
      inUse: 2,
      placement: 'gpu',
      layers: { gpu: 7, total: 7 },
      devices: ['CUDA0'],
      context: 2048,
      slots: 1,
      idleUnloadAt: null,
    });
    expect(status!.memory!.gpuBytes).toBeGreaterThan(0);

    const args = launches()[0]!;
    const value = (name: string) => args[args.indexOf(name) + 1];
    expect(value('--host')).toBe('127.0.0.1');
    expect(value('--alias')).toBe('tiny:1b');
    expect(value('--ctx-size')).toBe('2048');
    expect(value('--parallel')).toBe('1');
    expect(value('--api-key')).toMatch(/^[a-f0-9]{48}$/);
    expect(args).toEqual(expect.arrayContaining(['--offline', '--jinja', '--no-webui']));
    first.release();
    second.release();
  });

  it('turns away requests without the per-launch key', async () => {
    const { supervisor } = setup({ models: [model('tiny:1b', 1)] });
    const lease = await supervisor.acquire('tiny:1b');
    const response = await fetch(`${lease.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(401);
    lease.release();
  });

  it('unloads a model once it has been idle', async () => {
    const { supervisor } = setup({ models: [model('tiny:1b', 1)], idleMs: 150 });
    const lease = await supervisor.acquire('tiny:1b');
    lease.release();
    expect(supervisor.status()[0]!.idleUnloadAt).toBeInstanceOf(Date);
    await until(supervisor, (s) => s.length === 0);
  });

  it('keeps a model loaded when asked to', async () => {
    const { supervisor } = setup({ models: [model('tiny:1b', 1, true)], idleMs: 50 });
    await supervisor.load('tiny:1b');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(supervisor.status()[0]).toMatchObject({
      state: 'ready',
      keepLoaded: true,
      idleUnloadAt: null,
    });
  });

  it('evicts the least recently used idle model to make room', async () => {
    const { supervisor } = setup({
      models: [model('a:1', 5), model('b:1', 5), model('c:1', 5)],
      budgetGiB: 12,
    });
    for (const id of ['a:1', 'b:1']) (await supervisor.acquire(id)).release();
    expect(supervisor.status().map((s) => s.modelId)).toEqual(['a:1', 'b:1']);
    (await supervisor.acquire('c:1')).release();
    expect(supervisor.status().map((s) => s.modelId)).toEqual(['b:1', 'c:1']);
  });

  it('waits for a busy model to finish before evicting it', async () => {
    const { supervisor } = setup({ models: [model('a:1', 8), model('b:1', 8)], budgetGiB: 10 });
    const busy = await supervisor.acquire('a:1');
    let loaded = false;
    const waiting = supervisor.acquire('b:1').then((lease) => {
      loaded = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(loaded).toBe(false);
    busy.release();
    (await waiting).release();
    expect(supervisor.status().map((s) => s.modelId)).toEqual(['b:1']);
  });

  it('restarts a server that crashes', async () => {
    const { supervisor, launches } = setup({ models: [model('tiny:1b', 1)] });
    const lease = await supervisor.acquire('tiny:1b');
    await ask(lease, 'crash').catch(() => {});
    lease.release();
    await until(supervisor, (s) => s[0]?.restarts === 1 && s[0].state === 'ready');
    const again = await supervisor.acquire('tiny:1b');
    expect(await ask(again, 'still there?')).toBe('echo: still there?');
    expect(launches()).toHaveLength(2);
    again.release();
  });

  it("explains a model that won't load, and tries again next time", async () => {
    const { supervisor, fake, argsFile } = setup({
      models: [model('tiny:1b', 1)],
      server: { failLoad: true },
    });
    await expect(supervisor.acquire('tiny:1b')).rejects.toThrow(ModelLoadError);
    expect(supervisor.status()[0]).toMatchObject({ state: 'failed', inUse: 0 });
    expect(supervisor.status()[0]!.error).toMatch(/out of memory/);

    fake.configure({ argsFile });
    const lease = await supervisor.acquire('tiny:1b');
    expect(supervisor.status()[0]!.state).toBe('ready');
    lease.release();
  });

  it('gives up waiting when the caller does', async () => {
    const { supervisor } = setup({ models: [model('tiny:1b', 1)], server: { loadMs: 2000 } });
    const controller = new AbortController();
    const acquiring = supervisor.acquire('tiny:1b', controller.signal);
    setTimeout(() => controller.abort(new Error('stop')), 50);
    await expect(acquiring).rejects.toThrow('stop');
    expect(supervisor.status()[0]!.inUse).toBe(0);
  });

  it('unloads on request and refuses models that are not pulled', async () => {
    const { supervisor } = setup({ models: [model('tiny:1b', 1)] });
    await supervisor.load('tiny:1b');
    await supervisor.unload('tiny:1b');
    expect(supervisor.status()).toEqual([]);
    await expect(supervisor.acquire('missing:1')).rejects.toThrow("isn't pulled");
  });

  it('records its servers so a crashed app can clean up after itself', async () => {
    const { supervisor, dir } = setup({ models: [model('tiny:1b', 1)] });
    await supervisor.load('tiny:1b');
    const pids = JSON.parse(readFileSync(join(dir, 'servers.json'), 'utf8')) as number[];
    expect(pids).toHaveLength(1);
    supervisor.close();
    expect(JSON.parse(readFileSync(join(dir, 'servers.json'), 'utf8'))).toEqual([]);
  });
});
