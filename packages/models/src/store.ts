import type { ModelId, ModelRecord, PullState } from '@clanks/core';
import { existsSync } from 'node:fs';
import { link, mkdir, readdir, rm, stat, statfs, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ChunkProgress } from './download';
import type { ModelPlan } from './resolve';

/** A pull as it's persisted, so it can resume after a restart. */
export interface PullRecord {
  id: string;
  ref: string;
  /** Persisted states only: `done` pulls are deleted. */
  state: Exclude<PullState, 'done'>;
  /** What the ref resolved to. Null until resolved. */
  plan: ModelPlan | null;
  /** Download progress per file, by sha256. */
  chunks: Record<string, ChunkProgress[]>;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Where models and pulls are recorded. The orchestrator keeps them in SQLite. */
export interface ModelRepository {
  listModels(): ModelRecord[];
  getModel(id: ModelId): ModelRecord | undefined;
  putModel(model: ModelRecord): void;
  deleteModel(id: ModelId): void;
  listPulls(): PullRecord[];
  putPull(pull: PullRecord): void;
  deletePull(id: string): void;
}

export function memoryRepository(): ModelRepository {
  const models = new Map<string, ModelRecord>();
  const pulls = new Map<string, PullRecord>();
  const copy = <T>(value: T): T => structuredClone(value);
  return {
    listModels: () => [...models.values()].map(copy),
    getModel: (id) => (models.has(id) ? copy(models.get(id)) : undefined),
    putModel: (model) => void models.set(model.id, copy(model)),
    deleteModel: (id) => void models.delete(id),
    listPulls: () => [...pulls.values()].map(copy),
    putPull: (pull) => void pulls.set(pull.id, copy(pull)),
    deletePull: (id) => void pulls.delete(id),
  };
}

/**
 * The models folder. Files are stored once each, named by their sha256, so two tags of the same
 * file share it:
 *
 *   blobs/sha256-<hex>         verified GGUF files
 *   partial/<pull id>/<hex>    downloads in progress
 *   links/<model>/             split models, linked under their original names for llama.cpp
 */
export class BlobStore {
  constructor(readonly dir: string) {}

  get blobsDir(): string {
    return join(this.dir, 'blobs');
  }

  get partialRoot(): string {
    return join(this.dir, 'partial');
  }

  get linksRoot(): string {
    return join(this.dir, 'links');
  }

  async init(): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true });
    await mkdir(this.partialRoot, { recursive: true });
  }

  blobPath(sha256: string): string {
    return join(this.blobsDir, `sha256-${sha256}`);
  }

  has(sha256: string): boolean {
    return existsSync(this.blobPath(sha256));
  }

  partialDir(pullId: string): string {
    return join(this.partialRoot, pullId);
  }

  partialPath(pullId: string, sha256: string): string {
    return join(this.partialDir(pullId), sha256);
  }

  async removePartial(pullId: string): Promise<void> {
    await rm(this.partialDir(pullId), { recursive: true, force: true, maxRetries: 3 });
  }

  /** Removes partial downloads that no pull owns any more. */
  async removeOrphanPartials(pullIds: Set<string>): Promise<void> {
    for (const entry of await readdirSafe(this.partialRoot)) {
      if (!pullIds.has(entry)) await this.removePartial(entry);
    }
  }

  async removeBlob(sha256: string): Promise<void> {
    await rm(this.blobPath(sha256), { force: true, maxRetries: 3 });
  }

  /**
   * The paths to hand llama-server. A single file loads straight from its blob. llama.cpp finds
   * the other shards of a split model by name, so those get a folder of links named as in the repo.
   */
  async modelPaths(model: ModelRecord): Promise<{ model: string; projector: string | null }> {
    const weights = model.files.filter((f) => f.role === 'model');
    const projector = model.files.find((f) => f.role === 'projector');
    const projectorPath = projector ? this.blobPath(projector.sha256) : null;
    if (weights.length === 1)
      return { model: this.blobPath(weights[0]!.sha256), projector: projectorPath };

    const dir = join(this.linksRoot, safeName(model.id));
    await mkdir(dir, { recursive: true });
    for (const file of weights) {
      const target = join(dir, basename(file.path));
      if (existsSync(target)) continue;
      try {
        await link(this.blobPath(file.sha256), target);
      } catch {
        // Some drives (exFAT, FAT32) have no hard links.
        await symlink(this.blobPath(file.sha256), target);
      }
    }
    return { model: join(dir, basename(weights[0]!.path)), projector: projectorPath };
  }

  async removeLinks(id: ModelId): Promise<void> {
    await rm(join(this.linksRoot, safeName(id)), { recursive: true, force: true, maxRetries: 3 });
  }

  /** Bytes used by blobs and partial downloads. */
  async usedBytes(): Promise<number> {
    let total = 0;
    for (const name of await readdirSafe(this.blobsDir)) {
      total += await sizeOf(join(this.blobsDir, name));
    }
    for (const pull of await readdirSafe(this.partialRoot)) {
      for (const name of await readdirSafe(join(this.partialRoot, pull))) {
        total += await sizeOf(join(this.partialRoot, pull, name));
      }
    }
    return total;
  }

  async freeBytes(): Promise<number> {
    return freeBytes(this.dir);
  }
}

/** Free space on the drive that holds `dir`, or its nearest existing parent. */
export async function freeBytes(dir: string): Promise<number> {
  let current = dir;
  for (;;) {
    try {
      const stats = await statfs(current);
      return stats.bavail * stats.bsize;
    } catch (error) {
      const parent = join(current, '..');
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '_');
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    const stats = await stat(path);
    // Partial downloads are written sparse; count what's actually there, where the OS says.
    return stats.isFile()
      ? Math.min(stats.size, stats.blocks > 0 ? stats.blocks * 512 : stats.size)
      : 0;
  } catch {
    return 0;
  }
}
