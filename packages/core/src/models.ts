import { z } from 'zod';

/**
 * A pulled model's id: `name:tag` for catalog models (`qwen3.5:9b`), or
 * `hf.co/<owner>/<repo>:<quant>` for a model pulled straight from Hugging Face.
 */
export const modelIdSchema = z
  .string()
  .max(200)
  .regex(
    /^(?:[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*|hf\.co\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*:[\w.-]+)$/,
    'Use name:tag, or hf.co/<owner>/<repo>:<quant>',
  );

export type ModelId = z.infer<typeof modelIdSchema>;

/** What a user types to pull a model: a catalog name, or a Hugging Face repo with an optional quant. */
export const modelRefSchema = z.string().trim().min(1).max(300);

/** The llama.cpp builds clanks runs. */
export const runtimeBackendSchema = z.enum(['cpu', 'vulkan', 'cuda', 'metal']);

export type RuntimeBackend = z.infer<typeof runtimeBackendSchema>;

/** Catalog role tags. Each clank's priming doc lists the ones it wants in `model.tags`. */
export const modelTagSchema = z.enum([
  'code',
  'general',
  'reasoning',
  'writing',
  'design',
  'long-context',
]);

export type ModelTag = z.infer<typeof modelTagSchema>;

export const modelCapabilitiesSchema = z.object({
  /** The chat template supports native tool calls. */
  tools: z.boolean(),
  /** A multimodal projector comes with the model, so it can read images. */
  vision: z.boolean(),
  /** The model thinks before it answers. */
  reasoning: z.boolean(),
});

export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

/** What the memory estimate needs from a GGUF header. */
export const ggufFactsSchema = z.object({
  architecture: z.string(),
  blockCount: z.number().int().nonnegative(),
  /** The context the model was trained for, in tokens. */
  contextLength: z.number().int().positive(),
  /** K and V cache elements per token, across the layers that keep the whole context. */
  kvPerToken: z.number().nonnegative(),
  /** The same for sliding-window layers, which keep at most `slidingWindow` tokens. */
  swaKvPerToken: z.number().nonnegative(),
  slidingWindow: z.number().int().nonnegative(),
  parameterCount: z.number().nonnegative().nullable(),
});

export type GgufFacts = z.infer<typeof ggufFactsSchema>;

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase sha256');

/** One file of a model in its Hugging Face repo. Stored in the blob store by digest. */
export const modelFileSchema = z.object({
  role: z.enum(['model', 'projector']),
  /** Path in the repo. Split models list every shard, in order. */
  path: z.string().min(1),
  sha256: sha256Schema,
  size: z.number().int().positive(),
});

export type ModelFile = z.infer<typeof modelFileSchema>;

export const catalogEntrySchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  tag: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  title: z.string().min(1),
  summary: z.string().min(1),
  repo: z.string().regex(/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/),
  /** The repo commit the files were checked at, so a pull always gets the same bytes. */
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  quant: z.string().min(1),
  /** Parameter count as people say it: `9B`, or `35B-A3B` for a mixture of experts. */
  params: z.string().min(1),
  license: z.string().min(1),
  tags: z.array(modelTagSchema).min(1),
  capabilities: modelCapabilitiesSchema,
  files: z.array(modelFileSchema).min(1),
  facts: ggufFactsSchema,
});

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogSchema = z.object({
  version: z.literal(1),
  models: z.array(catalogEntrySchema),
});

export type Catalog = z.infer<typeof catalogSchema>;

/** A model in the local store. */
export interface ModelRecord {
  id: ModelId;
  source: 'catalog' | 'huggingface';
  title: string;
  repo: string;
  revision: string;
  quant: string | null;
  params: string | null;
  license: string | null;
  tags: ModelTag[];
  capabilities: ModelCapabilities;
  files: ModelFile[];
  facts: GgufFacts;
  /** Total bytes on disk, projector included. */
  size: number;
  /** Never unload it for being idle. */
  keepLoaded: boolean;
  pulledAt: Date;
}

/** Where a model would run, before it is loaded. */
export type FitVerdict = 'gpu' | 'partial' | 'cpu' | 'too_large';

