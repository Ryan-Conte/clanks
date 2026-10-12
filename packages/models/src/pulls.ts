import type { ModelRecord, PullStatus } from '@clanks/core';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, rename, rm } from 'node:fs/promises';
import {
  type ChunkProgress,
  DownloadError,
  chunksDone,
  describe,
  downloadFile,
  planChunks,
} from './download';
import { GIB, MIB } from './fit';
import { sha256File } from './hash';
import type { ModelPlan } from './resolve';
import type { BlobStore, ModelRepository, PullRecord } from './store';

export interface PullManagerOptions {
  repo: ModelRepository;
  store: () => BlobStore;
  resolve: (ref: string, signal: AbortSignal) => Promise<ModelPlan>;
  /** Headers for a source URL, such as a Hugging Face token. */
  headers?: (url: string) => Record<string, string>;
  fetch?: typeof fetch;
  connections?: number;
  /** Pulls downloading at once; the rest wait their turn. */
  concurrency?: number;
  retryDelayMs?: (attempt: number) => number;
}

/** Room to leave on the drive beyond the download itself. */
const DISK_MARGIN = 512 * MIB;
const SPEED_WINDOW_MS = 5000;
const DONE_LINGER_MS = 10_000;

class Stopped extends Error {
  /** `shutdown` stops a pull for now but leaves it to carry on when the app next starts. */
  constructor(readonly action: 'pause' | 'cancel' | 'shutdown') {
    super(action === 'pause' ? 'Paused' : action === 'cancel' ? 'Cancelled' : 'Shutting down');
  }
}

interface ActivePull {
  record: PullRecord;
  done: boolean;
  controller: AbortController | null;
  samples: { at: number; bytes: number }[];
  doneBytes: number;
}

/**
 * Downloads models into the blob store: queued, resumable across restarts, verified by sha256,
 * with pause and cancel. Emits `change` whenever a pull's status changes or progresses, and
 * `pulled` with the model once one lands in the store.
 */
export class PullManager extends EventEmitter<{ change: []; pulled: [ModelRecord] }> {
  private readonly pulls = new Map<string, ActivePull>();
  private started = false;
  private stopped = false;

  constructor(private readonly options: PullManagerOptions) {
    super();
  }

