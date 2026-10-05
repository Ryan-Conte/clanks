import type { Catalog, ModelRecord } from '@clanks/core';
import { ModelsError } from './errors';
import { type RecommendInput, catalogModelId, findCatalogEntry } from './catalog';
import { capabilitiesFromTemplate, readGgufHeader } from './gguf';
import type { HuggingFaceClient } from './huggingface';
import { huggingFaceModelId, parseModelRef, pickRepoFiles } from './refs';

/** A model as it will be recorded once pulled, and where each of its files comes from. */
export interface ModelPlan {
  model: Omit<ModelRecord, 'keepLoaded' | 'pulledAt'>;
  sources: { sha256: string; size: number; path: string; url: string }[];
}

export class ResolveError extends ModelsError {}

export interface ResolveContext {
  catalog: Catalog;
  hf: HuggingFaceClient;
  /** Picks the size of a catalog model that suits this machine when a ref names no tag. */
  machine?: RecommendInput;
  fetch?: typeof fetch;
}

/**
 * Works out what a ref means: a catalog entry needs nothing from the network; a Hugging Face repo
 * is listed, its files picked, and the weights' header read for the memory estimate.
 */
export async function resolveModelRef(
  ref: string,
  context: ResolveContext,
  signal?: AbortSignal,
): Promise<ModelPlan> {
  const parsed = parseModelRef(ref);
  const { hf } = context;

  if (parsed.kind === 'catalog') {
    const entry = findCatalogEntry(context.catalog, parsed.name, parsed.tag, context.machine);
    if (!entry) {
      const named = context.catalog.models.filter((m) => m.name === parsed.name);
      throw new ResolveError(
        named.length > 0
          ? `There's no ${parsed.name}:${parsed.tag}. Try ${named.map(catalogModelId).join(', ')}.`
          : `${parsed.name} isn't in the catalog. To pull from Hugging Face, use hf.co/<owner>/<repo>.`,
      );
    }
    return {
      model: {
        id: catalogModelId(entry),
        source: 'catalog',
        title: entry.title,
        repo: entry.repo,
        revision: entry.revision,
        quant: entry.quant,
        params: entry.params,
        license: entry.license,
        tags: entry.tags,
        capabilities: entry.capabilities,
        files: entry.files,
        facts: entry.facts,
        size: entry.files.reduce((sum, f) => sum + f.size, 0),
      },
      sources: entry.files.map((f) => ({
        sha256: f.sha256,
        size: f.size,
        path: f.path,
        url: hf.fileUrl(entry.repo, entry.revision, f.path),
      })),
    };
  }

  const { repo, quant } = parsed;
  const info = await hf.repoInfo(repo, signal);
  const files = await hf.listFiles(repo, info.revision, signal);
  const picked = pickRepoFiles(files, quant);
  if (!picked) {
    throw new ResolveError(`${repo} has no GGUF files, and clanks only runs GGUF models.`);
  }
  if (picked.model.length === 0) {
    throw new ResolveError(
      picked.available.includes(picked.quant)
        ? `${repo} is missing some shards of its ${picked.quant} files.`
        : `${repo} has no ${picked.quant} file. It has ${picked.available.join(', ')}.`,
    );
  }
  const chosen = [
    ...picked.model.map((f) => ({ ...f, role: 'model' as const })),
    ...(picked.projector ? [{ ...picked.projector, role: 'projector' as const }] : []),
  ];
  for (const file of chosen) {
    if (!file.sha256) throw new ResolveError(`${repo} has no checksum for ${file.path}.`);
  }

  const header = await readGgufHeader(hf.fileUrl(repo, info.revision, picked.model[0]!.path), {
    headers: hf.headers(),
    ...(context.fetch ? { fetch: context.fetch } : {}),
    ...(signal ? { signal } : {}),
  }).catch((error: unknown) => {
    if (signal?.aborted) throw signal.reason as Error;
    throw new ResolveError(
      `Couldn't read the model's header from Hugging Face: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  const modelFiles = chosen.map((f) => ({
    role: f.role,
    path: f.path,
    sha256: f.sha256!,
    size: f.size,
  }));
  return {
    model: {
      id: huggingFaceModelId(repo, picked.quant),
      source: 'huggingface',
      title: header.name ?? repo.split('/')[1]!,
      repo,
      revision: info.revision,
      quant: picked.quant,
      params: header.sizeLabel,
      license: info.license ?? header.license,
      tags: ['general'],
      capabilities: capabilitiesFromTemplate(header.chatTemplate, picked.projector !== null),
      files: modelFiles,
      facts: header.facts,
      size: modelFiles.reduce((sum, f) => sum + f.size, 0),
    },
    sources: modelFiles.map((f) => ({
      sha256: f.sha256,
      size: f.size,
      path: f.path,
      url: hf.fileUrl(repo, info.revision, f.path),
    })),
  };
}
