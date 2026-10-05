import type { ModelId, ModelRecord } from '@clanks/core';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ModelsError } from './errors';
import { capabilitiesFromTemplate, readGgufHeader } from './gguf';
import { sha256File } from './hash';
import { quantOf } from './refs';
import type { BlobStore } from './store';

const MODEL_LAYER = 'application/vnd.ollama.image.model';
const PROJECTOR_LAYER = 'application/vnd.ollama.image.projector';

/** A file in Ollama's blob store. Ollama names blobs by their sha256, as clanks does. */
export interface OllamaBlob {
  sha256: string;
  size: number;
  path: string;
}

/** A model in Ollama's folder, as `ollama list` shows it, with the id it gets in clanks. */
export interface OllamaModel {
  /** Ollama's name: `llama3.2:3b`, `user/model:tag` or `hf.co/owner/repo:Q4_K_M`. */
  name: string;
  id: ModelId;
  model: OllamaBlob;
  projector: OllamaBlob | null;
  size: number;
}

/**
 * Where Ollama keeps its models: `OLLAMA_MODELS` if it's set, the user's `~/.ollama/models`, and
 * on Linux the folder its system service uses.
 */
export function ollamaModelDirs(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const dirs = [env.OLLAMA_MODELS, join(home, '.ollama', 'models')];
  if (platform === 'linux') dirs.push('/usr/share/ollama/.ollama/models');
  return [...new Set(dirs.filter((d): d is string => Boolean(d)))];
}

/** The first of these folders that has Ollama models in it, or null. */
export async function findOllamaDir(dirs = ollamaModelDirs()): Promise<string | null> {
  for (const dir of dirs) {
    if (await isDirectory(join(dir, 'manifests'))) return dir;
  }
  return null;
}

/**
 * The GGUF models in an Ollama models folder. Ollama doesn't need to be running and is never
 * called: its manifests say which blob is which. Anything that isn't GGUF is skipped.
 */