  /** Picks up pulls from before a restart. Ones that were running carry on; paused ones wait. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const store = this.options.store();
    await store.init();
    if (this.stopped) return;
    const records = this.options.repo.listPulls().sort((a, b) => +a.createdAt - +b.createdAt);
    for (const record of records) {
      if (record.state !== 'paused' && record.state !== 'failed') record.state = 'queued';
      this.pulls.set(record.id, this.track(record));
    }
    await store.removeOrphanPartials(new Set(this.pulls.keys()));
    this.pump();
  }

  list(): PullStatus[] {
    return [...this.pulls.values()].map((pull) => this.status(pull));
  }

  get(id: string): PullStatus | undefined {
    const pull = this.pulls.get(id);
    return pull && this.status(pull);
  }

  /** Starts pulling a ref, or returns the pull already under way for it. */
  pull(ref: string): PullStatus {
    const existing = [...this.pulls.values()].find(
      (p) => !p.done && (p.record.ref === ref || p.record.plan?.model.id === ref),
    );
    if (existing) {
      if (existing.record.state === 'failed' || existing.record.state === 'paused') {
        this.resume(existing.record.id);
      }
      return this.status(existing);
    }
    const now = new Date();
    const record: PullRecord = {
      id: randomUUID(),
      ref,
      state: 'queued',
      plan: null,
      chunks: {},
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const pull = this.track(record);
    this.pulls.set(record.id, pull);
    this.persist(pull);
    this.pump();
    return this.status(pull);
  }

  pause(id: string): void {
    const pull = this.require(id);
    if (pull.done || pull.record.state === 'paused' || pull.record.state === 'failed') return;
    if (pull.controller) {
      pull.controller.abort(new Stopped('pause'));
    } else {
      this.setState(pull, 'paused');
    }
  }

  resume(id: string): void {
    const pull = this.require(id);
    if (pull.record.state !== 'paused' && pull.record.state !== 'failed') return;
    pull.record.error = null;
    this.setState(pull, 'queued');
    this.pump();
  }

  /** Stops a pull and deletes what it downloaded. */
  async cancel(id: string): Promise<void> {
    const pull = this.require(id);
    if (pull.controller) {
      pull.controller.abort(new Stopped('cancel'));
      return;
    }
    await this.discard(pull);
  }

  /** Forgets a finished pull. */
  dismiss(id: string): void {
    const pull = this.pulls.get(id);
    if (pull?.done) {
      this.pulls.delete(id);
      this.emit('change');
    }
  }

  /** Pauses everything that's running, for moving the store or quitting. */
  async pauseAll(): Promise<void> {
    const running = [...this.pulls.values()].filter((p) => p.controller);
    for (const pull of running) pull.controller!.abort(new Stopped('pause'));
    await Promise.all(running.map((p) => this.whenIdle(p)));
  }

  /**
   * Stops every download for good, as the app quits. Their saved state is left as it was, so the
   * pulls that were running pick up again next time.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    const running = [...this.pulls.values()].filter((p) => p.controller);
    for (const pull of running) pull.controller!.abort(new Stopped('shutdown'));
    await Promise.all(running.map((p) => this.whenIdle(p)));
  }

  /** Resumes the pulls `pauseAll` paused. */
  resumeAll(ids: string[]): void {
    for (const id of ids) if (this.pulls.has(id)) this.resume(id);
  }

  runningIds(): string[] {
    return [...this.pulls.values()]
      .filter((p) => !p.done && p.record.state !== 'paused' && p.record.state !== 'failed')
      .map((p) => p.record.id);
  }

  private track(record: PullRecord): ActivePull {
    const pull: ActivePull = {
      record,
      done: false,
      controller: null,
      samples: [],
      doneBytes: 0,
    };
    pull.doneBytes = this.downloadedBytes(pull);
    return pull;
  }

  private pump(): void {
    if (this.stopped) return;
    const limit = this.options.concurrency ?? 1;
    let running = [...this.pulls.values()].filter((p) => p.controller).length;
    for (const pull of this.pulls.values()) {
      if (running >= limit) break;
      if (pull.done || pull.controller || pull.record.state !== 'queued') continue;
      running++;
      void this.run(pull);
    }
  }

  private async run(pull: ActivePull): Promise<void> {
    const controller = new AbortController();
    pull.controller = controller;
    const { signal } = controller;
    const store = this.options.store();
    try {
      if (!pull.record.plan) {
        this.setState(pull, 'resolving');
        pull.record.plan = await this.options.resolve(pull.record.ref, signal);
        pull.doneBytes = this.downloadedBytes(pull);
        this.persist(pull);
      }
      const plan = pull.record.plan;

      // Another pull may have got there first, under another ref for the same model.
      const twin = [...this.pulls.values()].find(
        (p) => p !== pull && !p.done && p.record.plan?.model.id === plan.model.id,
      );
      if (twin) throw new DownloadError(`${plan.model.id} is already being pulled.`, false);

      const missing = plan.sources.filter((s) => !store.has(s.sha256));
      const remaining = missing.reduce(
        (sum, s) => sum + s.size - chunksDone(pull.record.chunks[s.sha256] ?? []),
        0,
      );
      const free = await store.freeBytes();
      if (remaining + DISK_MARGIN > free) {
        throw new DownloadError(
          `Not enough disk space: ${gib(remaining)} still to download, ${gib(free)} free.`,
          false,
        );
      }

      this.setState(pull, 'downloading');
      await mkdir(store.partialDir(pull.record.id), { recursive: true });
      for (const source of missing) {
        const chunks = (pull.record.chunks[source.sha256] ??= planChunks(source.size));
        await downloadFile({
          url: source.url,
          headers: this.options.headers?.(source.url) ?? {},
          size: source.size,
          file: store.partialPath(pull.record.id, source.sha256),
          chunks,
          signal,
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
          ...(this.options.connections ? { connections: this.options.connections } : {}),
          ...(this.options.retryDelayMs ? { retryDelayMs: this.options.retryDelayMs } : {}),
          onProgress: (bytes) => this.progress(pull, bytes),
          onCheckpoint: (snapshot) => this.checkpoint(pull, source.sha256, snapshot),
        });
      }

      this.setState(pull, 'verifying');
      for (const source of missing) {
        const partial = store.partialPath(pull.record.id, source.sha256);
        const digest = await sha256File(partial, { signal });
        if (digest !== source.sha256) {
          await rm(partial, { force: true });
          delete pull.record.chunks[source.sha256];
          throw new DownloadError(
            `${source.path} didn't match its checksum, so it was thrown away. Try the pull again.`,
            false,
          );
        }
        await rename(partial, store.blobPath(source.sha256));
      }
      await store.removePartial(pull.record.id);

      const previous = this.options.repo.getModel(plan.model.id);
      const model: ModelRecord = {
        ...plan.model,
        keepLoaded: previous?.keepLoaded ?? false,
        pulledAt: new Date(),
      };
      this.options.repo.putModel(model);
      this.options.repo.deletePull(pull.record.id);
      pull.done = true;
      pull.controller = null;
      this.emit('change');
      this.emit('pulled', model);
      // The model is in the library now; the finished pull lingers only long enough to be seen.
      setTimeout(() => this.dismiss(pull.record.id), DONE_LINGER_MS).unref();
    } catch (cause) {
      pull.controller = null;
      const stopped = signal.reason instanceof Stopped ? signal.reason : undefined;
      if (stopped?.action === 'shutdown') {
        // Leave the saved state alone: it carries on next time.
        this.emit('change');
      } else if (stopped?.action === 'cancel') {
        await this.discard(pull);
      } else if (stopped?.action === 'pause') {
        this.setState(pull, 'paused');
      } else {
        pull.record.error = describe(cause);
        this.setState(pull, 'failed');
      }
    } finally {
      pull.controller = null;
      this.pump();
    }
  }

  private async discard(pull: ActivePull): Promise<void> {
    this.pulls.delete(pull.record.id);
    this.options.repo.deletePull(pull.record.id);
    await this.options.store().removePartial(pull.record.id);
    this.emit('change');
  }

  private progress(pull: ActivePull, bytes: number): void {
    const now = Date.now();
    pull.doneBytes += bytes;
    pull.samples.push({ at: now, bytes });
    while (pull.samples.length > 0 && pull.samples[0]!.at < now - SPEED_WINDOW_MS)
      pull.samples.shift();
    this.emit('change');
  }

  private checkpoint(pull: ActivePull, sha256: string, snapshot: ChunkProgress[]): void {
    pull.record.chunks[sha256] = snapshot;
    this.persist(pull);
  }

  private setState(pull: ActivePull, state: PullRecord['state']): void {
    pull.record.state = state;
    if (state !== 'downloading') pull.samples = [];
    this.persist(pull);
    this.emit('change');
  }

  private persist(pull: ActivePull): void {
    if (pull.done) return;
    pull.record.updatedAt = new Date();
    this.options.repo.putPull(pull.record);
  }

  private downloadedBytes(pull: ActivePull): number {
    const plan = pull.record.plan;
    if (!plan) return 0;
    const store = this.options.store();
    return plan.sources.reduce(
      (sum, s) =>
        sum + (store.has(s.sha256) ? s.size : chunksDone(pull.record.chunks[s.sha256] ?? [])),
      0,
    );
  }

  private status(pull: ActivePull): PullStatus {
    const { record } = pull;
    const totalBytes = record.plan?.sources.reduce((sum, s) => sum + s.size, 0) ?? 0;
    const doneBytes = pull.done ? totalBytes : Math.min(pull.doneBytes, totalBytes);
    const windowBytes = pull.samples.reduce((sum, s) => sum + s.bytes, 0);
    const windowMs = pull.samples.length > 0 ? Date.now() - pull.samples[0]!.at : 0;
    const bytesPerSecond =
      record.state === 'downloading' && windowMs > 500 ? (windowBytes / windowMs) * 1000 : 0;
    return {
      id: record.id,
      ref: record.ref,
      modelId: record.plan?.model.id ?? null,
      title: record.plan?.model.title ?? null,
      state: pull.done ? 'done' : record.state,
      totalBytes,
      doneBytes,
      bytesPerSecond,
      etaSeconds: bytesPerSecond > 0 ? Math.round((totalBytes - doneBytes) / bytesPerSecond) : null,
      error: record.error,
      createdAt: record.createdAt,
    };
  }

  private require(id: string): ActivePull {
    const pull = this.pulls.get(id);
    if (!pull) throw new Error(`No pull ${id}`);
    return pull;
  }

  private whenIdle(pull: ActivePull): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!pull.controller) {
          this.off('change', check);
          resolve();
        }
      };
      this.on('change', check);
      check();
    });
  }
}

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}
