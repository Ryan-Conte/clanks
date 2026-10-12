import {
  type Settings,
  type SettingsPatch,
  defaultSettings,
  settingsPatchSchema,
  settingsSchema,
} from '@clanks/core';
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import { setting } from './store/schema';
import type { Db } from './store/store';

/** Emits `change` with the new settings after every update. */
export class SettingsService extends EventEmitter<{ change: [Settings] }> {
  constructor(private readonly db: Db) {
    super();
  }

  /** The current settings. A stored value that no longer validates falls back to its default. */
  get(): Settings {
    const stored = new Map(
      this.db
        .select()
        .from(setting)
        .all()
        .map((row) => [row.key, row.value]),
    );
    const settings: Record<string, unknown> = { ...defaultSettings };
    for (const [key, field] of Object.entries(settingsSchema.shape)) {
      if (!stored.has(key)) continue;
      const parsed = field.safeParse(stored.get(key));
      if (parsed.success) settings[key] = parsed.data;
    }
    return settingsSchema.parse(settings);
  }

  /**
   * App state kept beside the settings but never shown to the window as one, such as where the
   * models folder moved to. Keys are namespaced (`models.dir`) so they can't clash with a setting.
   */
  readInternal(key: `${string}.${string}`): unknown {
    return this.db.select().from(setting).where(eq(setting.key, key)).get()?.value;
  }

  /** Null removes the value. */
  writeInternal(key: `${string}.${string}`, value: unknown): void {
    if (value === null || value === undefined) {
      this.db.delete(setting).where(eq(setting.key, key)).run();
      return;
    }
    const updatedAt = new Date();
    this.db
      .insert(setting)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt } })
      .run();
  }

  update(patch: SettingsPatch): Settings {
    const values = settingsPatchSchema.parse(patch);
    const updatedAt = new Date();
    this.db.transaction((tx) => {
      for (const [key, value] of Object.entries(values)) {
        tx.insert(setting)
          .values({ key, value, updatedAt })
          .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt } })
          .run();
      }
    });
    const next = this.get();
    this.emit('change', next);
    return next;
  }
}
