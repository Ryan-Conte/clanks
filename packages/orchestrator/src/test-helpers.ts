import type { HardwareInfo } from '@clanks/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { type Orchestrator, type OrchestratorOptions, startOrchestrator } from './orchestrator';
import type { SecretCipher } from './secrets';

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

/** The priming docs that ship with the app. */
export const crewFolder = fileURLToPath(new URL('../../../crew', import.meta.url));

/** The integrations that ship with the app. */
export const integrationsFolder = fileURLToPath(new URL('../../../integrations', import.meta.url));

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

/** A machine with a 24 GB GPU, so tests never depend on the one they run on. */
export const testHardware: HardwareInfo = {
  platform: process.platform,
  arch: process.arch,
  cpu: { model: 'Test CPU', threads: 8 },
  memory: { totalBytes: 32 * 1024 ** 3, freeBytes: 16 * 1024 ** 3, unified: false },
  gpus: [
    {
      id: 'CUDA0',
      name: 'Test GPU',
      backend: 'cuda',
      totalBytes: 24 * 1024 ** 3,
      freeBytes: 23 * 1024 ** 3,
    },
  ],
  nvidia: true,
  backend: 'cuda',
  budget: { gpuBytes: 22 * 1024 ** 3, systemBytes: 24 * 1024 ** 3 },
  problems: [],
  probedAt: new Date(0),
};

/** An orchestrator in a temporary folder, with no llama.cpp builds and a made-up machine. */
export function startTestOrchestrator(options: Partial<OrchestratorOptions> = {}): Orchestrator {
  const orchestrator = startOrchestrator({
    dataDir: join(tempDir(), 'clanks'),
    migrationsFolder,
    bundledCrewDir: crewFolder,
    bundledIntegrationsDir: integrationsFolder,
    // Never the public one: a test that reaches for the network should fail, not pass by luck.
    marketplaceIndex: 'https://marketplace.test/index.json',
    marketplaceFetch: () => Promise.reject(new TypeError('fetch failed')),
    integrationsFetch: () => Promise.reject(new TypeError('fetch failed')),
    cipher: fakeCipher(),
    appInfo: {
      name: 'clanks',
      version: '0.0.0-test',
      platform: process.platform,
      arch: process.arch,
      packaged: false,
      versions: { electron: '0', chrome: '0', node: process.versions.node },
    },
    ...options,
    models: {
      builds: () => [],
      probe: () => Promise.resolve({ hardware: testHardware, build: null }),
      ...options.models,
    },
  });
  // Hooks run last-registered first, so this settles before the temporary folder goes.
  onTestFinished(async () => {
    orchestrator.close();
    await orchestrator.ready.catch(() => {});
  });
  return orchestrator;
}
