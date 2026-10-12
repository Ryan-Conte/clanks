import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DownloadError, chunksDone, downloadFile, planChunks } from './download';
import { sha256File } from './hash';
import { bytes, serveFiles, sha256, startServer, tempDir } from './test/fixtures';

const KB = 1024;
const fast = () => 1;

describe('planChunks', () => {
  it('covers the file exactly', () => {
    const chunks = planChunks(100, 30);
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 30],
      [30, 60],
      [60, 90],
      [90, 100],
    ]);
    expect(planChunks(0)).toEqual([]);
  });
});

describe('downloadFile', () => {
  const data = bytes(700 * KB);

  it('downloads in parallel ranges into place', async () => {
    const server = await startServer(serveFiles({ '/model.gguf': data }));
    const file = join(tempDir(), 'partial');
    const chunks = planChunks(data.length, 64 * KB);
    let progressed = 0;
    await downloadFile({
      url: `${server.url}/model.gguf`,
      size: data.length,
      file,
      chunks,
      connections: 4,
      signal: new AbortController().signal,
      onProgress: (n) => (progressed += n),
    });
    expect(sha256(readFileSync(file))).toBe(sha256(data));
    expect(progressed).toBe(data.length);
    expect(chunksDone(chunks)).toBe(data.length);
    expect(server.requests.filter((r) => r.method === 'GET')).toHaveLength(chunks.length);
  });

  it('follows a redirect once, and keeps the token to the original host', async () => {
    const cdn = await startServer(serveFiles({ '/blob': data }));
    const origin = await startServer((req, res) => {
      res.writeHead(302, { location: `${cdn.url}/blob` }).end();
      return true;
    });
    const file = join(tempDir(), 'partial');
    await downloadFile({
      url: `${origin.url}/resolve/model.gguf`,
      headers: { Authorization: 'Bearer hf_secret' },
      size: data.length,
      file,
      chunks: planChunks(data.length, 128 * KB),
      signal: new AbortController().signal,
    });
    expect(sha256(readFileSync(file))).toBe(sha256(data));
    expect(origin.requests).toHaveLength(1);
    expect(origin.requests[0]!.auth).toBe('Bearer hf_secret');
    expect(cdn.requests.every((r) => r.auth === undefined)).toBe(true);
  });

  it('retries a dropped connection from where it stopped', async () => {
    const server = await startServer(
      serveFiles({ '/model.gguf': data }, { dropAfter: { bytes: 10 * KB, times: 3 } }),
    );
    const file = join(tempDir(), 'partial');
    await downloadFile({
      url: `${server.url}/model.gguf`,
      size: data.length,
      file,
      chunks: planChunks(data.length, 256 * KB),
      connections: 1,
      signal: new AbortController().signal,
      retryDelayMs: fast,
    });
    expect(sha256(readFileSync(file))).toBe(sha256(data));
    // The retries asked only for what was still missing.
    const ranges = server.requests.filter((r) => r.method === 'GET').map((r) => r.range);
    expect(ranges[1]).toMatch(/^bytes=10240-/);
  });

  it('resumes from saved progress without fetching it again', async () => {
    const server = await startServer(serveFiles({ '/model.gguf': data }, { delayMs: 5 }));
    const file = join(tempDir(), 'partial');
    const chunks = planChunks(data.length, 64 * KB);
    const controller = new AbortController();
    let saved = chunks;
    const first = downloadFile({
      url: `${server.url}/model.gguf`,
      size: data.length,
      file,
      chunks,
      connections: 2,
      signal: controller.signal,
      onCheckpoint: (snapshot) => (saved = snapshot),
      onProgress: () => {
        if (chunksDone(chunks) > 200 * KB) controller.abort(new Error('paused'));
      },
    });
    await expect(first).rejects.toThrow('paused');
    const before = chunksDone(saved);
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(data.length);

    server.requests.length = 0;
    await downloadFile({
      url: `${server.url}/model.gguf`,
      size: data.length,
      file,
      chunks: saved,
      signal: new AbortController().signal,
    });
    expect(sha256(readFileSync(file))).toBe(sha256(data));
    const fetched = server.requests
      .filter((r) => r.method === 'GET')
      .map((r) => /bytes=(\d+)-(\d+)/.exec(r.range!)!)
      .reduce((sum, m) => sum + Number(m[2]) - Number(m[1]) + 1, 0);
    expect(fetched).toBe(data.length - before);
  });

  it('fails without retrying when the file is gone', async () => {
    const server = await startServer();
    const download = downloadFile({
      url: `${server.url}/missing.gguf`,
      size: 10,
      file: join(tempDir(), 'partial'),
      chunks: planChunks(10),
      signal: new AbortController().signal,
      retryDelayMs: fast,
    });
    await expect(download).rejects.toThrow(DownloadError);
    expect(server.requests).toHaveLength(1);
  });

  it("refuses a server that can't send ranges", async () => {
    const server = await startServer(serveFiles({ '/model.gguf': data }, { noRanges: true }));
    const download = downloadFile({
      url: `${server.url}/model.gguf`,
      size: data.length,
      file: join(tempDir(), 'partial'),
      chunks: planChunks(data.length, 64 * KB),
      signal: new AbortController().signal,
    });
    await expect(download).rejects.toThrow("doesn't support resuming");
  });
});

describe('sha256File', () => {
  it('hashes on a worker thread and reports progress', async () => {
    const data = bytes(200 * KB, 7);
    const file = join(tempDir(), 'blob');
    writeFileSync(file, data);
    let progress = 0;
    const digest = await sha256File(file, { onProgress: (n) => (progress = n) });
    expect(digest).toBe(createHash('sha256').update(data).digest('hex'));
    expect(progress).toBe(data.length);
  });

  it('rejects a missing file', async () => {
    await expect(sha256File(join(tempDir(), 'nope'))).rejects.toThrow();
  });
});
