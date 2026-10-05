import {
  type Catalog,
  type CatalogEntry,
  type HardwareInfo,
  type ModelId,
  catalogSchema,
} from '@clanks/core';
import catalogJson from './catalog.json';
import { GIB, estimateFit } from './fit';

/** The catalog that ships with the app. Checked against its schema when the app loads. */
export const bundledCatalog: Catalog = catalogSchema.parse(catalogJson);

export function catalogModelId(entry: Pick<CatalogEntry, 'name' | 'tag'>): ModelId {
  return `${entry.name}:${entry.tag}`;
}

/**
 * A name without a tag means the size of that model that suits this machine, the way
 * `recommendModel` picks one for the crew.
 */
export function findCatalogEntry(
  catalog: Catalog,
  name: string,
  tag: string | null,
  machine?: RecommendInput,
): CatalogEntry | undefined {
  if (tag !== null) return catalog.models.find((m) => m.name === name && m.tag === tag);
  const named = { ...catalog, models: catalog.models.filter((m) => m.name === name) };
  return machine ? recommendModel(named, machine.hardware, machine.shape) : named.models[0];
}

export interface RecommendInput {
  hardware: Pick<HardwareInfo, 'budget' | 'gpus' | 'memory'>;
  shape: { contextPerSlot: number; slots: number };
}

export function catalogWeightsBytes(entry: CatalogEntry): number {
  return entry.files.reduce((sum, f) => sum + f.size, 0);
}

/** On a machine without a usable GPU, bigger models fit in memory but answer too slowly. */
const CPU_WEIGHTS_LIMIT = 6 * GIB;

/**
 * The model to suggest for the whole crew on this machine: the largest general-purpose one that
 * runs fully on the GPU, or failing that the largest small one that fits in memory. Every
 * candidate must support tools, which every clank needs.
 */
export function recommendModel(
  catalog: Catalog,
  hardware: Pick<HardwareInfo, 'budget' | 'gpus' | 'memory'>,
  shape: { contextPerSlot: number; slots: number },
): CatalogEntry | undefined {
  const candidates = catalog.models
    .filter((entry) => entry.capabilities.tools && entry.tags.includes('general'))
    .map((entry) => ({
      entry,
      weights: catalogWeightsBytes(entry),
      fit: estimateFit(
        { weightsBytes: catalogWeightsBytes(entry), facts: entry.facts, ...shape },
        hardware,
      ),
    }))
    .sort((a, b) => b.weights - a.weights);

  const pick =
    candidates.find((c) => c.fit.verdict === 'gpu') ??
    candidates.find(
      (c) =>
        (c.fit.verdict === 'cpu' || c.fit.verdict === 'partial') && c.weights <= CPU_WEIGHTS_LIMIT,
    );
  return (pick ?? candidates.at(-1))?.entry;
}
