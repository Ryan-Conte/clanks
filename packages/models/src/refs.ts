import type { ModelId } from '@clanks/core';
import { ModelsError } from './errors';

export type ModelRef =
  | { kind: 'catalog'; name: string; tag: string | null }
  | { kind: 'huggingface'; repo: string; quant: string | null };

export class InvalidModelRefError extends ModelsError {
  constructor(ref: string) {
    super(
      `"${ref}" isn't a model name. Use a catalog name such as qwen3.5:9b, ` +
        'or a Hugging Face repo such as hf.co/<owner>/<repo>:<quant>.',
    );
  }
}

const HF_PREFIX = /^(?:https?:\/\/)?(?:www\.)?(?:hf\.co|huggingface\.co)\//i;
const REPO_PART = /^[A-Za-z0-9][\w.-]*$/;
const CATALOG = /^([a-z0-9][a-z0-9._-]*)(?::([a-z0-9][a-z0-9._-]*))?$/;

/**
 * Parses what a user types to pull a model: `qwen3.5:9b` or `qwen3.5` from the catalog, or a
 * Hugging Face repo as `hf.co/<owner>/<repo>[:<quant>]`, with `huggingface.co` and a full URL
 * accepted too.
 */
export function parseModelRef(input: string): ModelRef {
  const ref = input.trim();
  if (HF_PREFIX.test(ref)) {
    const rest = ref.replace(HF_PREFIX, '');
    const colon = rest.lastIndexOf(':');
    const path = colon === -1 ? rest : rest.slice(0, colon);
    const quant = colon === -1 ? null : rest.slice(colon + 1);
    // A pasted URL may go on to /tree/main or /blob/main/<file>; only the repo matters.
    const [owner, name] = path.split('/');
    if (!owner || !name || !REPO_PART.test(owner) || !REPO_PART.test(name)) {
      throw new InvalidModelRefError(input);
    }
    if (quant !== null && !/^[\w.-]+$/.test(quant)) throw new InvalidModelRefError(input);
    return { kind: 'huggingface', repo: `${owner}/${name}`, quant: quant || null };
  }
  const match = CATALOG.exec(ref.toLowerCase());
  if (!match?.[1]) throw new InvalidModelRefError(input);
  return { kind: 'catalog', name: match[1], tag: match[2] ?? null };
}

export function huggingFaceModelId(repo: string, quant: string): ModelId {
  return `hf.co/${repo}:${quant}`;
}

/** Companion files that sit next to the weights in many repos but aren't a model to chat with. */
const AUXILIARY = /^(?:mmproj|mtp|dflash|eagle\d*|draft|imatrix)[-_.]/i;
const SHARD = /-(\d{5})-of-(\d{5})$/;
const QUANT_LIKE = /^(?:I?Q\d\w*|TQ\d\w*|F16|BF16|F32|MXFP4\w*|NVFP4\w*)$/i;

/** Fallback order when a ref names no quant: a good default, then the next closest. */
const DEFAULT_QUANTS = [
  'Q4_K_M',
  'Q4_K',
  'Q4_0',
  'MXFP4',
  'IQ4_NL',
  'IQ4_XS',
  'Q4_K_S',
  'Q5_K_M',
  'Q6_K',
  'Q8_0',
];

export interface RepoFile {
  path: string;
  size: number;
  /** sha256 of the content. Only LFS files carry one, which every GGUF in a repo is. */
  sha256: string | null;
}

/** The quant a GGUF's file name declares: `Qwen3.5-9B-Q4_K_M.gguf` → `Q4_K_M`. */
export function quantOf(path: string): string | null {
  const base = path
    .split('/')
    .pop()!
    .replace(/\.gguf$/i, '')
    .replace(SHARD, '');
  const tokens = base.split(/[-.]/);
  const last = tokens.at(-1);
  if (!last || !QUANT_LIKE.test(last)) return null;
  const prefix = tokens.at(-2)?.toUpperCase() === 'UD' ? 'UD-' : '';
  return prefix + last.toUpperCase();
}

export interface PickedFiles {
  quant: string;
  /** The weights: one file, or every shard of a split model in order. */
  model: RepoFile[];
  projector: RepoFile | null;
  /** The quants the repo offers, for an error message when the asked-for one isn't there. */
  available: string[];
}

/**
 * Picks the weights for a quant from a repo's files, plus its multimodal projector if it has one.
 * Returns null when the repo has no GGUF weights at all.
 */
export function pickRepoFiles(files: RepoFile[], quant: string | null): PickedFiles | null {
  // Files whose name declares no quant are offered under their own name instead.
  const byQuant = new Map<string, RepoFile[]>();
  const unlabelled = new Set<string>();
  for (const file of files) {
    const base = file.path.split('/').pop()!;
    if (!/\.gguf$/i.test(base) || AUXILIARY.test(base)) continue;
    let q = quantOf(file.path);
    if (!q) {
      q = stem(base).replace(SHARD, '').toUpperCase();
      unlabelled.add(q);
    }
    byQuant.set(q, [...(byQuant.get(q) ?? []), file]);
  }
  if (byQuant.size === 0) return null;
  const available = [...byQuant.keys()].sort();

  let chosen: string | undefined;
  if (quant) {
    chosen = available.find((q) => q === quant.toUpperCase());
    if (!chosen) return { quant: quant.toUpperCase(), model: [], projector: null, available };
  } else {
    chosen =
      DEFAULT_QUANTS.find((q) => byQuant.has(q)) ??
      available.find((q) => !unlabelled.has(q) && !/^(F32|BF16|F16)$/.test(q)) ??
      available.find((q) => !unlabelled.has(q)) ??
      available[0]!;
  }

  // A quant may come as one file or as shards; if a repo has both, prefer the single file.
  const group = byQuant.get(chosen)!;
  const single = group.filter((f) => !SHARD.test(stem(f.path)));
  const model =
    single.length > 0
      ? [single.sort((a, b) => a.path.length - b.path.length)[0]!]
      : completeShards(group);
  return { quant: chosen, model, projector: pickProjector(files), available };
}

/** The shards of one split file, in order, or none if any are missing. */
function completeShards(files: RepoFile[]): RepoFile[] {
  const first = files.find((f) => SHARD.exec(stem(f.path))?.[1] === '00001');
  if (!first) return [];
  const prefix = stem(first.path).replace(SHARD, '');
  const total = Number(SHARD.exec(stem(first.path))![2]);
  const shards = files
    .filter((f) => stem(f.path).replace(SHARD, '') === prefix)
    .sort((a, b) => a.path.localeCompare(b.path));
  return shards.length === total ? shards : [];
}

const PROJECTOR_ORDER = ['Q8_0', 'F16', 'BF16', 'F32'];

function pickProjector(files: RepoFile[]): RepoFile | null {
  const projectors = files.filter((f) => /^mmproj[-_.].*\.gguf$/i.test(f.path.split('/').pop()!));
  if (projectors.length === 0) return null;
  const rank = (f: RepoFile) => {
    const index = PROJECTOR_ORDER.findIndex((q) => f.path.toUpperCase().includes(q));
    return index === -1 ? PROJECTOR_ORDER.length : index;
  };
  return projectors.sort((a, b) => rank(a) - rank(b))[0]!;
}

function stem(path: string): string {
  return path.replace(/\.gguf$/i, '');
}
