import type { GgufFacts, HardwareInfo } from '@clanks/core';
import { describe, expect, it } from 'vitest';
import { GIB, MIB, OVERHEAD_BYTES, autoSlots, estimateFit, kvCacheBytes, slotContext } from './fit';

const qwen08: GgufFacts = {
  architecture: 'qwen35',
  blockCount: 25,
  contextLength: 262144,
  kvPerToken: 6144,
  swaKvPerToken: 0,
  slidingWindow: 0,
  parameterCount: null,
};

type Machine = Pick<HardwareInfo, 'budget' | 'gpus' | 'memory'>;

function machine(gpuGiB: number, systemGiB: number, unified = false): Machine {
  return {
    budget: { gpuBytes: gpuGiB * GIB, systemBytes: systemGiB * GIB },
    gpus:
      gpuGiB > 0
        ? [
            {
              id: 'CUDA0',
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

describe('kvCacheBytes', () => {
  it('matches what llama.cpp allocated for Qwen3.5 0.8B at 4096 × 2', () => {
    // llama_kv_cache: size = 96.00 MiB (4096 cells, 6 layers, 2/2 seqs)
    expect(kvCacheBytes(qwen08, 4096, 2)).toBe(96 * MIB);
  });

  it('caps sliding-window layers at the window', () => {
    const swa: GgufFacts = { ...qwen08, kvPerToken: 0, swaKvPerToken: 1000, slidingWindow: 1024 };
    expect(kvCacheBytes(swa, 32768, 1)).toBe(1000 * (1024 + 512) * 2);
    expect(kvCacheBytes(swa, 1000, 1)).toBe(1000 * 1000 * 2);
  });

  it('never gives a slot more context than the model was trained on', () => {
    const short = { ...qwen08, contextLength: 2048 };
    expect(slotContext(short, 32768)).toBe(2048);
    expect(kvCacheBytes(short, 32768, 1)).toBe(kvCacheBytes(short, 2048, 1));
  });
});

describe('estimateFit', () => {
  const shape = { weightsBytes: 10 * GIB, facts: qwen08, contextPerSlot: 32768, slots: 1 };

  it('fits on the GPU when weights, cache and overhead fit its budget', () => {
    const fit = estimateFit(shape, machine(22, 24));
    expect(fit.verdict).toBe('gpu');
    expect(fit.needBytes).toBe(10 * GIB + kvCacheBytes(qwen08, 32768, 1) + OVERHEAD_BYTES);
    expect(fit.context).toBe(32768);
  });

  it('spills into system memory when the GPU is too small', () => {
    expect(estimateFit(shape, machine(6, 24)).verdict).toBe('partial');
  });

  it('runs on the CPU without a GPU', () => {
    expect(estimateFit(shape, machine(0, 24)).verdict).toBe('cpu');
  });

  it('is too large when it fits nowhere', () => {
    expect(estimateFit(shape, machine(4, 4)).verdict).toBe('too_large');
    expect(estimateFit(shape, machine(0, 8)).verdict).toBe('too_large');
  });

  it("can't spill on unified memory", () => {
    expect(estimateFit(shape, machine(8, 0, true)).verdict).toBe('too_large');
    expect(estimateFit(shape, machine(20, 0, true)).verdict).toBe('gpu');
  });
});

describe('autoSlots', () => {
  it('gives bigger machines more slots', () => {
    expect(autoSlots(machine(0, 16))).toBe(1);
    expect(autoSlots(machine(6, 16))).toBe(1);
    expect(autoSlots(machine(11, 32))).toBe(2);
    expect(autoSlots(machine(80, 128))).toBe(4);
  });
});