export interface FitEstimate {
  verdict: FitVerdict;
  /** Weights, KV cache and overhead at `context` × `slots`. */
  needBytes: number;
  weightsBytes: number;
  kvBytes: number;
  context: number;
  slots: number;
  /** The budgets the estimate was made against. */
  gpuBudgetBytes: number;
  systemBudgetBytes: number;
}

export interface GpuDevice {
  /** llama.cpp's device name, such as `CUDA0`, `Vulkan0` or `MTL0`. */
  id: string;
  name: string;
  backend: RuntimeBackend;
  totalBytes: number;
  freeBytes: number;
}

export interface HardwareInfo {
  platform: string;
  arch: string;
  cpu: { model: string; threads: number };
  memory: {
    totalBytes: number;
    freeBytes: number;
    /** Apple Silicon: the GPU shares system memory. */
    unified: boolean;
  };
  /** The devices the chosen backend runs models on. Empty means CPU only. */
  gpus: GpuDevice[];
  /** An NVIDIA GPU is present, so the CUDA build would run models faster. */
  nvidia: boolean;
  backend: RuntimeBackend;
  /** How much memory models may use, after the overrides in settings. */
  budget: { gpuBytes: number; systemBytes: number };
  /** Builds that failed to report their devices, with the reason. */
  problems: string[];
  probedAt: Date;
}

export type PullState =
  'queued' | 'resolving' | 'downloading' | 'verifying' | 'paused' | 'failed' | 'done';

export interface PullStatus {
  id: string;
  /** What was asked for. */
  ref: string;
  /** Known once the ref is resolved. */
  modelId: ModelId | null;
  title: string | null;
  state: PullState;
  totalBytes: number;
  doneBytes: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  error: string | null;
  createdAt: Date;
}

/** What a ref resolves to, shown before anything is downloaded. */
export interface ModelPreview {
  id: ModelId;
  source: ModelRecord['source'];
  title: string;
  repo: string;
  quant: string | null;
  params: string | null;
  license: string | null;
  capabilities: ModelCapabilities;
  size: number;
  /** Bytes still to download: files already in the store are shared, not fetched again. */
  downloadBytes: number;
  contextLength: number;
  /** Null until the hardware has been probed. */
  fit: FitEstimate | null;
  pulled: boolean;
}

export type LoadedModelState = 'loading' | 'ready' | 'restarting' | 'failed';

export interface LoadedModelStatus {
  modelId: ModelId;
  state: LoadedModelState;
  backend: RuntimeBackend;
  /** Total context across slots. */
  context: number;
  slots: number;
  /** Requests holding the model right now. */
  inUse: number;
  /** Where the weights ended up, from llama.cpp's own report. Null while loading. */
  placement: 'gpu' | 'partial' | 'cpu' | null;
  layers: { gpu: number; total: number } | null;
  memory: { gpuBytes: number; systemBytes: number } | null;
  devices: string[];
  tokensPerSecond: number | null;
  promptTokensPerSecond: number | null;
  keepLoaded: boolean;
  /** When it unloads if nothing uses it first. Null while in use or kept loaded. */
  idleUnloadAt: Date | null;
  loadedAt: Date | null;
  restarts: number;
  error: string | null;
}

export interface RuntimeBuildInfo {
  backend: RuntimeBackend;
  source: 'bundled' | 'downloaded';
}

export interface RuntimeInstallStatus {
  backend: RuntimeBackend;
  state: 'downloading' | 'verifying' | 'extracting' | 'failed';
  totalBytes: number;
  doneBytes: number;
  error: string | null;
}

export interface RuntimeStatus {
  /** The pinned llama.cpp release, such as `b11146`. */
  version: string;
  backend: RuntimeBackend;
  builds: RuntimeBuildInfo[];
  /** Builds that can be downloaded for this machine, with their size. */
  downloadable: { backend: RuntimeBackend; size: number }[];
  install: RuntimeInstallStatus | null;
  loaded: LoadedModelStatus[];
}

export interface ModelStorage {
  dir: string;
  /** Bytes used by pulled models and partial downloads. */
  usedBytes: number;
  /** Free space on the drive that holds the models folder. */
  freeBytes: number;
  move: { to: string; doneBytes: number; totalBytes: number; error: string | null } | null;
}
