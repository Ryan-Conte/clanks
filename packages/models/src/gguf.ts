import type { GgufFacts, ModelCapabilities } from '@clanks/core';
import { gguf } from '@huggingface/gguf';

type Metadata = Record<string, unknown>;

export interface GgufHeader {
  facts: GgufFacts;
  chatTemplate: string | null;
  license: string | null;
  name: string | null;
  sizeLabel: string | null;
}

/**
 * Reads a GGUF header without downloading the weights: over HTTP range requests for a URL, or from
 * the start of a local file.
 */
export async function readGgufHeader(
  uri: string,
  options: { fetch?: typeof fetch; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<GgufHeader> {
  const local = !/^https?:\/\//.test(uri);
  const doFetch = options.fetch ?? fetch;
  const { signal } = options;
  const { metadata, parameterCount } = await gguf(uri, {
    computeParametersCount: true,
    allowLocalFile: local,
    // A big tokenizer can take several range requests; stopping should stop them.
    fetch: signal ? (input, init) => doFetch(input, { ...init, signal }) : doFetch,
    ...(options.headers ? { additionalFetchHeaders: options.headers } : {}),
  });
  return headerFromMetadata(metadata as unknown as Metadata, parameterCount);
}

export function headerFromMetadata(metadata: Metadata, parameterCount?: number): GgufHeader {
  return {
    facts: ggufFacts(metadata, parameterCount),
    chatTemplate: str(metadata['tokenizer.chat_template']),
    license: str(metadata['general.license']),
    name: str(metadata['general.name']),
    sizeLabel: str(metadata['general.size_label']),
  };
}

/**
 * Architectures whose sliding-window layers follow a fixed pattern that llama.cpp hardcodes rather
 * than reading from the file: every Nth layer keeps the whole context, the rest only the window.
 */
const IMPLICIT_SWA_PERIOD: Record<string, number> = {
  'gpt-oss': 2,
  gemma2: 2,
  gemma3: 6,
};

/**
 * What the memory estimate needs from a GGUF header: the layers that keep a KV cache and how
 * big each token's entry is. Hybrid models only cache their attention layers; recurrent layers keep
 * a small fixed state, which the estimate's overhead covers. Unknown layouts count every layer as
 * full attention, so the estimate errs on the large side.
 */
export function ggufFacts(metadata: Metadata, parameterCount?: number): GgufFacts {
  const architecture = str(metadata['general.architecture']) ?? 'unknown';
  const key = (name: string) => metadata[`${architecture}.${name}`];

  const blockCount = num(key('block_count')) ?? 0;
  const contextLength = num(key('context_length')) ?? 4096;
  const embedding = num(key('embedding_length'));
  const headCount = numOrList(key('attention.head_count'));
  const kvHeads = numOrList(key('attention.head_count_kv')) ?? headCount;
  const firstHeads = Array.isArray(headCount) ? headCount.find((n) => n > 0) : headCount;
  const keyLength =
    num(key('attention.key_length')) ??
    (embedding && firstHeads ? Math.round(embedding / firstHeads) : 128);
  const valueLength = num(key('attention.value_length')) ?? keyLength;
  const keyLengthSwa = num(key('attention.key_length_swa')) ?? keyLength;
  const valueLengthSwa = num(key('attention.value_length_swa')) ?? valueLength;
  const slidingWindow = num(key('attention.sliding_window')) ?? 0;
  const swaPattern = boolList(key('attention.sliding_window_pattern'));
  const swaPeriod = IMPLICIT_SWA_PERIOD[architecture];
  const sharedKvLayers = num(key('attention.shared_kv_layers')) ?? 0;
  const fullAttentionInterval = num(key('full_attention_interval')) ?? 0;

  const isSwa = (layer: number): boolean => {
    if (slidingWindow <= 0) return false;
    if (swaPattern) return swaPattern[layer] === true;
    if (swaPeriod) return layer % swaPeriod < swaPeriod - 1;
    return false;
  };

  let kvPerToken = 0;
  let swaKvPerToken = 0;
  // The last `shared_kv_layers` layers read the caches of earlier ones and keep none of their own.
  const cachedLayers = Math.max(0, blockCount - sharedKvLayers);
  for (let layer = 0; layer < cachedLayers; layer++) {
    const heads = Array.isArray(kvHeads) ? (kvHeads[layer] ?? 0) : (kvHeads ?? 0);
    if (heads <= 0) continue;
    // Linear-attention layers in between the full ones keep a recurrent state instead.
    if (fullAttentionInterval > 0 && (layer + 1) % fullAttentionInterval !== 0) continue;
    if (isSwa(layer)) swaKvPerToken += heads * (keyLengthSwa + valueLengthSwa);
    else kvPerToken += heads * (keyLength + valueLength);
  }

  return {
    architecture,
    blockCount,
    contextLength,
    kvPerToken,
    swaKvPerToken,
    slidingWindow: swaKvPerToken > 0 ? slidingWindow : 0,
    parameterCount: parameterCount ?? null,
  };
}

/** What a model can do, judged from its chat template and whether it ships a projector. */
export function capabilitiesFromTemplate(
  template: string | null,
  hasProjector: boolean,
): ModelCapabilities {
  const t = template ?? '';
  return {
    tools: /\btools\b/.test(t) || /tool_call/.test(t),
    vision: hasProjector,
    reasoning: /<think>|enable_thinking|reasoning_content|reasoning_effort|<\|channel\|>/.test(t),
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

function numOrList(value: unknown): number | number[] | undefined {
  if (Array.isArray(value)) return value.map((v) => num(v) ?? 0);
  return num(value);
}

function boolList(value: unknown): boolean[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'boolean') ? value : undefined;
}
