import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import type { RuntimeBuild } from '../runtime/builds';

/** A fresh temporary folder, removed after the current test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clanks-models-'));
  onTestFinished(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows can hold a file a moment after a child process exits. Don't mask the test result.
    }
  });
  return dir;
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Deterministic bytes that differ along their length, so misplaced ranges show up. */
export function bytes(size: number, seed = 1): Buffer {
  const out = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >>> 16;
  }
  return out;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;

export interface TestServer {
  url: string;
  /** Requests by path, for asserting what was fetched. */
  requests: { method: string; path: string; range: string | undefined; auth: string | undefined }[];
  close(): Promise<void>;
}

/** An HTTP server for tests, closed after the current test. Handlers run in order. */
export async function startServer(...handlers: Handler[]): Promise<TestServer> {
  const requests: TestServer['requests'] = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      range: req.headers.range,
      auth: req.headers.authorization,
    });
    void (async () => {
      for (const handler of handlers) {
        if (await handler(req, res)) return;
      }
      res.writeHead(404).end('not found');
    })().catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  onTestFinished(close);
  return { url: `http://127.0.0.1:${port}`, requests, close };
}

export interface FileOptions {
  /** Drop the connection after this many bytes, for this many requests. */
  dropAfter?: { bytes: number; times: number };
  /** Ignore Range and always send the whole file. */
  noRanges?: boolean;
  /** Pause between pieces, so a test can act mid-download. */
  delayMs?: number;
}

/** Serves files at fixed paths, honouring single byte ranges like a CDN. */
export function serveFiles(files: Record<string, Buffer>, options: FileOptions = {}): Handler {
  let drops = options.dropAfter?.times ?? 0;
  return async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const data = files[path];
    if (!data) return false;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = data.length - 1;
    if (range && !options.noRanges) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${data.length}`,
        'content-length': end - start + 1,
        'accept-ranges': 'bytes',
      });
    } else {
      res.writeHead(200, { 'content-length': data.length, 'accept-ranges': 'bytes' });
    }
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    const body = data.subarray(start, end + 1);
    if (drops > 0 && options.dropAfter && body.length > options.dropAfter.bytes) {
      drops--;
      res.write(body.subarray(0, options.dropAfter.bytes));
      await new Promise((resolve) => setTimeout(resolve, 20));
      res.destroy();
      return true;
    }
    const piece = 64 * 1024;
    for (let offset = 0; offset < body.length; offset += piece) {
      if (res.destroyed) return true;
      res.write(body.subarray(offset, offset + piece));
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    res.end();
    return true;
  };
}

export interface FakeRepo {
  repo: string;
  revision: string;
  license?: string;
  files: Record<string, Buffer>;
}

/**
 * Just enough of Hugging Face: repo info, the file tree with LFS checksums, and resolve URLs that
 * redirect to a CDN path, as the real thing does.
 */
export function fakeHuggingFace(repos: FakeRepo[], options: FileOptions = {}): Handler {
  const cdn: Record<string, Buffer> = {};
  for (const repo of repos) {
    for (const data of Object.values(repo.files)) cdn[`/cdn/${sha256(data)}`] = data;
  }
  const files = serveFiles(cdn, options);
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    for (const repo of repos) {
      if (url.pathname === `/api/models/${repo.repo}`) {
        json(res, { sha: repo.revision, cardData: repo.license ? { license: repo.license } : {} });
        return true;
      }
      if (url.pathname === `/api/models/${repo.repo}/tree/${repo.revision}`) {
        json(
          res,
          Object.entries(repo.files).map(([path, data]) => ({
            type: 'file',
            path,
            size: data.length,
            lfs: { oid: sha256(data), size: data.length },
          })),
        );
        return true;
      }
      const prefix = `/${repo.repo}/resolve/${repo.revision}/`;
      if (url.pathname.startsWith(prefix)) {
        const data = repo.files[decodeURIComponent(url.pathname.slice(prefix.length))];
        if (!data) return false;
        res.writeHead(302, { location: `/cdn/${sha256(data)}` }).end();
        return true;
      }
    }
    return files(req, res);
  };
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

type GgufValue = string | number | boolean | number[] | boolean[] | { u64: bigint };

/**
 * A minimal GGUF v3 file: the header, the given metadata and no tensors, padded with `extra`
 * bytes so it looks like a model on disk.
 */
export function ggufFile(metadata: Record<string, GgufValue>, extra = 0): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
  };
  const str = (s: string) => Buffer.concat([u64(BigInt(Buffer.byteLength(s))), Buffer.from(s)]);
  // GGUF value types: 4 uint32, 6 float32, 7 bool, 8 string, 9 array, 10 uint64.
  const value = (v: GgufValue): [number, Buffer] => {
    if (typeof v === 'string') return [8, str(v)];
    if (typeof v === 'boolean') return [7, Buffer.from([v ? 1 : 0])];
    if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= 0) return [4, u32(v)];
      const b = Buffer.alloc(4);
      b.writeFloatLE(v);
      return [6, b];
    }
    if (Array.isArray(v)) {
      const items = (v as (number | boolean)[]).map((item) => value(item));
      const type = items[0]?.[0] ?? 4;
      return [9, Buffer.concat([u32(type), u64(BigInt(items.length)), ...items.map((i) => i[1])])];
    }
    return [10, u64(v.u64)];
  };
  parts.push(Buffer.from('GGUF'), u32(3), u64(0n), u64(BigInt(Object.keys(metadata).length)));
  for (const [key, v] of Object.entries(metadata)) {
    const [type, data] = value(v);
    parts.push(str(key), u32(type), data);
  }
  const header = Buffer.concat(parts);
  const padded = Buffer.alloc(Math.ceil(header.length / 32) * 32 + extra);
  header.copy(padded);
  return padded;
}

/** Metadata for a small llama-style model. */
export function llamaMetadata(
  overrides: Record<string, GgufValue> = {},
): Record<string, GgufValue> {
  return {
    'general.architecture': 'llama',
    'general.name': 'Tiny Llama',
    'general.size_label': '15M',
    'general.license': 'mit',
    'llama.block_count': 6,
    'llama.context_length': 4096,
    'llama.embedding_length': 288,
    'llama.attention.head_count': 6,
    'llama.attention.head_count_kv': 6,
    'tokenizer.chat_template': "{% for message in messages %}{{ message['content'] }}{% endfor %}",
    ...overrides,
  };
}

/** The stand-in for llama-server that supervisor and manager tests run under Node. */
export const fakeServerScript = fileURLToPath(new URL('./fake-llama-server.mjs', import.meta.url));

export interface FakeServerConfig {
  devices?: string;
  failLoad?: boolean;
  loadMs?: number;
  placement?: 'gpu' | 'partial' | 'cpu';
  argsFile?: string;
}

/** A "build" that runs the stand-in server, configured through a file it reads at each launch. */
export function fakeBuild(dir: string, config: FakeServerConfig = {}) {
  const configFile = join(dir, 'fake-server.json');
  const configure = (next: FakeServerConfig) => writeFileSync(configFile, JSON.stringify(next));
  configure(config);
  const build: RuntimeBuild = {
    backend: 'cuda',
    source: 'bundled',
    dir,
    command: process.execPath,
    args: [fakeServerScript, '--fake-config', configFile],
  };
  return { build, configure };
}
