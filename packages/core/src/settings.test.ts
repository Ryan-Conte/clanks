import { describe, expect, it } from 'vitest';
import { defaultSettings, settingsPatchSchema, settingsSchema } from './settings';

describe('settings', () => {
  it('has valid defaults', () => {
    expect(settingsSchema.parse(defaultSettings)).toEqual(defaultSettings);
    expect(defaultSettings.closeToTray).toBe(true);
  });

  it('accepts a partial patch without filling in the rest', () => {
    expect(settingsPatchSchema.parse({ closeToTray: false })).toEqual({ closeToTray: false });
    expect(settingsPatchSchema.parse({})).toEqual({});
  });

  it('rejects unknown keys and wrong types in a patch', () => {
    expect(settingsPatchSchema.safeParse({ nope: true }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ closeToTray: 'yes' }).success).toBe(false);
  });
});
