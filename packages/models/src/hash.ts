import { Worker } from 'node:worker_threads';

// Inline, so the worker ships inside whatever bundle imports this module.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const hash = createHash('sha256');
let done = 0;
let reported = 0;
createReadStream(workerData.file, { highWaterMark: 4 * 1024 * 1024 })
  .on('data', (data) => {
    hash.update(data);
    done += data.length;
    if (done - reported >= 64 * 1024 * 1024) {
      reported = done;
      parentPort.postMessage({ progress: done });
    }
  })
  .on('error', (error) => parentPort.postMessage({ error: error.message }))
  .on('end', () => parentPort.postMessage({ digest: hash.digest('hex'), progress: done }));
`;

/**
 * The sha256 of a file, computed on a worker thread so hashing a model of many gigabytes never
 * stalls the main process.
 */
export function sha256File(
  file: string,
  options: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) return reject(signal.reason as Error);
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { file } });
    const finish = (settle: () => void) => {
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      settle();
    };
    const onAbort = () => finish(() => reject(signal!.reason as Error));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (message: { progress?: number; digest?: string; error?: string }) => {
      if (message.progress !== undefined) options.onProgress?.(message.progress);
      if (message.error !== undefined) finish(() => reject(new Error(message.error)));
      else if (message.digest !== undefined) finish(() => resolve(message.digest!));
    });
    worker.on('error', (error) => finish(() => reject(error)));
  });
}
