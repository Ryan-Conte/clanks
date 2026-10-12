/**
 * Fetches the pinned llama.cpp builds that ship inside the app, checks each against its sha256,
 * and unpacks them to apps/desktop/resources/llama/<backend>. Builds already in place are kept.
 *
 *   pnpm fetch-llama                      the bundled builds for this platform
 *   pnpm fetch-llama --backend cpu        just one
 *   pnpm fetch-llama --platform linux --arch x64 --out <dir>
 */
import type { RuntimeBackend } from '@clanks/core';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assetsFor, buildDir, installBuild, isInstalled, llamaCpp } from '../src/runtime/builds';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: join(repoRoot, 'apps', 'desktop', 'resources', 'llama') },
    backend: { type: 'string', multiple: true },
    platform: { type: 'string', default: process.platform },
    arch: { type: 'string', default: process.arch },
  },
});

const out = resolve(values.out);
const assets = assetsFor(values.platform, values.arch).filter((a) =>
  values.backend ? values.backend.includes(a.backend) : a.bundled,
);
if (assets.length === 0) {
  console.error(`No llama.cpp ${llamaCpp.build} builds for ${values.platform}-${values.arch}`);
  process.exit(1);
}

// Builds that shouldn't ship any more, such as another release's, go.
if (!values.backend && existsSync(out)) {
  const wanted = new Set<RuntimeBackend>(assets.map((a) => a.backend));
  for (const entry of await readdir(out)) {
    if (!wanted.has(entry as RuntimeBackend))
      await rm(join(out, entry), { recursive: true, force: true });
  }
}

for (const asset of assets) {
  const dest = buildDir(out, asset.backend);
  if (isInstalled(dest, asset)) {
    console.log(`${asset.backend}: llama.cpp ${llamaCpp.build} already in place`);
    continue;
  }
  const size = asset.files.reduce((sum, f) => sum + f.size, 0);
  console.log(
    `${asset.backend}: fetching llama.cpp ${llamaCpp.build} (${(size / 1024 ** 2).toFixed(0)} MB)`,
  );
  await installBuild({
    asset,
    dest,
    downloadsDir: join(out, '.downloads'),
    signal: new AbortController().signal,
    dereference: true,
  });
}
await rm(join(out, '.downloads'), { recursive: true, force: true });
console.log(`llama.cpp ${llamaCpp.build} is in ${out}`);
