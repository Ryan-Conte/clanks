import type { RuntimeBackend } from '@clanks/core';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chunksDone, downloadFile, planChunks } from '../download';
import { sha256File } from '../hash';
import manifest from './llama-cpp.json';

export interface RuntimeAsset {
  platform: string;
  arch: string;
  backend: RuntimeBackend;
  /** Shipped inside the app. The rest are downloaded on demand, such as CUDA. */
  bundled: boolean;
  files: { name: string; size: number; sha256: string }[];
}

/** The pinned llama.cpp release: the only builds clanks runs, each checked by sha256. */
export const llamaCpp = manifest as {
  release: string;
  build: string;
  baseUrl: string;
  assets: RuntimeAsset[];
};

/** A llama.cpp build on disk and how to start its server. */
export interface RuntimeBuild {
  backend: RuntimeBackend;
  source: 'bundled' | 'downloaded';
  dir: string;
  command: string;
  /** Arguments before llama-server's own, for running a stand-in in tests. */
  args: string[];
}

export function serverBinary(platform: string = process.platform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

export function assetsFor(platform: string, arch: string): RuntimeAsset[] {
  return llamaCpp.assets.filter((a) => a.platform === platform && a.arch === arch);
}

const MARKER = '.clanks-build.json';

interface Marker {
  build: string;
  backend: RuntimeBackend;
  sha256: string[];
}

/** Where a build of the pinned release lives once downloaded or fetched. */
export function buildDir(root: string, backend: RuntimeBackend): string {
  return join(root, backend);
}

/** Whether `dir` holds exactly this asset of the pinned release. */
export function isInstalled(dir: string, asset: RuntimeAsset): boolean {
  if (!existsSync(join(dir, serverBinary(asset.platform)))) return false;
  try {
    const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as Marker;
    return (
      marker.build === llamaCpp.build &&
      marker.backend === asset.backend &&
      asset.files.every((f) => marker.sha256.includes(f.sha256))
    );
  } catch {
    return false;
  }
}

/**
 * The builds this machine can run: those bundled with the app, then any downloaded into the
 * runtime folder. Bundled builds come from `scripts/fetch-llama.ts` at build time.
 */
export function findBuilds(options: {
  bundledDir: string | undefined;
  runtimeDir: string;
  platform?: string;
  arch?: string;
}): RuntimeBuild[] {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const builds: RuntimeBuild[] = [];
  for (const asset of assetsFor(platform, arch)) {
    const root = asset.bundled ? options.bundledDir : join(options.runtimeDir, llamaCpp.build);
    if (!root) continue;
    const dir = buildDir(root, asset.backend);
    if (!isInstalled(dir, asset)) continue;
    builds.push({
      backend: asset.backend,
      source: asset.bundled ? 'bundled' : 'downloaded',
      dir,
      command: join(dir, serverBinary(platform)),
      args: [],
    });
  }
  return builds;
}

export interface InstallOptions {
  asset: RuntimeAsset;
  /** The folder to install into. Replaced only once the new build is complete. */
  dest: string;
  /** Where archives are downloaded and kept until installed. */
  downloadsDir: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
  /** Replace symlinks with copies, so packaging tools don't have to handle them. */
  dereference?: boolean;
  /** Where the release's files are. Tests serve their own. */
  baseUrl?: string;
  onProgress?: (
    state: 'downloading' | 'verifying' | 'extracting',
    done: number,
    total: number,
  ) => void;
}

/** Downloads, verifies and unpacks one llama.cpp build. */
export async function installBuild(options: InstallOptions): Promise<void> {
  const { asset, signal } = options;
  const total = asset.files.reduce((sum, f) => sum + f.size, 0);
  await mkdir(options.downloadsDir, { recursive: true });

  let done = 0;
  const archives: string[] = [];
  for (const file of asset.files) {
    const archive = join(options.downloadsDir, file.name);
    archives.push(archive);
    if (existsSync(archive) && (await stat(archive)).size === file.size) {
      done += file.size;
      options.onProgress?.('downloading', done, total);
      continue;
    }
    const partial = `${archive}.partial`;
    await rm(partial, { force: true });
    const chunks = planChunks(file.size, 8 * 1024 ** 2);
    const before = done;
    await downloadFile({
      url: `${options.baseUrl ?? llamaCpp.baseUrl}/${file.name}`,
      size: file.size,
      file: partial,
      chunks,
      signal,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      onProgress: () => options.onProgress?.('downloading', before + chunksDone(chunks), total),
    });
    done = before + file.size;
    options.onProgress?.('verifying', done, total);
    const digest = await sha256File(partial, { signal });
    if (digest !== file.sha256) {
      await rm(partial, { force: true });
      throw new Error(`${file.name} didn't match its checksum, so it was thrown away. Try again.`);
    }
    await rename(partial, archive);
  }

  options.onProgress?.('extracting', total, total);
  const staging = `${options.dest}.installing`;
  await rm(staging, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(staging, { recursive: true });
  for (const [index, archive] of archives.entries()) {
    const unpacked = join(staging, `.unpack-${index}`);
    await mkdir(unpacked, { recursive: true });
    await extract(archive, unpacked);
    await mergeInto(await contentRoot(unpacked, asset.platform), staging);
    await rm(unpacked, { recursive: true, force: true, maxRetries: 3 });
  }
  await prune(staging, asset.platform);
  if (options.dereference) await dereferenceLinks(staging);
  if (!existsSync(join(staging, serverBinary(asset.platform)))) {
    throw new Error(`The ${asset.backend} build has no ${serverBinary(asset.platform)}`);
  }
  const marker: Marker = {
    build: llamaCpp.build,
    backend: asset.backend,
    sha256: asset.files.map((f) => f.sha256),
  };
  await writeFile(join(staging, MARKER), JSON.stringify(marker, null, 2) + '\n');

  await rm(options.dest, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(dirname(options.dest), { recursive: true });
  await rename(staging, options.dest);
  for (const archive of archives) await rm(archive, { force: true });
}

/** The system tar: bsdtar on Windows and macOS reads zip too; Linux builds come as tar.gz. */
function tarCommand(): string {
  if (process.platform === 'win32') {
    return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  }
  return 'tar';
}

function extract(archive: string, into: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(tarCommand(), ['-xf', archive, '-C', into], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`Couldn't unpack ${archive}: ${stderr.trim() || `tar exited ${code}`}`)),
    );
  });
}

