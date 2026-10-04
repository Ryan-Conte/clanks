import { z } from 'zod';

/** App settings, stored one row per key. */
export const settingsSchema = z.object({
  /** Closing the window keeps clanks running in the tray. When false, closing the window quits. */
  closeToTray: z.boolean(),
});

export type Settings = z.infer<typeof settingsSchema>;

// Defaults live here rather than as zod `.default()`s, which would fill in a partial patch too.
export const defaultSettings: Settings = {
  closeToTray: true,
};

export const settingsPatchSchema = settingsSchema.partial().strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
