import type {
  HardwareInfo,
  LoadedModelState,
  LoadedModelStatus,
  ModelId,
  ModelRecord,
} from '@clanks/core';
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  type WriteStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ModelsError } from '../errors';
import { autoSlots, memoryNeed, slotContext } from '../fit';
import { safeName } from '../store';
import type { RuntimeBuild } from './builds';
import {
  type LoadReport,
  applyLogMessage,
  emptyReport,
  parseLogLine,
  summarizeReport,
} from './log';
import { freePort, processName, runtimeEnv, sleep } from './process';

/** Holds a loaded model for one request. Release it when done so the model can idle out. */
export interface Lease {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The name to send as `model`: llama-server is started with the model's id as its alias. */
  readonly model: string;
  /** Speeds from the request, shown on the Models screen. */
  report(usage: { tokensPerSecond: number | null; promptTokensPerSecond: number | null }): void;
  release(): void;
}

export interface SupervisorConfig {
  /** Unload a model this long after its last use, unless it's kept loaded. */
  idleMs: number;
  contextPerSlot: number;
  /** Null picks from the hardware. */
  slots: number | null;
}

export interface SupervisorOptions {
  build: () => RuntimeBuild | null;
  hardware: () => HardwareInfo | null;
  config: () => SupervisorConfig;
  model: (id: ModelId) => ModelRecord | undefined;
  paths: (model: ModelRecord) => Promise<{ model: string; projector: string | null }>;
  logsDir: string;
  /** Children are recorded here, so ones a crashed app left behind can be stopped next time. */
  pidFile: string;
  healthTimeoutMs?: number;
  spawn?: typeof nodeSpawn;
  restartDelayMs?: (restart: number) => number;
}

export class ModelLoadError extends ModelsError {}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface Instance {
  modelId: ModelId;
  build: RuntimeBuild;
  state: LoadedModelState | 'stopping';
  child: ChildProcess | null;
  port: number;
  apiKey: string;
  contextPerSlot: number;
  slots: number;
  needBytes: number;
  leases: number;
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
  idleUnloadAt: number | null;
  restartTimes: number[];
  restarts: number;
  report: LoadReport;
  recent: { level: string; message: string }[];
  log: WriteStream | null;
  loadedAt: number | null;
  error: string | null;
  ready: Deferred;
  tokensPerSecond: number | null;
  promptTokensPerSecond: number | null;
}

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60_000;

/**
 * Runs one llama-server per loaded model: loads a model when something first needs it, shares it
 * between requests through parallel slots, unloads it when it has been idle, evicts idle models
 * when a new one needs the memory, and restarts a server that crashes.
 */
export class Supervisor extends EventEmitter<{ change: [] }> {
  private readonly instances = new Map<ModelId, Instance>();
  private admission: Promise<unknown> = Promise.resolve();
  private readonly waiters = new Set<() => void>();
  private closed = false;

  constructor(private readonly options: SupervisorOptions) {
    super();
    mkdirSync(options.logsDir, { recursive: true });
  }

  /** Stops llama-servers a previous run of the app left behind, if it didn't quit cleanly. */
  cleanupOrphans(): void {
    let pids: number[];
    try {
      pids = JSON.parse(readFileSync(this.options.pidFile, 'utf8')) as number[];
    } catch {
      return;
    }
    for (const pid of pids) {
      // Only ever a process that is still llama-server: the pid may have been reused since.
      if (processName(pid)?.includes('llama-server')) {
        try {
          process.kill(pid);
        } catch {
          // Already gone.
        }
      }
    }
    this.writePids();
  }

  /** Holds a model for a request, loading it first if it isn't loaded. */
  async acquire(modelId: ModelId, signal?: AbortSignal): Promise<Lease> {
    const instance = await this.ensure(modelId, signal);
    instance.leases++;
    this.clearIdle(instance);
    this.emit('change');
    try {
      await waitFor(instance.ready.promise, signal);
    } catch (error) {
      this.release(instance);
      throw error;
    }
    let released = false;
    return {
      get baseUrl() {
        return `http://127.0.0.1:${instance.port}`;
      },
      get apiKey() {
        return instance.apiKey;
      },
      model: modelId,
      report: (usage) => {
        if (usage.tokensPerSecond !== null) instance.tokensPerSecond = usage.tokensPerSecond;
        if (usage.promptTokensPerSecond !== null) {
          instance.promptTokensPerSecond = usage.promptTokensPerSecond;
        }
        this.emit('change');
      },
      release: () => {
        if (released) return;
        released = true;
        this.release(instance);
      },
    };
  }

