import type { FitEstimate, GgufFacts, HardwareInfo } from '@clanks/core';

export const MIB = 1024 ** 2;
export const GIB = 1024 ** 3;

/** Compute buffers, the runtime itself and any recurrent state: a fixed allowance. */
export const OVERHEAD_BYTES = 768 * MIB;
/** The KV cache is kept in f16. */
const KV_BYTES_PER_ELEMENT = 2;
/** llama.cpp keeps a physical batch beyond the window in each sliding-window cache. */
const UBATCH = 512;

export interface MemoryShape {
  /** Bytes of the GGUF files: the weights, plus the projector if there is one. */
  weightsBytes: number;
  facts: GgufFacts;
  contextPerSlot: number;
  slots: number;
}

/** The context each slot gets: what was asked for, but no more than the model was trained on. */
export function slotContext(facts: GgufFacts, contextPerSlot: number): number {
  return Math.max(256, Math.min(contextPerSlot, facts.contextLength));
}

export function kvCacheBytes(facts: GgufFacts, contextPerSlot: number, slots: number): number {
  const context = slotContext(facts, contextPerSlot);
  const swaTokens = facts.slidingWindow > 0 ? Math.min(context, facts.slidingWindow + UBATCH) : 0;
  const elements = (facts.kvPerToken * context + facts.swaKvPerToken * swaTokens) * slots;
  return elements * KV_BYTES_PER_ELEMENT;
}

/** Memory a model needs loaded: weights, KV cache for every slot, and overhead. */
export function memoryNeed(shape: MemoryShape): { needBytes: number; kvBytes: number } {
  const kvBytes = kvCacheBytes(shape.facts, shape.contextPerSlot, shape.slots);
  return { needBytes: shape.weightsBytes + kvBytes + OVERHEAD_BYTES, kvBytes };
}

/**
 * Estimates where a model would run before it's downloaded. The estimate is deliberately simple:
 * llama.cpp fits the real layers to free memory when it loads, so this only has to be close.
 */
export function estimateFit(
  shape: MemoryShape,
  hardware: Pick<HardwareInfo, 'budget' | 'gpus' | 'memory'>,
): FitEstimate {
  const { needBytes, kvBytes } = memoryNeed(shape);
  const { gpuBytes, systemBytes } = hardware.budget;
  let verdict: FitEstimate['verdict'];
  if (hardware.gpus.length > 0 && gpuBytes > 0) {
    if (needBytes <= gpuBytes) verdict = 'gpu';
    // Unified memory has no second pool to spill into.
    else if (!hardware.memory.unified && needBytes <= gpuBytes + systemBytes) verdict = 'partial';
    else verdict = 'too_large';
  } else {
    verdict = needBytes <= systemBytes ? 'cpu' : 'too_large';
  }
  return {
    verdict,
    needBytes,
    weightsBytes: shape.weightsBytes,
    kvBytes,
    context: slotContext(shape.facts, shape.contextPerSlot) * shape.slots,
    slots: shape.slots,
    gpuBudgetBytes: gpuBytes,
    systemBudgetBytes: systemBytes,
  };
}

/** How many parallel slots to give a model when the settings leave it to the hardware. */
export function autoSlots(hardware: Pick<HardwareInfo, 'budget' | 'gpus'>): number {
  const gpu = hardware.gpus.length > 0 ? hardware.budget.gpuBytes : 0;
  if (gpu >= 40 * GIB) return 4;
  if (gpu >= 8 * GIB) return 2;
  return 1;
}