/** The folder inside an unpacked archive that holds its files: archives may wrap them in one. */
async function contentRoot(dir: string, platform: string): Promise<string> {
  const found = await findFile(dir, serverBinary(platform));
  if (found) return dirname(found);
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.length === 1 && entries[0]!.isDirectory() ? join(dir, entries[0]!.name) : dir;
}

async function findFile(dir: string, name: string, depth = 0): Promise<string | null> {
  if (depth > 3) return null;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function mergeInto(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from)) {
    if (entry.startsWith('.unpack-')) continue;
    await rm(join(to, entry), { recursive: true, force: true });
    await rename(join(from, entry), join(to, entry));
  }
}

/**
 * Keeps the server and the libraries it loads. The release also ships a dozen other tools, each
 * with its own `-impl` library, that clanks never runs.
 */
async function prune(dir: string, platform: string): Promise<void> {
  const server = serverBinary(platform);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (entry.isDirectory()) {
      await rm(join(dir, name), { recursive: true, force: true });
      continue;
    }
    const library = /\.(dll|dylib)$|\.so(\.\d+)*$/.test(name);
    const keep =
      name === server ||
      /^LICENSE/i.test(name) ||
      (library && (!/-impl\./.test(name) || /server-impl\./.test(name)));
    if (!keep) await rm(join(dir, name), { force: true });
  }
}

async function dereferenceLinks(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if (!(await lstat(path)).isSymbolicLink()) continue;
    const target = resolve(dir, await readlink(path));
    await unlink(path);
    await copyFile(target, path);
  }
}