  /** Loads a model ahead of use. It unloads when idle like any other. */
  async load(modelId: ModelId, signal?: AbortSignal): Promise<void> {
    const instance = await this.ensure(modelId, signal);
    await waitFor(instance.ready.promise, signal);
    this.scheduleIdle(instance);
  }

  async unload(modelId: ModelId): Promise<void> {
    const instance = this.instances.get(modelId);
    if (instance) await this.stop(instance);
  }

  async unloadAll(): Promise<void> {
    await Promise.all([...this.instances.values()].map((i) => this.stop(i)));
  }

  isLoaded(modelId: ModelId): boolean {
    return this.instances.has(modelId);
  }

  /** Re-reads a model's keep-loaded flag. */
  refreshIdle(modelId: ModelId): void {
    const instance = this.instances.get(modelId);
    if (instance) {
      this.clearIdle(instance);
      this.scheduleIdle(instance);
      this.emit('change');
    }
  }

  status(): LoadedModelStatus[] {
    return [...this.instances.values()].map((instance) => {
      const summary = summarizeReport(instance.report);
      return {
        modelId: instance.modelId,
        // Stopping instances leave the map straight away, so this never reports one.
        state: instance.state === 'stopping' ? 'ready' : instance.state,
        backend: instance.build.backend,
        context: instance.contextPerSlot * instance.slots,
        slots: instance.slots,
        inUse: instance.leases,
        ...summary,
        tokensPerSecond: instance.tokensPerSecond,
        promptTokensPerSecond: instance.promptTokensPerSecond,
        keepLoaded: this.options.model(instance.modelId)?.keepLoaded ?? false,
        idleUnloadAt: instance.idleUnloadAt === null ? null : new Date(instance.idleUnloadAt),
        loadedAt: instance.loadedAt === null ? null : new Date(instance.loadedAt),
        restarts: instance.restarts,
        error: instance.error,
      };
    });
  }

  /** Stops every server now. For quitting, when there's no time to wait. */
  close(): void {
    this.closed = true;
    for (const instance of this.instances.values()) {
      this.clearIdle(instance);
      instance.state = 'stopping';
      instance.child?.kill();
      instance.log?.end();
    }
    this.instances.clear();
    this.writePids();
  }

  private async ensure(modelId: ModelId, signal?: AbortSignal): Promise<Instance> {
    const existing = this.instances.get(modelId);
    if (existing && existing.state !== 'failed') return existing;
    if (existing) this.instances.delete(modelId);
    // One admission at a time, so two models can't both claim the same free memory.
    const admitted = this.admission.then(() => this.admit(modelId, signal));
    this.admission = admitted.catch(() => {});
    return admitted;
  }

  private async admit(modelId: ModelId, signal?: AbortSignal): Promise<Instance> {
    const existing = this.instances.get(modelId);
    if (existing && existing.state !== 'failed') return existing;
    if (this.closed) throw new ModelLoadError('clanks is quitting');

    const model = this.options.model(modelId);
    if (!model) throw new ModelLoadError(`${modelId} isn't pulled`);
    const build = this.options.build();
    if (!build) throw new ModelLoadError('No llama.cpp build is available on this machine');
    const hardware = this.options.hardware();
    const config = this.options.config();
    const slots = config.slots ?? (hardware ? autoSlots(hardware) : 1);
    const contextPerSlot = slotContext(model.facts, config.contextPerSlot);
    const { needBytes } = memoryNeed({
      weightsBytes: model.size,
      facts: model.facts,
      contextPerSlot,
      slots,
    });
    const budget = hardware
      ? hardware.budget.gpuBytes + (hardware.memory.unified ? 0 : hardware.budget.systemBytes)
      : Number.POSITIVE_INFINITY;

    // Make room: evict idle models, least recently used first and kept-loaded ones last. If
    // everything loaded is busy, wait for something to finish. A model too big for the budget on
    // its own still gets its chance once nothing else is loaded.
    for (;;) {
      const loaded = [...this.instances.values()];
      // A server that failed holds no memory, but its entry goes too if room is needed.
      const holding = loaded.filter((i) => i.state !== 'failed');
      const used = holding.reduce((sum, i) => sum + i.needBytes, 0);
      if (holding.length === 0 || used + needBytes <= budget) break;
      const idle = loaded
        .filter((i) => i.leases === 0 && i.state !== 'loading' && i.state !== 'restarting')
        .sort((a, b) => this.evictionRank(a) - this.evictionRank(b));
      if (idle[0]) {
        await this.stop(idle[0]);
        continue;
      }
      await this.waitForRelease(signal);
    }

    const instance: Instance = {
      modelId,
      build,
      state: 'loading',
      child: null,
      port: 0,
      apiKey: '',
      contextPerSlot,
      slots,
      needBytes,
      leases: 0,
      lastUsed: Date.now(),
      idleTimer: null,
      idleUnloadAt: null,
      restartTimes: [],
      restarts: 0,
      report: emptyReport(),
      recent: [],
      log: null,
      loadedAt: null,
      error: null,
      ready: deferred(),
      tokensPerSecond: null,
      promptTokensPerSecond: null,
    };
    this.instances.set(modelId, instance);
    this.emit('change');
    void this.launch(instance, model);
    return instance;
  }

