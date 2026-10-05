import { z } from 'zod';
import { modelIdSchema, runtimeBackendSchema } from './models';

/** App settings, stored one row per key. */
export const settingsSchema = z.object({
  /** Closing the window keeps clanks running in the tray. When false, closing the window quits. */
  closeToTray: z.boolean(),
  /** First run is over: a model was pulled and given to the crew, or the user skipped it. */
  onboarded: z.boolean(),
  /** The model every clank uses unless it has its own. Null until one is pulled and picked. */
  crewModel: modelIdSchema.nullable(),
  /** Unload a model this many minutes after its last use, unless it is kept loaded. */
  modelIdleMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  /** Context per parallel slot, in tokens. Clamped to what each model was trained for. */
  contextPerSlot: z.number().int().min(2048).max(1_048_576),
  /** Parallel slots per loaded model, so clanks can share it. Null picks from the hardware. */
  parallelSlots: z.number().int().min(1).max(8).nullable(),
  /** The llama.cpp build to run models on. `auto` picks the fastest that sees a device. */
  runtimeBackend: z.union([z.literal('auto'), runtimeBackendSchema]),
  /** Overrides for how much GPU and system memory models may use, in MiB. Null is automatic. */
  gpuBudgetMiB: z.number().int().min(0).nullable(),
  systemBudgetMiB: z.number().int().min(0).nullable(),
});

export type Settings = z.infer<typeof settingsSchema>;

// Defaults live here rather than as zod `.default()`s, which would fill in a partial patch too.
export const defaultSettings: Settings = {
  closeToTray: true,
  onboarded: false,
  crewModel: null,
  modelIdleMinutes: 10,
  contextPerSlot: 32_768,
  parallelSlots: null,
  runtimeBackend: 'auto',
  gpuBudgetMiB: null,
  systemBudgetMiB: null,
};

export const settingsPatchSchema = settingsSchema.partial().strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
