import type { ModelRecord } from '@clanks/core';
import type { PullRecord } from '@clanks/models';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationsFolder, tempDir } from '../test-helpers';
import { sqliteModelRepository } from './models';
import { openStore } from './store';

const record: ModelRecord = {
  id: 'hf.co/test/Tiny-GGUF:Q4_0',
  source: 'huggingface',
  title: 'Tiny',
  repo: 'test/Tiny-GGUF',
  revision: 'a'.repeat(40),
  quant: 'Q4_0',
  params: null,
  license: null,
  tags: ['general'],
  capabilities: { tools: true, vision: true, reasoning: false },
  files: [
    { role: 'model', path: 'Tiny-Q4_0.gguf', sha256: 'b'.repeat(64), size: 100 },
    { role: 'projector', path: 'mmproj.gguf', sha256: 'c'.repeat(64), size: 10 },
  ],
  facts: {
    architecture: 'llama',
    blockCount: 6,
    contextLength: 4096,
    kvPerToken: 576,
    swaKvPerToken: 0,
    slidingWindow: 0,
    parameterCount: 1000,
  },
  size: 110,
  keepLoaded: false,
  pulledAt: new Date(1_790_000_000_000),
};

const pull: PullRecord = {
  id: '5b0c7d4e-2f0a-4c55-9c39-7d1b0b3c9a10',
  ref: 'hf.co/test/Tiny-GGUF',
  state: 'downloading',
  plan: null,
  chunks: { ['b'.repeat(64)]: [{ start: 0, end: 100, done: 40 }] },
  error: null,
  createdAt: new Date(1_790_000_000_000),
  updatedAt: new Date(1_790_000_001_000),
};

describe('sqliteModelRepository', () => {
  it('keeps models across restarts and updates them in place', () => {
    const file = join(tempDir(), 'clanks.db');
    const first = openStore({ file, migrationsFolder });
    const repo = sqliteModelRepository(first.db);
    repo.putModel(record);
    repo.putModel({ ...record, keepLoaded: true });
    first.close();

    const second = openStore({ file, migrationsFolder });
    const reopened = sqliteModelRepository(second.db);
    expect(reopened.listModels()).toEqual([{ ...record, keepLoaded: true }]);
    expect(reopened.getModel(record.id)).toEqual({ ...record, keepLoaded: true });
    reopened.deleteModel(record.id);
    expect(reopened.getModel(record.id)).toBeUndefined();
    second.close();
  });

  it('keeps pulls and their progress', () => {
    const store = openStore({ file: ':memory:', migrationsFolder });
    const repo = sqliteModelRepository(store.db);
    repo.putPull(pull);
    repo.putPull({ ...pull, state: 'paused' });
    expect(repo.listPulls()).toEqual([{ ...pull, state: 'paused' }]);
    repo.deletePull(pull.id);
    expect(repo.listPulls()).toEqual([]);
    store.close();
  });
});
