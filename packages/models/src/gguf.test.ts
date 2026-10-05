import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitiesFromTemplate, ggufFacts, readGgufHeader } from './gguf';
import { ggufFile, llamaMetadata, serveFiles, startServer, tempDir } from './test/fixtures';

describe('ggufFacts', () => {
  it('counts every layer of a plain transformer', () => {
    const facts = ggufFacts(llamaMetadata(), 24_000_000);
    // 6 layers × 6 KV heads × (48 + 48), with the head size taken from embedding / heads.
    expect(facts).toEqual({
      architecture: 'llama',
      blockCount: 6,
      contextLength: 4096,
      kvPerToken: 6 * 6 * 96,
      swaKvPerToken: 0,
      slidingWindow: 0,
      parameterCount: 24_000_000,
    });
  });

  it('only counts the full-attention layers of a hybrid model', () => {
    // Qwen3.5 0.8B: 25 blocks, every fourth is full attention. llama.cpp reports 6 KV layers.
    const facts = ggufFacts({
      'general.architecture': 'qwen35',
      'qwen35.block_count': 25,
      'qwen35.context_length': 262144,
      'qwen35.attention.head_count': 8,
      'qwen35.attention.head_count_kv': 2,
      'qwen35.attention.key_length': 256,
      'qwen35.attention.value_length': 256,
      'qwen35.full_attention_interval': 4,
    });
    expect(facts.kvPerToken).toBe(6 * 2 * 512);
  });

  it('reads per-layer KV heads, where recurrent layers have none', () => {
    const facts = ggufFacts({
      'general.architecture': 'nemotron_h_moe',
      'nemotron_h_moe.block_count': 6,
      'nemotron_h_moe.context_length': 1048576,
      'nemotron_h_moe.attention.head_count': 32,
      'nemotron_h_moe.attention.head_count_kv': [0, 0, 2, 0, 0, 2],
      'nemotron_h_moe.attention.key_length': 128,
      'nemotron_h_moe.attention.value_length': 128,
    });
    expect(facts.kvPerToken).toBe(2 * 2 * 256);
  });

  it('splits sliding-window layers out and skips shared KV layers', () => {
    const facts = ggufFacts({
      'general.architecture': 'gemma4',
      'gemma4.block_count': 8,
      'gemma4.context_length': 131072,
      'gemma4.attention.head_count': 8,
      'gemma4.attention.head_count_kv': 2,
      'gemma4.attention.key_length': 512,
      'gemma4.attention.value_length': 512,
      'gemma4.attention.key_length_swa': 256,
      'gemma4.attention.value_length_swa': 256,
      'gemma4.attention.sliding_window': 512,
      'gemma4.attention.sliding_window_pattern': [true, true, true, false, true, true, true, false],
      'gemma4.attention.shared_kv_layers': 4,
    });
    // Layers 0–3 keep caches: three sliding-window, one full.
    expect(facts.kvPerToken).toBe(2 * 1024);
    expect(facts.swaKvPerToken).toBe(3 * 2 * 512);
    expect(facts.slidingWindow).toBe(512);
  });

  it('knows the sliding-window pattern llama.cpp hardcodes for gpt-oss', () => {
    const facts = ggufFacts({
      'general.architecture': 'gpt-oss',
      'gpt-oss.block_count': 4,
      'gpt-oss.context_length': 131072,
      'gpt-oss.attention.head_count': 64,
      'gpt-oss.attention.head_count_kv': 8,
      'gpt-oss.attention.key_length': 64,
      'gpt-oss.attention.value_length': 64,
      'gpt-oss.attention.sliding_window': 128,
    });
    expect(facts.kvPerToken).toBe(2 * 8 * 128);
    expect(facts.swaKvPerToken).toBe(2 * 8 * 128);
  });
});

describe('capabilitiesFromTemplate', () => {
  it('reads tools and reasoning from the template, and vision from the projector', () => {
    expect(capabilitiesFromTemplate('{% if tools %}…<think>', true)).toEqual({
      tools: true,
      vision: true,
      reasoning: true,
    });
    expect(capabilitiesFromTemplate(null, false)).toEqual({
      tools: false,
      vision: false,
      reasoning: false,
    });
  });
});

describe('readGgufHeader', () => {
  const data = ggufFile(llamaMetadata(), 4096);

  it('reads a local file', async () => {
    const file = join(tempDir(), 'model.gguf');
    writeFileSync(file, data);
    const header = await readGgufHeader(file);
    expect(header.facts.architecture).toBe('llama');
    expect(header.name).toBe('Tiny Llama');
    expect(header.license).toBe('mit');
    expect(header.sizeLabel).toBe('15M');
    expect(header.chatTemplate).toContain('messages');
  });

  it('reads over HTTP with range requests and sends the given headers', async () => {
    const server = await startServer(serveFiles({ '/model.gguf': data }));
    const header = await readGgufHeader(`${server.url}/model.gguf`, {
      headers: { Authorization: 'Bearer hf_test' },
    });
    expect(header.facts.blockCount).toBe(6);
    expect(server.requests.every((r) => r.range && r.auth === 'Bearer hf_test')).toBe(true);
  });
});