  private evictionRank(instance: Instance): number {
    if (instance.state === 'failed') return -1;
    const kept = this.options.model(instance.modelId)?.keepLoaded ?? false;
    return (kept ? 1e15 : 0) + instance.lastUsed;
  }

  private async launch(instance: Instance, model: ModelRecord): Promise<void> {
    try {
      const paths = await this.options.paths(model);
      instance.port = await freePort();
      instance.apiKey = randomBytes(24).toString('hex');
      instance.report = emptyReport();
      instance.recent = [];
      const { build } = instance;
      const args = [
        ...build.args,
        '--model',
        paths.model,
        ...(paths.projector ? ['--mmproj', paths.projector] : []),
        '--host',
        '127.0.0.1',
        '--port',
        String(instance.port),
        '--api-key',
        instance.apiKey,
        '--ctx-size',
        String(instance.contextPerSlot * instance.slots),
        '--parallel',
        String(instance.slots),
        '--alias',
        instance.modelId,
        '--jinja',
        '--no-webui',
        '--offline',
        '--metrics',
        '--log-colors',
        'off',
        '--log-jsonl',
        // Verbosity 4 adds where each buffer went, which the Models screen shows.
        '--log-verbosity',
        '4',
      ];
      instance.log?.end();
      instance.log = createWriteStream(
        join(this.options.logsDir, `llama-server-${safeName(instance.modelId)}.log`),
      );
      const child = (this.options.spawn ?? nodeSpawn)(build.command, args, {
        cwd: build.dir,
        env: runtimeEnv(build),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      instance.child = child;
      this.writePids();

      const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child.once('error', (error) => resolve({ code: null, error }));
        child.once('exit', (code) => resolve({ code }));
      });
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        createInterface({ input: stream }).on('line', (line) => this.onLine(instance, line));
      }
      void exited.then((result) => this.onExit(instance, child, result));

      await this.waitHealthy(instance, exited);
      instance.state = 'ready';
      instance.loadedAt = Date.now();
      instance.error = null;
      instance.ready.resolve();
      this.scheduleIdle(instance);
      this.emit('change');
    } catch (error) {
      if (instance.state === 'stopping') return;
      instance.state = 'failed';
      instance.error = this.explain(instance, error);
      instance.child?.kill();
      instance.ready.reject(new ModelLoadError(instance.error));
      this.notifyWaiters();
      this.emit('change');
    }
  }

  private async waitHealthy(
    instance: Instance,
    exited: Promise<{ code: number | null; error?: Error }>,
  ): Promise<void> {
    let exit: { code: number | null; error?: Error } | undefined;
    void exited.then((result) => (exit = result));
    // A big model on a slow disk can take minutes to load.
    const deadline = Date.now() + (this.options.healthTimeoutMs ?? 10 * 60_000);
    for (;;) {
      if (instance.state === 'stopping') throw new ModelLoadError('Unloaded while loading');
      if (exit) {
        throw new ModelLoadError(
          exit.error
            ? `llama-server didn't start: ${exit.error.message}`
            : `llama-server exited with code ${exit.code}`,
        );
      }
      if (Date.now() > deadline) throw new ModelLoadError('The model took too long to load');
      try {
        const response = await fetch(`http://127.0.0.1:${instance.port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      await sleep(200);
    }
  }

  private onLine(instance: Instance, line: string): void {
    // A server that was told to stop can still flush a few lines after its log is closed.
    if (instance.log && !instance.log.writableEnded) instance.log.write(line + '\n');
    const entry = parseLogLine(line);
    if (!entry) return;
    applyLogMessage(instance.report, entry.message);
    instance.recent.push(entry);
    if (instance.recent.length > 40) instance.recent.shift();
  }

  private onExit(
    instance: Instance,
    child: ChildProcess,
    result: { code: number | null; error?: Error },
  ): void {
    if (instance.child !== child) return;
    instance.child = null;
    this.writePids();
    // Stopping on purpose, or still loading: `stop` and `launch` handle those.
    if (instance.state !== 'ready') return;

    const now = Date.now();
    instance.restartTimes = instance.restartTimes.filter((t) => t > now - RESTART_WINDOW_MS);
    if (instance.restartTimes.length >= MAX_RESTARTS) {
      instance.state = 'failed';
      instance.error =
        `llama-server keeps crashing (exit ${result.code}). ${this.lastError(instance)}`.trim();
      this.clearIdle(instance);
      this.notifyWaiters();
      this.emit('change');
      return;
    }
    instance.restartTimes.push(now);
    instance.restarts++;
    instance.state = 'restarting';
    instance.ready = deferred();
    this.clearIdle(instance);
    this.emit('change');
    const delay =
      this.options.restartDelayMs?.(instance.restarts) ?? 1000 * 2 ** (instance.restarts - 1);
    setTimeout(() => {
      if (instance.state !== 'restarting' || this.closed) return;
      const model = this.options.model(instance.modelId);
      if (!model) {
        void this.stop(instance);
        return;
      }
      instance.state = 'loading';
      void this.launch(instance, model);
    }, delay).unref();
  }

  private async stop(instance: Instance): Promise<void> {
    if (this.instances.get(instance.modelId) !== instance) return;
    this.instances.delete(instance.modelId);
    this.clearIdle(instance);
    const child = instance.child;
    const wasLoading = instance.state === 'loading' || instance.state === 'restarting';
    instance.state = 'stopping';
    if (wasLoading)
      instance.ready.reject(new ModelLoadError('Unloaded before it finished loading'));
    if (child && child.exitCode === null && child.signalCode === null) {
      const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      const forced = setTimeout(() => child.kill('SIGKILL'), 5000);
      await gone;
      clearTimeout(forced);
    }
    instance.child = null;
    instance.log?.end();
    this.writePids();
    this.notifyWaiters();
    this.emit('change');
  }

  private release(instance: Instance): void {
    instance.leases = Math.max(0, instance.leases - 1);
    instance.lastUsed = Date.now();
    this.scheduleIdle(instance);
    this.notifyWaiters();
    this.emit('change');
  }

  private scheduleIdle(instance: Instance): void {
    this.clearIdle(instance);
    if (instance.leases > 0 || instance.state !== 'ready') return;
    if (this.options.model(instance.modelId)?.keepLoaded) return;
    const ms = this.options.config().idleMs;
    instance.idleUnloadAt = Date.now() + ms;
    instance.idleTimer = setTimeout(() => void this.stop(instance), ms);
    instance.idleTimer.unref();
  }

  private clearIdle(instance: Instance): void {
    if (instance.idleTimer) clearTimeout(instance.idleTimer);
    instance.idleTimer = null;
    instance.idleUnloadAt = null;
  }

  private waitForRelease(signal?: AbortSignal): Promise<void> {
    return waitFor(
      new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      }),
      signal,
    );
  }

  private notifyWaiters(): void {
    for (const wake of [...this.waiters]) wake();
  }

  private explain(instance: Instance, error: unknown): string {
    const base = error instanceof Error ? error.message : String(error);
    const detail = this.lastError(instance);
    return detail ? `${base}. ${detail}` : base;
  }

  /** llama-server's last complaint, which usually says why it stopped. */
  private lastError(instance: Instance): string {
    const errors = instance.recent.filter(
      (e) => e.level === 'error' || /error|failed/i.test(e.message),
    );
    return (
      errors
        .at(-1)
        ?.message.replace(/^\S+\s+\S+:\s*/, '')
        .trim() ?? ''
    );
  }

  private writePids(): void {
    const pids = [...this.instances.values()]
      .map((i) => i.child?.pid)
      .filter((pid): pid is number => pid !== undefined);
    try {
      writeFileSync(this.options.pidFile, JSON.stringify(pids));
    } catch {
      // Best effort: it only helps clean up after a crash.
    }
  }
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nobody may be waiting when a load fails; that's not an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: Error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
