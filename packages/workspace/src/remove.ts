import { rm } from 'node:fs/promises';

/**
 * Deletes a folder and everything in it. A folder that isn't there is fine.
 *
 * Use this, not `rmSync`: the Node inside Electron fails a recursive `rmSync` with EPERM on Windows
 * as soon as it meets a read-only file, and git keeps every object it writes read-only. The tests
 * run on a Node where `rmSync` still works, so they can't catch it.
 */
export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
}
