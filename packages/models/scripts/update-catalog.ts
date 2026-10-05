/**
 * Fills in the catalog from Hugging Face: each repo's revision, every file's sha256 and size, and
 * the facts the memory estimate needs from the GGUF header. Hand-written fields (names, titles,
 * summaries, tags, which files) are kept.
 *
 *   pnpm --filter @clanks/models catalog:update            fill in new entries only
 *   pnpm --filter @clanks/models catalog:update --refresh  move every entry to its repo's latest commit
 */
import { catalogSchema } from '@clanks/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { capabilitiesFromTemplate, readGgufHeader } from '../src/gguf';
import { HuggingFaceClient } from '../src/huggingface';

interface DraftEntry {
  name: string;
  tag: string;
  repo: string;
  revision?: string;
  license?: string;
  files: { role: 'model' | 'projector'; path: string; sha256?: string; size?: number }[];
  [key: string]: unknown;
}

const file = fileURLToPath(new URL('../src/catalog.json', import.meta.url));
const refresh = process.argv.includes('--refresh');
const hf = new HuggingFaceClient({ token: () => process.env.HF_TOKEN });

const draft = JSON.parse(readFileSync(file, 'utf8')) as { version: 1; models: DraftEntry[] };

for (const entry of draft.models) {
  const id = `${entry.name}:${entry.tag}`;
  const complete = entry.revision && entry.files.every((f) => f.sha256 && f.size) && entry.facts;
  if (complete && !refresh) continue;

  const info = await hf.repoInfo(entry.repo);
  const revision = refresh || !entry.revision ? info.revision : entry.revision;
  const tree = await hf.listFiles(entry.repo, revision);
  const files = entry.files.map((f) => {
    const found = tree.find((t) => t.path === f.path);
    if (!found?.sha256) throw new Error(`${id}: ${entry.repo} has no LFS file ${f.path}`);
    return { role: f.role, path: f.path, sha256: found.sha256, size: found.size };
  });
  const weights = files.find((f) => f.role === 'model')!;
  const header = await readGgufHeader(hf.fileUrl(entry.repo, revision, weights.path));

  Object.assign(entry, {
    revision,
    license: entry.license ?? info.license ?? header.license ?? 'unknown',
    capabilities: capabilitiesFromTemplate(
      header.chatTemplate,
      files.some((f) => f.role === 'projector'),
    ),
    files,
    facts: header.facts,
  });
  console.log(
    `${id}: ${revision.slice(0, 7)}, ${(files.reduce((s, f) => s + f.size, 0) / 2 ** 30).toFixed(2)} GiB`,
  );
}

// Key order matches the schema, so diffs stay readable.
const ordered = catalogSchema.parse(draft);
const config = await resolveConfig(file);
writeFileSync(file, await format(JSON.stringify(ordered), { ...config, filepath: file }));
console.log(`Wrote ${ordered.models.length} models to ${file}`);
