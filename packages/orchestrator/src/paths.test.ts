import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appDataLayout, ensureAppDataLayout } from './paths';
import { tempDir } from './test-helpers';

describe('app data layout', () => {
  it('puts everything under the root', () => {
    const root = join(tempDir(), 'clanks');
    const layout = appDataLayout(root);
    expect(layout.database).toBe(join(root, 'clanks.db'));
    expect(layout.modelBlobs).toBe(join(root, 'models', 'blobs'));
    for (const path of Object.values(layout) as string[]) {
      expect(path.startsWith(root)).toBe(true);
    }
  });

  it('creates the folders, except browser sessions, and can run again', () => {
    const layout = appDataLayout(join(tempDir(), 'clanks'));
    ensureAppDataLayout(layout);
    ensureAppDataLayout(layout);
    for (const dir of [
      layout.modelBlobs,
      layout.modelManifests,
      layout.runtime,
      layout.worktrees,
      layout.checkpoints,
      layout.artifacts,
      layout.crew,
      layout.logs,
    ]) {
      expect(existsSync(dir), dir).toBe(true);
    }
    expect(existsSync(layout.browser)).toBe(false);
    expect(existsSync(layout.database)).toBe(false);
  });
});
