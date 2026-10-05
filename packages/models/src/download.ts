import { type FileHandle, open } from 'node:fs/promises';
import { ModelsError } from './errors';

export const MIB = 1024 ** 2;

/** One byte range of a file being downloaded. `done` bytes from `start` are on disk. */
export interface ChunkProgress {
  start: number;
  /** Exclusive. */
  end: number;
  done: number;
}

export function planChunks(size: number, chunkSize = 32 * MIB): ChunkProgress[] {
  const chunks: ChunkProgress[] = [];
  for (let start = 0; start < size; start += chunkSize) {
    chunks.push({ start, end: Math.min(size, start + chunkSize), done: 0 });
  }
  return chunks;
}

export function chunksDone(chunks: ChunkProgress[]): number {
  return chunks.reduce((sum, c) => sum + c.done, 0);
}

export class DownloadError extends ModelsError {
  constructor(
    message: string,
    /** Worth retrying later, such as a dropped connection, rather than a missing file. */
    readonly transient: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface DownloadOptions {
  /** May redirect, as Hugging Face's resolve URLs do to their CDN. */
  url: string;
  /** Sent only to the URL's own host, never to where it redirects. */
  headers?: Record<string, string>;
  size: number;
  /** The partial file, written in place. */
  file: string;
  /** Updated as bytes land, so a later call picks up where this one stopped. */
  chunks: ChunkProgress[];
  connections?: number;
  signal: AbortSignal;
  fetch?: typeof fetch;
  /** Bytes written since the last call. */
  onProgress?: (bytes: number) => void;
  /** Progress that is safely on disk, to persist for resuming after a restart. */
  onCheckpoint?: (chunks: ChunkProgress[]) => void;
  checkpointMs?: number;
  /** Backoff before retrying a failed range. Tests shorten it. */
  retryDelayMs?: (attempt: number) => number;
}

const MAX_ATTEMPTS = 6;
const WRITE_BUFFER = 1 * MIB;

/**
 * Downloads a file in parallel byte ranges straight into place. Resumes from `chunks`, retries
 * dropped ranges with backoff, and re-resolves a redirect whose signed URL has expired.
 * Verifying the content is the caller's job.
 */
export async function downloadFile(options: DownloadOptions): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const connections = Math.max(1, options.connections ?? 6);
  const retryDelay = options.retryDelayMs ?? ((attempt) => Math.min(30_000, 1000 * 2 ** attempt));
  const { chunks, size, signal } = options;

  if (chunks.length > 0 && chunks.at(-1)!.end !== size) {
    throw new DownloadError('The download plan does not match the file size', false);
  }

  // Positional writes need a file opened without O_APPEND, so create it first if it's new.
  await (await open(options.file, 'a')).close();
  const handle = await open(options.file, 'r+');

  const internal = new AbortController();
  const onAbort = () => internal.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) internal.abort(signal.reason);

  let resolved: Promise<string> | undefined;
  const resolve = (force = false) => {
    if (force || !resolved)
      resolved = resolveUrl(doFetch, options.url, options.headers, internal.signal);
    return resolved;
  };

  const checkpoint = async () => {
    const snapshot = chunks.map((c) => ({ ...c }));
    await handle.datasync();
    options.onCheckpoint?.(snapshot);
  };
  const timer = setInterval(() => void checkpoint().catch(() => {}), options.checkpointMs ?? 2000);

  const queue = chunks.filter((c) => c.done < c.end - c.start);
  let firstError: unknown;

  const worker = async () => {
    for (;;) {
      if (internal.signal.aborted) return;
      const chunk = queue.shift();
      if (!chunk) return;
      try {
        await fetchChunk(chunk);
      } catch (error) {
        firstError ??= error;
        internal.abort(error);
        return;
      }
    }
  };

