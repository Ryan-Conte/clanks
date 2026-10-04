import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import type { SecretCipher } from './secrets';

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

/** A fresh temporary folder, removed after the current test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clanks-test-'));
  onTestFinished(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A failed test can leave a database open, which Windows won't delete. Don't mask the failure.
    }
  });
  return dir;
}

/** Stands in for the OS keychain. Reversible, and never leaves the plain text visible. */
export function fakeCipher({ available = true } = {}): SecretCipher & { available: boolean } {
  return {
    available,
    backend() {
      return this.available ? 'fake' : 'basic_text';
    },
    isAvailable() {
      return this.available;
    },
    encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a)),
    decrypt: (encrypted) => Buffer.from(encrypted.map((byte) => byte ^ 0x5a)).toString('utf8'),
  };
}
