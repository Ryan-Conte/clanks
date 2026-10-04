import { defaultSettings } from '@clanks/core';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SettingsService } from './settings';
import { setting } from './store/schema';
import { openStore } from './store/store';
import { migrationsFolder, tempDir } from './test-helpers';

describe('settings', () => {
  it('starts from the defaults', () => {
    const store = openStore({ file: ':memory:', migrationsFolder });
    expect(new SettingsService(store.db).get()).toEqual(defaultSettings);
    store.close();
  });

  it('keeps changes across restarts', () => {
    const file = join(tempDir(), 'clanks.db');
    const first = openStore({ file, migrationsFolder });
    expect(new SettingsService(first.db).update({ closeToTray: false })).toEqual({
      ...defaultSettings,
      closeToTray: false,
    });
    first.close();

    const second = openStore({ file, migrationsFolder });
    expect(new SettingsService(second.db).get().closeToTray).toBe(false);
    second.close();
  });

  it('falls back to the default for a stored value that no longer validates', () => {
    const store = openStore({ file: ':memory:', migrationsFolder });
    store.db
      .insert(setting)
      .values([
        { key: 'closeToTray', value: 'sometimes', updatedAt: new Date() },
        { key: 'retiredSetting', value: 42, updatedAt: new Date() },
      ])
      .run();
    expect(new SettingsService(store.db).get()).toEqual(defaultSettings);
    store.close();
  });

  it('rejects unknown keys and wrong types', () => {
    const store = openStore({ file: ':memory:', migrationsFolder });
    const settings = new SettingsService(store.db);
    // @ts-expect-error unknown key
    expect(() => settings.update({ nope: true })).toThrow();
    // @ts-expect-error wrong type
    expect(() => settings.update({ closeToTray: 'yes' })).toThrow();
    expect(settings.get()).toEqual(defaultSettings);
    store.close();
  });
});