  async function fetchChunk(chunk: ChunkProgress): Promise<void> {
    let attempt = 0;
    while (chunk.done < chunk.end - chunk.start) {
      const before = chunk.done;
      try {
        await fetchRange(chunk);
      } catch (error) {
        if (internal.signal.aborted) throw internal.signal.reason ?? error;
        if (isDiskFull(error))
          throw new DownloadError('The drive is full', false, { cause: error });
        if (error instanceof DownloadError && !error.transient) throw error;
        // Progress resets the count: only a range that keeps failing gives up.
        attempt = chunk.done > before ? 0 : attempt + 1;
        if (attempt >= MAX_ATTEMPTS) {
          throw error instanceof DownloadError
            ? error
            : new DownloadError(`The download keeps failing: ${describe(error)}`, true, {
                cause: error,
              });
        }
        if (error instanceof ExpiredUrlError) void resolve(true);
        await sleep(retryDelay(attempt - 1), internal.signal);
      }
    }
  }

  async function fetchRange(chunk: ChunkProgress): Promise<void> {
    const url = await resolve();
    const from = chunk.start + chunk.done;
    const response = await doFetch(url, {
      headers: {
        ...hostHeaders(url, options.url, options.headers),
        Range: `bytes=${from}-${chunk.end - 1}`,
      },
      signal: internal.signal,
    });
    if (response.status === 200 && (from !== 0 || chunk.end !== size)) {
      await response.body?.cancel();
      throw new DownloadError("The server doesn't support resuming downloads", false);
    }
    if (response.status !== 206 && response.status !== 200) {
      await response.body?.cancel();
      throw statusError(response.status, url !== options.url);
    }
    if (!response.body) throw new DownloadError('The server sent no data', true);

    let position = from;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (pendingBytes === 0) return;
      const data = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      await writeAll(handle, data, position);
      position += data.length;
      chunk.done += data.length;
      options.onProgress?.(data.length);
    };
    try {
      for await (const piece of response.body as AsyncIterable<Uint8Array>) {
        if (position + pendingBytes + piece.length > chunk.end) {
          throw new DownloadError('The server sent more data than asked for', false);
        }
        pending.push(Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength));
        pendingBytes += piece.length;
        if (pendingBytes >= WRITE_BUFFER) await flush();
      }
    } finally {
      // Keep whatever arrived before a dropped connection.
      await flush().catch(() => {});
    }
    if (position < chunk.end) throw new DownloadError('The connection closed early', true);
  }

  try {
    await Promise.all(Array.from({ length: connections }, worker));
    if (firstError) throw firstError as Error;
    if (signal.aborted) throw signal.reason as Error;
  } finally {
    clearInterval(timer);
    signal.removeEventListener('abort', onAbort);
    await checkpoint().catch(() => {});
    await handle.close();
  }
}

class ExpiredUrlError extends DownloadError {
  constructor(status: number) {
    super(`The download link expired (HTTP ${status})`, true);
  }
}

function statusError(status: number, redirected: boolean): DownloadError {
  if (redirected && (status === 401 || status === 403 || status === 410)) {
    return new ExpiredUrlError(status);
  }
  if (status === 401 || status === 403) {
    return new DownloadError(`Access denied (HTTP ${status})`, false);
  }
  if (status === 404) return new DownloadError('The file is no longer there (HTTP 404)', false);
  if (status === 416) return new DownloadError('The file changed on the server (HTTP 416)', false);
  return new DownloadError(`The server answered HTTP ${status}`, status === 429 || status >= 500);
}

/** Follows redirects once, so every range goes straight to the final host. */
async function resolveUrl(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<string> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    let response: Response;
    try {
      response = await doFetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        headers: hostHeaders(current, url, headers),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw new DownloadError(`Couldn't reach ${new URL(current).host}: ${describe(error)}`, true, {
        cause: error,
      });
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw statusError(response.status, false);
    return current;
  }
  throw new DownloadError('Too many redirects', false);
}

function hostHeaders(
  url: string,
  original: string,
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return headers && new URL(url).host === new URL(original).host ? headers : {};
}

async function writeAll(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(
      data,
      offset,
      data.length - offset,
      position + offset,
    );
    offset += bytesWritten;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : '';
    return cause && !error.message.includes(cause) ? `${error.message} (${cause})` : error.message;
  }
  return String(error);
}

/** True for errors that mean the disk is full. */
export function isDiskFull(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOSPC';
}
