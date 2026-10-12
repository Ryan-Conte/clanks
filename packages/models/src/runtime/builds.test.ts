import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serveFiles, sha256, startServer, tempDir } from '../test/fixtures';
import {
  type RuntimeAsset,
  assetsFor,
  findBuilds,
  installBuild,
  isInstalled,
  serverBinary,
} from './builds';

const tar =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
const server = serverBinary();
const lib = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';

/** Packs files (relative path → contents, or `-> target` for a symlink) into a .tar.gz. */
function archive(dir: string, name: string, files: Record<string, string>): Buffer {
  const root = join(dir, `src-${name}`);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    if (contents.startsWith('-> ')) symlinkSync(contents.slice(3), full);
    else writeFileSync(full, contents);
  }
  const out = join(dir, name);
  execFileSync(tar, ['-czf', out, '-C', root, '.']);
  return readFileSync(out);
}

function asset(files: { name: string; data: Buffer }[]): RuntimeAsset {
  return {
    platform: process.platform,
    arch: process.arch,
    backend: 'cuda',
    bundled: false,
    files: files.map((f) => ({ name: f.name, size: f.data.length, sha256: sha256(f.data) })),
  };
}

describe('installBuild', () => {
  it('downloads, checks, unpacks and trims a build', async () => {
    const dir = tempDir();
    const main = archive(dir, 'main.tar.gz', {
      [`llama-b1/${server}`]: 'server',
      [`llama-b1/llama-server-impl.${lib}`]: 'server impl',
      [`llama-b1/ggml-cuda.${lib}`]: 'cuda backend',
      [`llama-b1/llama-cli${process.platform === 'win32' ? '.exe' : ''}`]: 'a tool',
      [`llama-b1/llama-cli-impl.${lib}`]: 'its impl',
      'llama-b1/LICENSE': 'MIT',
    });
    const runtime = archive(dir, 'cudart.tar.gz', { [`cudart64_12.${lib}`]: 'cuda runtime' });
    const http = await startServer(serveFiles({ '/main.tar.gz': main, '/cudart.tar.gz': runtime }));
    const build = asset([
      { name: 'main.tar.gz', data: main },
      { name: 'cudart.tar.gz', data: runtime },
    ]);
    const dest = join(dir, 'runtime', 'cuda');
    const states = new Set<string>();

    await installBuild({
      asset: build,
      dest,
      downloadsDir: join(dir, 'downloads'),
      baseUrl: http.url,
      signal: new AbortController().signal,
      onProgress: (state) => states.add(state),
    });

    expect(readdirSync(dest).sort()).toEqual(
      [
        '.clanks-build.json',
        'LICENSE',
        `cudart64_12.${lib}`,
        `ggml-cuda.${lib}`,
        `llama-server-impl.${lib}`,
        server,
      ].sort(),
    );
    expect(isInstalled(dest, build)).toBe(true);
    expect([...states]).toEqual(['downloading', 'verifying', 'extracting']);
    expect(readdirSync(join(dir, 'downloads'))).toEqual([]);
  });

  it('refuses an archive that fails its checksum', async () => {
    const dir = tempDir();
    const main = archive(dir, 'main.tar.gz', { [server]: 'server' });
    const http = await startServer(serveFiles({ '/main.tar.gz': main }));
    const build = asset([{ name: 'main.tar.gz', data: Buffer.from('something else entirely') }]);
    build.files[0]!.size = main.length;
    const dest = join(dir, 'cuda');
    await expect(
      installBuild({
        asset: build,
        dest,
        downloadsDir: join(dir, 'downloads'),
        baseUrl: http.url,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/checksum/);
    expect(existsSync(dest)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('replaces symlinks with copies when asked', async () => {
    const dir = tempDir();
    const main = archive(dir, 'main.tar.gz', {
      [server]: 'server',
      [`libggml.0.1.${lib}`]: 'ggml',
      [`libggml.0.${lib}`]: `-> libggml.0.1.${lib}`,
    });
    const http = await startServer(serveFiles({ '/main.tar.gz': main }));
    const dest = join(dir, 'cpu');
    await installBuild({
      asset: asset([{ name: 'main.tar.gz', data: main }]),
      dest,
      downloadsDir: join(dir, 'downloads'),
      baseUrl: http.url,
      dereference: true,
      signal: new AbortController().signal,
    });
    const link = join(dest, `libggml.0.${lib}`);
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, 'utf8')).toBe('ggml');
  });
});

describe('findBuilds', () => {
  it('finds bundled and downloaded builds of the pinned release, and nothing else', () => {
    const root = tempDir();
    const [cpu, vulkan, cuda] = ['cpu', 'vulkan', 'cuda'].map((backend) =>
      assetsFor('linux', 'x64').find((a) => a.backend === backend)!,
    );
    const place = (dir: string, of: RuntimeAsset, marker = true) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'llama-server'), '');
      if (marker) {
        writeFileSync(
          join(dir, '.clanks-build.json'),
          JSON.stringify({
            build: 'b11146',
            backend: of.backend,
            sha256: of.files.map((f) => f.sha256),
          }),
        );
      }
    };
    place(join(root, 'bundled', 'cpu'), cpu!);
    place(join(root, 'bundled', 'vulkan'), vulkan!, false);
    place(join(root, 'runtime', 'b11146', 'cuda'), cuda!);

    const builds = findBuilds({
      bundledDir: join(root, 'bundled'),
      runtimeDir: join(root, 'runtime'),
      platform: 'linux',
      arch: 'x64',
    });
    expect(builds.map((b) => [b.backend, b.source])).toEqual([
      ['cpu', 'bundled'],
      ['cuda', 'downloaded'],
    ]);
    expect(builds[0]!.command).toBe(join(root, 'bundled', 'cpu', 'llama-server'));
  });
});