export async function scanOllama(dir: string): Promise<OllamaModel[]> {
  const manifests = join(dir, 'manifests');
  const found: OllamaModel[] = [];
  // manifests/<host>/<namespace>/<model>/<tag>
  for (const host of await entries(manifests)) {
    for (const namespace of await entries(join(manifests, host))) {
      for (const model of await entries(join(manifests, host, namespace))) {
        for (const tag of await entries(join(manifests, host, namespace, model))) {
          const file = join(manifests, host, namespace, model, tag);
          const entry = await readManifest(dir, file, { host, namespace, model, tag });
          if (entry) found.push(entry);
        }
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

interface ManifestName {
  host: string;
  namespace: string;
  model: string;
  tag: string;
}

async function readManifest(
  dir: string,
  file: string,
  name: ManifestName,
): Promise<OllamaModel | null> {
  let manifest: { layers?: { mediaType?: string; digest?: string; size?: number }[] };
  try {
    if (!(await stat(file)).isFile()) return null;
    manifest = JSON.parse(await readFile(file, 'utf8')) as typeof manifest;
  } catch {
    return null;
  }
  const blob = (mediaType: string): OllamaBlob | null => {
    const layer = manifest.layers?.find((l) => l.mediaType === mediaType);
    const sha = /^sha256:([a-f0-9]{64})$/.exec(layer?.digest ?? '')?.[1];
    if (!sha || !layer?.size) return null;
    return { sha256: sha, size: layer.size, path: join(dir, 'blobs', `sha256-${sha}`) };
  };
  const model = blob(MODEL_LAYER);
  if (!model || !(await isGguf(model.path))) return null;
  const projector = blob(PROJECTOR_LAYER);
  const usableProjector = projector && (await isGguf(projector.path)) ? projector : null;
  return {
    name: ollamaName(name),
    id: ollamaModelId(name),
    model,
    projector: usableProjector,
    size: model.size + (usableProjector?.size ?? 0),
  };
}

function ollamaName({ host, namespace, model, tag }: ManifestName): string {
  if (host === 'registry.ollama.ai') {
    return namespace === 'library' ? `${model}:${tag}` : `${namespace}/${model}:${tag}`;
  }
  return `${host}/${namespace}/${model}:${tag}`;
}

/** `ollama/<model>:<tag>`, with the namespace for anything outside Ollama's own library. */
export function ollamaModelId({ host, namespace, model, tag }: ManifestName): ModelId {
  const part = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '');
  const ns = host === 'registry.ollama.ai' && namespace === 'library' ? '' : `${part(namespace)}/`;
  return `ollama/${ns}${part(model)}:${tag.replace(/[^\w.-]+/g, '-')}`;
}

export type ImportState = 'linking' | 'copying' | 'verifying' | 'failed';

export interface ImportProgress {
  state: ImportState;
  doneBytes: number;
  totalBytes: number;
}

/**
 * Brings an Ollama model into clanks' store: hard-linked where the two folders share a drive, so it
 * takes no more space, and copied where they don't. Every file is checked against its sha256 before
 * it's used, as a download would be. Returns the record to save.
 */
export async function importOllamaModel(
  model: OllamaModel,
  store: BlobStore,
  onProgress: (progress: ImportProgress) => void,
  signal?: AbortSignal,
): Promise<Omit<ModelRecord, 'keepLoaded' | 'pulledAt'>> {
  const blobs = [model.model, ...(model.projector ? [model.projector] : [])];
  const totalBytes = blobs.reduce((sum, b) => sum + b.size, 0);
  let doneBytes = 0;
  await store.init();

  for (const blob of blobs) {
    if (store.has(blob.sha256)) {
      doneBytes += blob.size;
      continue;
    }
    const target = store.blobPath(blob.sha256);
    const temp = `${target}.ollama`;
    await rm(temp, { force: true });
    try {
      onProgress({ state: 'linking', doneBytes, totalBytes });
      try {
        await link(blob.path, temp);
      } catch {
        // Another drive, or a file system without hard links: copy it.
        await copyWithProgress(blob.path, temp, signal, (bytes) =>
          onProgress({ state: 'copying', doneBytes: doneBytes + bytes, totalBytes }),
        );
      }
      onProgress({ state: 'verifying', doneBytes, totalBytes });
      const digest = await sha256File(temp, {
        ...(signal ? { signal } : {}),
        onProgress: (bytes) =>
          onProgress({ state: 'verifying', doneBytes: doneBytes + bytes, totalBytes }),
      });
      if (digest !== blob.sha256) {
        throw new ModelsError(`${model.name}'s file in Ollama's folder doesn't match its checksum`);
      }
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
    doneBytes += blob.size;
  }

  const header = await readGgufHeader(store.blobPath(model.model.sha256));
  const tag = model.name.split(':').pop() ?? '';
  const files = [
    {
      role: 'model' as const,
      path: 'model.gguf',
      sha256: model.model.sha256,
      size: model.model.size,
    },
    ...(model.projector
      ? [
          {
            role: 'projector' as const,
            path: 'mmproj.gguf',
            sha256: model.projector.sha256,
            size: model.projector.size,
          },
        ]
      : []),
  ];
  return {
    id: model.id,
    source: 'ollama',
    title: header.name ?? model.name,
    repo: model.name,
    revision: model.model.sha256,
    quant: quantOf(`${tag}.gguf`),
    params: header.sizeLabel,
    license: header.license,
    tags: ['general'],
    capabilities: capabilitiesFromTemplate(header.chatTemplate, model.projector !== null),
    files,
    facts: header.facts,
    size: model.size,
  };
}

async function copyWithProgress(
  from: string,
  to: string,
  signal: AbortSignal | undefined,
  onProgress: (bytes: number) => void,
): Promise<void> {
  let copied = 0;
  const source = createReadStream(from, { highWaterMark: 8 * 1024 ** 2 });
  source.on('data', (data) => {
    copied += data.length;
    onProgress(copied);
  });
  const target = createWriteStream(to);
  await (signal ? pipeline(source, target, { signal }) : pipeline(source, target));
}

async function isGguf(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r');
    try {
      const magic = Buffer.alloc(4);
      await handle.read(magic, 0, 4, 0);
      return magic.toString('latin1') === 'GGUF';
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).map((e) => e.name);
  } catch {
    return [];
  }
}
