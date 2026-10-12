import { modelIdSchema } from '@clanks/core';
import { describe, expect, it } from 'vitest';
import {
  InvalidModelRefError,
  type RepoFile,
  huggingFaceModelId,
  parseModelRef,
  pickRepoFiles,
  quantOf,
} from './refs';

const file = (path: string, size = 100): RepoFile => ({ path, size, sha256: 'a'.repeat(64) });

describe('parseModelRef', () => {
  it.each([
    ['qwen3.5:9b', { kind: 'catalog', name: 'qwen3.5', tag: '9b' }],
    ['qwen3.5', { kind: 'catalog', name: 'qwen3.5', tag: null }],
    ['  Gemma4:E4B ', { kind: 'catalog', name: 'gemma4', tag: 'e4b' }],
    [
      'hf.co/unsloth/Qwen3.5-9B-GGUF:Q4_K_M',
      { kind: 'huggingface', repo: 'unsloth/Qwen3.5-9B-GGUF', quant: 'Q4_K_M' },
    ],
    [
      'hf.co/ggml-org/tiny-llamas',
      { kind: 'huggingface', repo: 'ggml-org/tiny-llamas', quant: null },
    ],
    [
      'huggingface.co/bartowski/Some.Model-GGUF:iq4_xs',
      { kind: 'huggingface', repo: 'bartowski/Some.Model-GGUF', quant: 'iq4_xs' },
    ],
    [
      'https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/tree/main',
      { kind: 'huggingface', repo: 'ggml-org/gpt-oss-20b-GGUF', quant: null },
    ],
  ])('parses %s', (ref, expected) => {
    expect(parseModelRef(ref)).toEqual(expected);
  });

  it.each(['', 'two words', 'hf.co/only-owner', 'hf.co/a/b:bad quant', '../etc', 'qwen:9b:extra'])(
    'rejects %j',
    (ref) => {
      expect(() => parseModelRef(ref)).toThrow(InvalidModelRefError);
    },
  );

  it('makes ids that pass the model id schema', () => {
    expect(modelIdSchema.parse(huggingFaceModelId('unsloth/Qwen3.5-9B-GGUF', 'UD-Q4_K_XL'))).toBe(
      'hf.co/unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL',
    );
  });
});

describe('quantOf', () => {
  it.each([
    ['Qwen3.5-0.8B-Q4_0.gguf', 'Q4_0'],
    ['gpt-oss-20b-MXFP4.gguf', 'MXFP4'],
    ['Qwen3.5-4B-UD-Q4_K_XL.gguf', 'UD-Q4_K_XL'],
    ['llama-2-7b.Q4_K_M.gguf', 'Q4_K_M'],
    ['stories15M-q4_0.gguf', 'Q4_0'],
    ['Q8_0/Big-Model-Q8_0-00002-of-00003.gguf', 'Q8_0'],
    ['stories15M.gguf', null],
  ])('%s → %s', (path, quant) => {
    expect(quantOf(path)).toBe(quant);
  });
});

describe('pickRepoFiles', () => {
  const repo = [
    file('README.md'),
    file('Model-Q8_0.gguf'),
    file('Model-Q4_K_M.gguf'),
    file('Model-BF16.gguf'),
    file('mmproj-Model-F32.gguf'),
    file('mmproj-Model-Q8_0.gguf'),
    file('mtp-Model-Q4_0.gguf'),
    file('dflash-Model-Q8_0.gguf'),
  ];

  it('defaults to Q4_K_M and takes the best projector', () => {
    const picked = pickRepoFiles(repo, null)!;
    expect(picked.quant).toBe('Q4_K_M');
    expect(picked.model.map((f) => f.path)).toEqual(['Model-Q4_K_M.gguf']);
    expect(picked.projector?.path).toBe('mmproj-Model-Q8_0.gguf');
  });

  it('picks the asked-for quant, whatever its case', () => {
    expect(pickRepoFiles(repo, 'q8_0')!.model.map((f) => f.path)).toEqual(['Model-Q8_0.gguf']);
  });

  it('never offers draft, MTP or projector files as the model', () => {
    expect(pickRepoFiles(repo, 'Q8_0')!.available).toEqual(['BF16', 'Q4_K_M', 'Q8_0']);
  });

  it('reports what is available when the quant is missing', () => {
    const picked = pickRepoFiles(repo, 'Q2_K')!;
    expect(picked.model).toEqual([]);
    expect(picked.available).toContain('Q4_K_M');
  });

  it('returns every shard of a split model, in order', () => {
    const split = [
      file('Big-Q4_K_M-00002-of-00003.gguf'),
      file('Big-Q4_K_M-00001-of-00003.gguf'),
      file('Big-Q4_K_M-00003-of-00003.gguf'),
    ];
    expect(pickRepoFiles(split, null)!.model.map((f) => f.path)).toEqual([
      'Big-Q4_K_M-00001-of-00003.gguf',
      'Big-Q4_K_M-00002-of-00003.gguf',
      'Big-Q4_K_M-00003-of-00003.gguf',
    ]);
  });

  it('refuses a split model with a shard missing', () => {
    const split = [file('Big-Q4_0-00001-of-00002.gguf')];
    expect(pickRepoFiles(split, null)!.model).toEqual([]);
  });

  it('offers files without a quant in their name under their own name', () => {
    const tiny = [file('stories15M.gguf'), file('stories15M-q4_0.gguf'), file('stories260K.gguf')];
    expect(pickRepoFiles(tiny, null)!.quant).toBe('Q4_0');
    expect(pickRepoFiles(tiny, 'stories260k')!.model.map((f) => f.path)).toEqual([
      'stories260K.gguf',
    ]);
  });

  it('returns null for a repo without GGUF weights', () => {
    expect(pickRepoFiles([file('model.safetensors'), file('mmproj-x-F16.gguf')], null)).toBeNull();
  });
});
