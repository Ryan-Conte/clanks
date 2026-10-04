import {
  type Settings,
  type SettingsPatch,
  defaultSettings,
  settingsPatchSchema,
  settingsSchema,
} from '@clanks/core';
import { setting } from './store/schema';
import type { Db } from './store/store';

export class SettingsService {
  constructor(private readonly db: Db) {}

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
    return this.get();
  }
}
