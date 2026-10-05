import type {
  Catalog,
  CatalogEntry,
  FitEstimate,
  HardwareInfo,
  ModelId,
  ModelPreview,
  ModelRecord,
  ModelStorage,
  PullStatus,
  RuntimeBackend,
  RuntimeInstallStatus,
  RuntimeStatus,
  Settings,
} from '@clanks/core';
import { type spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { bundledCatalog, catalogModelId, catalogWeightsBytes, recommendModel } from './catalog';
import { describe } from './download';
import { ModelsError } from './errors';
import { autoSlots, estimateFit } from './fit';
import { type ProbeResult, probeHardware } from './hardware';
import { HuggingFaceClient } from './huggingface';
import {
  type ImportProgress,
  type OllamaModel,
  findOllamaDir,
  importOllamaModel,
  ollamaModelDirs,
  scanOllama,
} from './ollama';
import { PullManager } from './pulls';
import { type ModelPlan, resolveModelRef } from './resolve';
import {
  type RuntimeBuild,
  assetsFor,
  buildDir,
  findBuilds,
  installBuild,
  llamaCpp,
} from './runtime/builds';
import { type Lease, Supervisor } from './runtime/supervisor';
import { BlobStore, type ModelRepository, freeBytes } from './store';

/** How long a looked-up ref stays good for: repos rarely change between a preview and a pull. */
const RESOLVE_CACHE_MS = 10 * 60_000;

export interface ModelManagerOptions {
  runtimeDir: string;
  logsDir: string;
  /** Where models go unless the user has moved them. */
  defaultModelsDir: string;
  /** The folder the user moved models to, kept by the orchestrator. Null means the default. */
  modelsDir: { get(): string | null; set(dir: string | null): void };
  /** llama.cpp builds shipped inside the app. */
  bundledRuntimeDir?: string;
  repo: ModelRepository;
  settings: () => Settings;
  hfToken?: () => string | undefined;
  fetch?: typeof fetch;
  hfEndpoint?: string;
  catalog?: Catalog;
  /** Tests swap in their own builds, probe and process spawner. */
  builds?: () => RuntimeBuild[];
  probe?: (builds: RuntimeBuild[]) => Promise<ProbeResult>;
  spawn?: typeof spawn;
  connections?: number;
  retryDelayMs?: (attempt: number) => number;
  /** Where to look for Ollama's models. Tests point it at a fixture. */
  ollamaDirs?: () => string[];
}

/** A model in Ollama's folder that clanks can reuse. */
export interface OllamaItem {
  /** Ollama's name for it. */
  name: string;
  /** The id it gets, or has, in clanks. */
  id: ModelId;
  size: number;
  vision: boolean;
  imported: boolean;
}

/** An import from Ollama under way, or one that failed. */
export interface ImportStatus extends ImportProgress {
  name: string;
  id: ModelId;
  error: string | null;
}

export interface CatalogItem extends CatalogEntry {
  id: ModelId;
  size: number;
  pulled: boolean;
  fit: FitEstimate | null;
}

export interface LibraryItem extends ModelRecord {
  fit: FitEstimate | null;
  loaded: boolean;
  /** Some of its files are gone from the store, so it needs pulling again. */
  missing: boolean;
}

/**
 * Everything to do with local models: the catalog, pulls, the store, the hardware and the
 * llama-server processes. Emits `change` whenever anything the Models screen shows changes.
 */
export class ModelManager extends EventEmitter<{ change: [] }> {
  readonly supervisor: Supervisor;
  readonly pulls: PullManager;
  private readonly hf: HuggingFaceClient;
  private readonly catalogData: Catalog;
  private store: BlobStore;
  private probed: ProbeResult | null = null;
  private install: RuntimeInstallStatus | null = null;
  private installController: AbortController | null = null;
  private moving: ModelStorage['move'] = null;
  private readonly importing = new Map<string, ImportStatus>();
  private closed = false;
  private readonly resolved = new Map<string, { plan: ModelPlan; at: number }>();

  constructor(private readonly options: ModelManagerOptions) {
    super();
    this.catalogData = options.catalog ?? bundledCatalog;
    this.store = new BlobStore(options.modelsDir.get() ?? options.defaultModelsDir);
    this.hf = new HuggingFaceClient({
      ...(options.hfEndpoint ? { endpoint: options.hfEndpoint } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.hfToken ? { token: options.hfToken } : {}),
    });
    this.pulls = new PullManager({
      repo: options.repo,
      store: () => this.store,
      resolve: (ref, signal) => this.resolve(ref, signal),
      headers: (url) => (url.startsWith(this.hf.endpoint) ? this.hf.headers() : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.connections ? { connections: options.connections } : {}),
      ...(options.retryDelayMs ? { retryDelayMs: options.retryDelayMs } : {}),
    });
    this.supervisor = new Supervisor({
      build: () => this.probed?.build ?? null,
      hardware: () => this.probed?.hardware ?? null,
      config: () => {
        const settings = options.settings();
        return {
          idleMs: settings.modelIdleMinutes * 60_000,
          contextPerSlot: settings.contextPerSlot,
          slots: settings.parallelSlots,
        };
      },
      model: (id) => options.repo.getModel(id),
      paths: (model) => this.store.modelPaths(model),
      logsDir: options.logsDir,
      pidFile: join(options.runtimeDir, 'servers.json'),
      ...(options.spawn ? { spawn: options.spawn } : {}),
    });
    this.pulls.on('change', () => this.emit('change'));
    this.supervisor.on('change', () => this.emit('change'));
  }

  async start(): Promise<void> {
    await mkdir(this.options.runtimeDir, { recursive: true });
    if (this.closed) return;
    this.supervisor.cleanupOrphans();
    await this.refreshHardware();
    if (this.closed) return;
    await this.pulls.start();
  }

  /** Stops everything at once, for quitting. Interrupted pulls carry on next time. */
  close(): void {
    this.closed = true;
    void this.pulls.shutdown();
    this.installController?.abort();
    this.supervisor.close();
  }

  // Hardware and runtime

  hardware(): HardwareInfo | null {
    return this.probed?.hardware ?? null;
  }

  /** Probes again. Loaded models are unloaded first, since the build or budget may change. */
  async refreshHardware(): Promise<HardwareInfo> {
    await this.supervisor.unloadAll();
    const builds = this.builds();
    const settings = this.options.settings();
    this.probed = await (this.options.probe ?? defaultProbe(settings))(builds);
    this.emit('change');
    return this.probed.hardware;
  }

  runtime(): RuntimeStatus {
    const builds = this.builds();
    const downloadable = assetsFor(process.platform, process.arch)
      .filter((a) => !a.bundled && !builds.some((b) => b.backend === a.backend))
      .map((a) => ({ backend: a.backend, size: a.files.reduce((sum, f) => sum + f.size, 0) }));
    return {
      version: llamaCpp.build,
      backend: this.probed?.build?.backend ?? 'cpu',
      builds: builds.map((b) => ({ backend: b.backend, source: b.source })),
      downloadable,
      install: this.install,
      loaded: this.supervisor.status(),
    };
  }

  /** Downloads a build that doesn't ship with the app, such as CUDA, then switches to it. */
  async installRuntime(backend: RuntimeBackend): Promise<void> {
    if (this.install && this.install.state !== 'failed')
      throw new ModelsError('Already installing');
    const asset = assetsFor(process.platform, process.arch).find(
      (a) => a.backend === backend && !a.bundled,
    );
    if (!asset) throw new ModelsError(`There's no ${backend} build to download for this machine`);
    const root = join(this.options.runtimeDir, llamaCpp.build);
    const controller = new AbortController();
    this.installController = controller;
    const total = asset.files.reduce((sum, f) => sum + f.size, 0);
    this.install = { backend, state: 'downloading', totalBytes: total, doneBytes: 0, error: null };
    this.emit('change');
    try {
      await installBuild({
        asset,
        dest: buildDir(root, backend),
        downloadsDir: join(this.options.runtimeDir, 'downloads'),
        signal: controller.signal,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        onProgress: (state, done) => {
          this.install = { backend, state, totalBytes: total, doneBytes: done, error: null };
          this.emit('change');
        },
      });
      this.install = null;
      await this.refreshHardware();
    } catch (error) {
      this.install = controller.signal.aborted
        ? null
        : { backend, state: 'failed', totalBytes: total, doneBytes: 0, error: describe(error) };
      this.emit('change');
      if (!controller.signal.aborted) throw error;
    } finally {
      this.installController = null;
    }
  }

  cancelInstall(): void {
    this.installController?.abort();
  }

  // Catalog and library

  catalog(): CatalogItem[] {
    return this.catalogData.models.map((entry) => {
      const id = catalogModelId(entry);
      const size = catalogWeightsBytes(entry);
      return {
        ...entry,
        id,
        size,
        pulled: this.options.repo.getModel(id) !== undefined,
        fit: this.fit(size, entry.facts),
      };
    });
  }

  /** The catalog model to suggest for the crew on this machine. */
  recommended(): ModelId | null {
    const hardware = this.hardware();
    if (!hardware) return null;
    const entry = recommendModel(this.catalogData, hardware, this.shape());
    return entry ? catalogModelId(entry) : null;
  }

  library(): LibraryItem[] {
    return this.options.repo
      .listModels()
      .sort((a, b) => +b.pulledAt - +a.pulledAt)
      .map((model) => ({
        ...model,
        fit: this.fit(model.size, model.facts),
        loaded: this.supervisor.isLoaded(model.id),
        missing: model.files.some((f) => !this.store.has(f.sha256)),
      }));
  }

  /** What a ref would pull, and whether it would fit, without downloading anything. */
  async inspect(ref: string, signal?: AbortSignal): Promise<ModelPreview> {
    const plan = await this.resolve(ref, signal);
    const { model } = plan;
    const existing = this.options.repo.getModel(model.id);
    return {
      id: model.id,
      source: model.source,
      title: model.title,
      repo: model.repo,
      quant: model.quant,
      params: model.params,
      license: model.license,
      capabilities: model.capabilities,
      size: model.size,
      downloadBytes: plan.sources
        .filter((s) => !this.store.has(s.sha256))
        .reduce((sum, s) => sum + s.size, 0),
      contextLength: model.facts.contextLength,
      fit: this.fit(model.size, model.facts),
      pulled: existing !== undefined && existing.files.every((f) => this.store.has(f.sha256)),
    };
  }

  pull(ref: string): PullStatus {
    return this.pulls.pull(ref);
  }

  /** Ollama's models on this machine, if it has any. Ollama needn't be running. */
  async ollama(): Promise<{ dir: string; models: OllamaItem[] } | null> {
    const dir = await findOllamaDir(this.options.ollamaDirs?.() ?? ollamaModelDirs());
    if (!dir) return null;
    const models = await scanOllama(dir);
    return {
      dir,
      models: models.map((m) => ({
        name: m.name,
        id: m.id,
        size: m.size,
        vision: m.projector !== null,
        imported: this.options.repo.getModel(m.id) !== undefined,
      })),
    };
  }

  imports(): ImportStatus[] {
    return [...this.importing.values()];
  }

  /**
   * Reuses a model from Ollama's folder instead of downloading it again: its file is linked into
   * the store, or copied when it's on another drive, and checked by sha256.
   */
  async importOllama(name: string): Promise<ModelRecord> {
    const dir = await findOllamaDir(this.options.ollamaDirs?.() ?? ollamaModelDirs());
    const model: OllamaModel | undefined = dir
      ? (await scanOllama(dir)).find((m) => m.name === name)
      : undefined;
    if (!model) throw new ModelsError(`Ollama has no model called ${name}`);
    if (this.options.repo.getModel(model.id)) throw new ModelsError(`${name} is already in clanks`);
    const current = this.importing.get(name);
    if (current && current.state !== 'failed')
      throw new ModelsError(`${name} is already being imported`);

    const status: ImportStatus = {
      name,
      id: model.id,
      state: 'linking',
      doneBytes: 0,
      totalBytes: model.size,
      error: null,
    };
    this.importing.set(name, status);
    this.emit('change');
    try {
      const record = await importOllamaModel(model, this.store, (progress) => {
        Object.assign(status, progress);
        this.emit('change');
      });
      const saved: ModelRecord = { ...record, keepLoaded: false, pulledAt: new Date() };
      this.options.repo.putModel(saved);
      this.importing.delete(name);
      return saved;
    } catch (error) {
      Object.assign(status, { state: 'failed', error: describe(error) });
      throw error;
    } finally {
      this.emit('change');
    }
  }

  dismissImport(name: string): void {
    if (this.importing.get(name)?.state === 'failed') {
      this.importing.delete(name);
      this.emit('change');
    }
  }

  setKeepLoaded(id: ModelId, keepLoaded: boolean): void {
    const model = this.requireModel(id);
    this.options.repo.putModel({ ...model, keepLoaded });
    this.supervisor.refreshIdle(id);
    this.emit('change');
  }

  /** Unloads and deletes a model. Files another model shares stay. */
  async remove(id: ModelId): Promise<void> {
    const model = this.requireModel(id);
    await this.supervisor.unload(id);
    this.options.repo.deleteModel(id);
    const stillUsed = new Set(
      this.options.repo.listModels().flatMap((m) => m.files.map((f) => f.sha256)),
    );
    for (const file of model.files) {
      if (!stillUsed.has(file.sha256)) await this.store.removeBlob(file.sha256);
    }
    await this.store.removeLinks(id);
    this.emit('change');
  }

  async load(id: ModelId): Promise<void> {
    this.requireModel(id);
    await this.supervisor.load(id);
  }

  async unload(id: ModelId): Promise<void> {
    await this.supervisor.unload(id);
  }

  /** Unloads everything, so the next use loads with the current settings. */
  async unloadAll(): Promise<void> {
    await this.supervisor.unloadAll();
  }

  /** Holds a model for a request; the built-in provider calls this. */
  acquire(id: ModelId, signal?: AbortSignal): Promise<Lease> {
    return this.supervisor.acquire(id, signal);
  }

  // Storage

  async storage(): Promise<ModelStorage> {
    return {
      dir: this.store.dir,
      usedBytes: await this.store.usedBytes(),
      freeBytes: await this.store.freeBytes().catch(() => 0),
      move: this.moving,
    };
  }

  /**
   * Moves the models folder, for example to a bigger drive. Pulls pause and models unload while
   * it moves. Files are renamed when the new place is on the same drive, and otherwise copied in
   * full before the old copies are deleted, so a failed move loses nothing.
   */
  async moveStorage(chosen: string): Promise<void> {
    if (this.moving && !this.moving.error)
      throw new ModelsError('The models folder is already moving');
    const from = this.store.dir;
    const to = await targetFolder(resolve(chosen));
    if (to === resolve(from)) return;
    if (isInside(to, from)) throw new ModelsError("The models can't move into their own folder");

    const files = await listStoreFiles(from);
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    this.moving = { to, doneBytes: 0, totalBytes, error: null };
    this.emit('change');
    const paused = this.pulls.runningIds();
    await this.pulls.pauseAll();
    await this.supervisor.unloadAll();
    try {
      await mkdir(to, { recursive: true });
      if (await sameDrive(from, to)) {
        await renameAll(from, to, files);
      } else {
        const free = await freeBytes(to);
        if (free < totalBytes) {
          throw new ModelsError(
            `Not enough space there: the models need ${gb(totalBytes)} and ${gb(free)} is free.`,
          );
        }
        await copyAll(from, to, files, (bytes) => {
          this.moving!.doneBytes += bytes;
          this.emit('change');
        });
        for (const file of files) await unlink(join(from, file.path)).catch(() => {});
      }
      await rm(join(from, 'links'), { recursive: true, force: true });
      for (const dir of ['partial', 'blobs']) await rmTreeIfEmpty(join(from, dir));
      if (from !== this.options.defaultModelsDir) await rmdir(from).catch(() => {});

      this.store = new BlobStore(to);
      await this.store.init();
      this.options.modelsDir.set(to === resolve(this.options.defaultModelsDir) ? null : to);
      this.moving = null;
    } catch (error) {
      this.moving = { to, doneBytes: 0, totalBytes, error: describe(error) };
      throw error;
    } finally {
      this.pulls.resumeAll(paused);
      this.emit('change');
    }
  }

  /** A move under way, or one that failed and hasn't been dismissed. */
  moveStatus(): ModelStorage['move'] {
    return this.moving;
  }

  dismissMoveError(): void {
    if (this.moving?.error) {
      this.moving = null;
      this.emit('change');
    }
  }

  // Internals

  private builds(): RuntimeBuild[] {
    return (
      this.options.builds?.() ??
      findBuilds({
        bundledDir: this.options.bundledRuntimeDir,
        runtimeDir: this.options.runtimeDir,
      })
    );
  }

  /** Context and slots a model gets when loaded, from the settings and the hardware. */
  private shape(): { contextPerSlot: number; slots: number } {
    const settings = this.options.settings();
    const hardware = this.hardware();
    return {
      contextPerSlot: settings.contextPerSlot,
      slots: settings.parallelSlots ?? (hardware ? autoSlots(hardware) : 1),
    };
  }

  private fit(weightsBytes: number, facts: ModelRecord['facts']): FitEstimate | null {
    const hardware = this.hardware();
    return hardware ? estimateFit({ weightsBytes, facts, ...this.shape() }, hardware) : null;
  }

  /**
   * Works out what a ref means. Looking up a Hugging Face repo reads a header that can run to
   * megabytes, so a pull right after its preview reuses the answer.
   */
  private async resolve(ref: string, signal?: AbortSignal): Promise<ModelPlan> {
    const now = Date.now();
    for (const [key, entry] of this.resolved) {
      if (now - entry.at > RESOLVE_CACHE_MS) this.resolved.delete(key);
    }
    const cached = this.resolved.get(ref);
    if (cached) return cached.plan;
    const plan = await resolveModelRef(ref, this.resolveContext(), signal);
    this.resolved.set(ref, { plan, at: Date.now() });
    return plan;
  }

  private resolveContext() {
    const hardware = this.hardware();
    return {
      catalog: this.catalogData,
      hf: this.hf,
      ...(hardware ? { machine: { hardware, shape: this.shape() } } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    };
  }

  private requireModel(id: ModelId): ModelRecord {
    const model = this.options.repo.getModel(id);
    if (!model) throw new ModelsError(`${id} isn't pulled`);
    return model;
  }
}

function defaultProbe(settings: Settings) {
  return (builds: RuntimeBuild[]) =>
    probeHardware({
      builds,
      overrides: {
        backend: settings.runtimeBackend,
        gpuBudgetMiB: settings.gpuBudgetMiB,
        systemBudgetMiB: settings.systemBudgetMiB,
      },
    });
}

interface StoreFile {
  /** Relative to the models folder. */
  path: string;
  size: number;
}

async function listStoreFiles(root: string): Promise<StoreFile[]> {
  const files: StoreFile[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push({ path, size: (await stat(join(root, path))).size });
    }
  };
  await walk('blobs');
  await walk('partial');
  return files;
}

/** Moving into a folder that has other things in it puts the models in a folder of their own. */
async function targetFolder(chosen: string): Promise<string> {
  if (!existsSync(chosen)) return chosen;
  const entries = await readdir(chosen);
  const isStore = entries.includes('blobs');
  return entries.length === 0 || isStore ? chosen : join(chosen, 'clanks-models');
}

async function sameDrive(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  return sa.dev === sb.dev;
}

async function renameAll(from: string, to: string, files: StoreFile[]): Promise<void> {
  const done: StoreFile[] = [];
  try {
    for (const file of files) {
      await mkdir(dirname(join(to, file.path)), { recursive: true });
      await rename(join(from, file.path), join(to, file.path));
      done.push(file);
    }
  } catch (error) {
    // Put back what already moved, so the store is whole in one place or the other.
    for (const file of done.reverse()) {
      await rename(join(to, file.path), join(from, file.path)).catch(() => {});
    }
    throw error;
  }
}

async function copyAll(
  from: string,
  to: string,
  files: StoreFile[],
  onProgress: (bytes: number) => void,
): Promise<void> {
  try {
    for (const file of files) {
      await mkdir(dirname(join(to, file.path)), { recursive: true });
      const source = createReadStream(join(from, file.path), { highWaterMark: 8 * 1024 ** 2 });
      source.on('data', (data) => onProgress(data.length));
      await pipeline(source, createWriteStream(join(to, file.path)));
    }
  } catch (error) {
    for (const file of files) await rm(join(to, file.path), { force: true }).catch(() => {});
    throw error;
  }
}

async function rmTreeIfEmpty(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await rmTreeIfEmpty(join(dir, entry.name));
  }
  await rmdir(dir).catch(() => {});
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
