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

/** First run's download as it goes: the model being fetched for the crew, and how far along. */
export interface SetupProgress {
  modelId: string;
  title: string;
  /** From 0 to 1. */
  progress: number;
  /** The download itself, to pause, carry on or stop. Null once it's done, or if it was stopped. */
  pull: PullItem | null;
  /** `stopped` when the download was cancelled, so there's nothing going to wait for. */
  state: 'downloading' | 'paused' | 'failed' | 'stopped';
}

/** What first run is setting up, or null when it isn't setting anything up. */
export function useSetup(): SetupProgress | null {
  const snapshot = useModels();
  const modelId = snapshot?.setupModel;
  if (!snapshot || !modelId) return null;
  const pull = snapshot.pulls.find((p) => p.modelId === modelId && p.state !== 'done') ?? null;
  const title = snapshot.catalog.find((m) => m.id === modelId)?.title ?? pull?.title ?? modelId;
  return {
    modelId,
    title,
    progress: pull && pull.totalBytes > 0 ? pull.doneBytes / pull.totalBytes : 0,
    pull,
    state: !pull
      ? 'stopped'
      : pull.state === 'paused'
        ? 'paused'
        : pull.state === 'failed'
          ? 'failed'
          : 'downloading',
  };
}

export const BACKEND_NAMES = {
  cuda: 'CUDA',
  vulkan: 'Vulkan',
  metal: 'Metal',
  cpu: 'CPU',
} as const;
