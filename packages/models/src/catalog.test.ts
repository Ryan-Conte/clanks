import { type HardwareInfo, modelIdSchema, modelTagSchema } from '@clanks/core';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundledCatalog, catalogModelId, findCatalogEntry, recommendModel } from './catalog';
import { GIB } from './fit';

const crewDir = fileURLToPath(new URL('../../../crew', import.meta.url));

type Machine = Pick<HardwareInfo, 'budget' | 'gpus' | 'memory'>;

function machine(gpuGiB: number, systemGiB: number, unified = false): Machine {
  return {
    budget: { gpuBytes: gpuGiB * GIB, systemBytes: unified ? 0 : systemGiB * 0.75 * GIB },
    gpus:
      gpuGiB > 0
        ? [
            {
              id: 'GPU0',
              name: 'GPU',
              backend: 'cuda',
              totalBytes: gpuGiB * GIB,
              freeBytes: gpuGiB * GIB,
            },
          ]
        : [],
    memory: { totalBytes: systemGiB * GIB, freeBytes: systemGiB * GIB, unified },
  };
}

const crewShape = { contextPerSlot: 32768, slots: 1 };

describe('the bundled catalog', () => {
  it('has unique, valid ids', () => {
    const ids = bundledCatalog.models.map(catalogModelId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(modelIdSchema.safeParse(id).success).toBe(true);
  });

  it('only lists models every clank can use: with tools, and weights first', () => {
    for (const entry of bundledCatalog.models) {
      expect(entry.capabilities.tools, entry.name).toBe(true);
      expect(entry.files[0]!.role).toBe('model');
      expect(entry.capabilities.vision).toBe(entry.files.some((f) => f.role === 'projector'));
    }
  });

  it('has a model for every tag a crew doc asks for', () => {
    const offered = new Set(bundledCatalog.models.flatMap((m) => m.tags));
    const docs = [
      ...readdirSync(crewDir).map((f) => join(crewDir, f)),
      ...readdirSync(join(crewDir, 'examples')).map((f) => join(crewDir, 'examples', f)),
    ].filter((f) => f.endsWith('.md'));
    for (const doc of docs) {
      const tags = /^model:\n {2}tags: \[([^\]]*)\]/m.exec(readFileSync(doc, 'utf8'))?.[1];
      if (!tags) continue;
      for (const tag of tags.split(',').map((t) => t.trim())) {
        expect(modelTagSchema.safeParse(tag).success, `${doc}: ${tag}`).toBe(true);
        expect(offered.has(modelTagSchema.parse(tag)), `${doc}: ${tag}`).toBe(true);
      }
    }
  });
});

describe('recommendModel', () => {
  const pick = (m: Machine) => {
    const entry = recommendModel(bundledCatalog, m, crewShape);
    return entry && catalogModelId(entry);
  };

  it('picks a 30B-class model for a 24 GB GPU', () => {
    expect(pick(machine(22, 32))).toBe('qwen3.6:35b');
  });

  it('picks the largest model that fits a mid-range GPU', () => {
    expect(pick(machine(11, 32))).toBe('gemma4:12b');
    expect(pick(machine(8, 16))).toBe('qwen3.5:9b');
    expect(pick(machine(7, 16))).toBe('gemma4:e4b');
  });

  it('keeps CPU-only machines on a small model, even with memory to spare', () => {
    expect(pick(machine(0, 64))).toBe('gemma4:e4b');
    expect(pick(machine(0, 8))).toBe('qwen3.5:4b');
  });

  it('fits a Mac in its unified memory', () => {
    expect(pick(machine(96, 128, true))).toBe('gpt-oss:120b');
    expect(pick(machine(20, 32, true))).toBe('gemma4:26b');
  });

  it('still suggests something on a tiny machine', () => {
    expect(pick(machine(0, 2))).toBe('qwen3.5:0.8b');
  });
});

describe('findCatalogEntry', () => {
  it('finds a tag, or the size of a model that suits the machine', () => {
    expect(findCatalogEntry(bundledCatalog, 'qwen3.5', '4b')?.tag).toBe('4b');
    expect(findCatalogEntry(bundledCatalog, 'qwen3.5', 'nope')).toBeUndefined();
    const machineInput = { hardware: machine(11, 32), shape: crewShape };
    expect(findCatalogEntry(bundledCatalog, 'qwen3.5', null, machineInput)?.tag).toBe('9b');
  });
});
