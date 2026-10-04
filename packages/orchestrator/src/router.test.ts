import { TRPCError } from '@trpc/server';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startOrchestrator } from './orchestrator';
import { appRouter, createAppCaller } from './router';
import { fakeCipher, migrationsFolder, tempDir } from './test-helpers';

function setup() {
  const orchestrator = startOrchestrator({
    dataDir: join(tempDir(), 'clanks'),
    migrationsFolder,
    cipher: fakeCipher(),
    appInfo: {
      name: 'clanks',
      version: '0.0.0-test',
      platform: process.platform,
      arch: process.arch,
      packaged: false,
      versions: { electron: '0', chrome: '0', node: process.versions.node },
    },
  });
  return { orchestrator, caller: createAppCaller(orchestrator.context) };
}

describe('app router', () => {
  it('reports the app, its data folder and the database', async () => {
    const { orchestrator, caller } = setup();
    const info = await caller.app.info();
    expect(info.version).toBe('0.0.0-test');
    expect(info.dataDir).toBe(orchestrator.paths.root);
    expect(info.store.file).toBe(orchestrator.paths.database);
    expect(info.store.migrations).toBeGreaterThan(0);
    orchestrator.close();
  });

  it('reads and updates settings', async () => {
    const { orchestrator, caller } = setup();
    expect(await caller.settings.get()).toEqual({ closeToTray: true });
    expect(await caller.settings.update({ closeToTray: false })).toEqual({ closeToTray: false });
    expect(await caller.settings.get()).toEqual({ closeToTray: false });
    orchestrator.close();
  });

  it('validates settings input', async () => {
    const { orchestrator, caller } = setup();
    // @ts-expect-error wrong type
    await expect(caller.settings.update({ closeToTray: 'yes' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    orchestrator.close();
  });

  it('saves, checks and deletes secrets', async () => {
    const { orchestrator, caller } = setup();
    expect(await caller.secrets.status()).toEqual({ available: true, backend: 'fake' });
    await caller.secrets.set({ ref: 'provider:anthropic', value: 'sk-test' });
    expect(await caller.secrets.has('provider:anthropic')).toBe(true);
    expect(orchestrator.context.secrets.get('provider:anthropic')).toBe('sk-test');
    expect(await caller.secrets.delete('provider:anthropic')).toBe(true);
    expect(await caller.secrets.has('provider:anthropic')).toBe(false);
    await expect(caller.secrets.set({ ref: 'Bad Ref', value: 'x' })).rejects.toBeInstanceOf(
      TRPCError,
    );
    orchestrator.close();
  });

  it('never hands a secret to the window', () => {
    const paths = Object.keys(appRouter._def.procedures);
    expect(paths).toContain('secrets.set');
    expect(paths.filter((path) => path.startsWith('secrets.'))).toEqual([
      'secrets.status',
      'secrets.has',
      'secrets.set',
      'secrets.delete',
    ]);
  });
});
