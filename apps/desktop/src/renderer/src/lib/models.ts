import type { ModelsSnapshot } from '@clanks/orchestrator';
import { createContext, useContext } from 'react';

export type { ModelsSnapshot };
export type LibraryItem = ModelsSnapshot['library'][number];
export type CatalogItem = ModelsSnapshot['catalog'][number];
export type PullItem = ModelsSnapshot['pulls'][number];
export type LoadedItem = ModelsSnapshot['runtime']['loaded'][number];

/** The live state of the model manager. Null until the first snapshot arrives. */
export const ModelsContext = createContext<ModelsSnapshot | null>(null);

export function useModels(): ModelsSnapshot | null {
  return useContext(ModelsContext);
}

export const BACKEND_NAMES = {
  cuda: 'CUDA',
  vulkan: 'Vulkan',
  metal: 'Metal',
  cpu: 'CPU',
} as const;
