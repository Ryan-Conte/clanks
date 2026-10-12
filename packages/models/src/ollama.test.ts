import { defaultSettings } from '@clanks/core';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ModelManager } from './manager';
import { ollamaModelDirs, ollamaModelId, scanOllama } from './ollama';
import { memoryRepository } from './store';
import { ggufFile, llamaMetadata, sha256, tempDir } from './test/fixtures';

const weights = ggufFile(llamaMetadata({ 'general.name': 'Llama 3.2 3B Instruct' }), 64 * 1024);
const projector = ggufFile({ 'general.architecture': 'clip' }, 1024);

/** An Ollama models folder, laid out as Ollama writes it. */
function ollamaFolder(): string {
  const dir = tempDir();
  const blob = (data: Buffer) => {
    const digest = sha256(data);
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    writeFileSync(join(dir, 'blobs', `sha256-${digest}`), data);
    return { digest: `sha256:${digest}`, size: data.length };
  };
  const manifest = (
    path: string,
    layers: { mediaType: string; digest: string; size: number }[],
  ) => {
    const file = join(dir, 'manifests', path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, layers }));
  };
  const model = { mediaType: 'application/vnd.ollama.image.model', ...blob(weights) };
  const template = {
    mediaType: 'application/vnd.ollama.image.template',
    ...blob(Buffer.from('{{ .Prompt }}')),
  };
  manifest('registry.ollama.ai/library/llama3.2/3b-instruct-q4_K_M', [model, template]);
  manifest('registry.ollama.ai/library/llava/7b', [
    model,
    { mediaType: 'application/vnd.ollama.image.projector', ...blob(projector) },
  ]);
  manifest('hf.co/Unsloth/Qwen3-GGUF/Q4_K_M', [model]);
  // Not a GGUF: skipped.
  manifest('registry.ollama.ai/library/safetensors-model/latest', [
    { mediaType: 'application/vnd.ollama.image.model', ...blob(Buffer.from('not a gguf at all')) },
  ]);
  // A manifest whose blob was deleted: skipped.
  manifest('registry.ollama.ai/library/gone/latest', [
    {
      mediaType: 'application/vnd.ollama.image.model',
      digest: `sha256:${'d'.repeat(64)}`,
      size: 10,
    },
  ]);
  return dir;
}

function manager(ollamaDir: string) {
  const repo = memoryRepository();
  const root = tempDir();
  const models = new ModelManager({
    runtimeDir: join(root, 'runtime'),
    logsDir: join(root, 'logs'),
    defaultModelsDir: join(root, 'models'),
    modelsDir: { get: () => null, set: () => {} },
    repo,
    settings: () => defaultSettings,
    builds: () => [],
    probe: () => Promise.reject(new Error('no probe in this test')),
    ollamaDirs: () => [join(root, 'no-ollama-here'), ollamaDir],
  });
  onTestFinished(() => models.close());
  return { models, repo, root };
}

describe('Ollama models', () => {
  it('looks where Ollama keeps them', () => {
    expect(ollamaModelDirs({ OLLAMA_MODELS: 'D:\\ollama' }, 'C:\\Users\\sam', 'win32')).toEqual([
      'D:\\ollama',
      join('C:\\Users\\sam', '.ollama', 'models'),
    ]);
    expect(ollamaModelDirs({}, '/home/sam', 'linux')).toContain('/usr/share/ollama/.ollama/models');
  });

  it('finds the GGUF models and names them as Ollama does', async () => {
    const found = await scanOllama(ollamaFolder());
    expect(found.map((m) => [m.name, m.id, m.projector !== null])).toEqual([
      ['hf.co/Unsloth/Qwen3-GGUF:Q4_K_M', 'ollama/unsloth/qwen3-gguf:Q4_K_M', false],
      ['llama3.2:3b-instruct-q4_K_M', 'ollama/llama3.2:3b-instruct-q4_K_M', false],
      ['llava:7b', 'ollama/llava:7b', true],
    ]);
    expect(found.find((m) => m.name === 'llava:7b')!.size).toBe(weights.length + projector.length);
  });

  it('gives ids that clanks accepts', () => {
    expect(
      ollamaModelId({
        host: 'registry.ollama.ai',
        namespace: 'Some User',
        model: 'My_Model',
        tag: 'v1',
      }),
    ).toBe('ollama/some-user/my_model:v1');
  });

  it('imports one by linking its file, checked by sha256, and lists it as imported', async () => {
    const dir = ollamaFolder();
    const { models, repo, root } = manager(dir);
    const listing = await models.ollama();
    expect(listing?.dir).toBe(dir);
    expect(listing?.models.find((m) => m.name === 'llava:7b')).toMatchObject({
      id: 'ollama/llava:7b',
      vision: true,
      imported: false,
    });

    const record = await models.importOllama('llava:7b');
    expect(record).toMatchObject({
      id: 'ollama/llava:7b',
      source: 'ollama',
      title: 'Llama 3.2 3B Instruct',
      repo: 'llava:7b',
      quant: null,
      params: '15M',
      license: 'mit',
      capabilities: { vision: true },
      size: weights.length + projector.length,
      keepLoaded: false,
    });
    expect(record.facts).toMatchObject({ architecture: 'llama', contextLength: 4096 });
    expect(repo.getModel('ollama/llava:7b')).toBeDefined();
    const stored = join(root, 'models', 'blobs', `sha256-${sha256(weights)}`);
    expect(statSync(stored).size).toBe(weights.length);
    expect(models.imports()).toEqual([]);
    expect(models.library()[0]).toMatchObject({ id: 'ollama/llava:7b', missing: false });
    expect((await models.ollama())?.models.find((m) => m.name === 'llava:7b')?.imported).toBe(true);

    // The second shares the weights already in the store.
    expect((await models.importOllama('llama3.2:3b-instruct-q4_K_M')).quant).toBe('Q4_K_M');
    await expect(models.importOllama('llava:7b')).rejects.toThrow(/already in clanks/);
    await expect(models.importOllama('mistral:7b')).rejects.toThrow(/Ollama has no model called/);
  });

  it("refuses a file that doesn't match its checksum", async () => {
    const dir = ollamaFolder();
    // Corrupt the weights after Ollama wrote them.
    writeFileSync(
      join(dir, 'blobs', `sha256-${sha256(weights)}`),
      ggufFile(llamaMetadata(), 64 * 1024 + 1),
    );
    const { models, repo } = manager(dir);
    await expect(models.importOllama('llama3.2:3b-instruct-q4_K_M')).rejects.toThrow(
      /doesn't match its checksum/,
    );
    expect(repo.listModels()).toEqual([]);
    expect(models.imports()).toMatchObject([
      { name: 'llama3.2:3b-instruct-q4_K_M', state: 'failed' },
    ]);
    models.dismissImport('llama3.2:3b-instruct-q4_K_M');
    expect(models.imports()).toEqual([]);
  });

  it('reports no Ollama when there is none', async () => {
    const { models } = manager(join(tempDir(), 'empty'));
    expect(await models.ollama()).toBeNull();
  });
});
