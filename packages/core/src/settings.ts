import { z } from 'zod';
import { indexUrlSchema } from './marketplace';
import { modelIdSchema, runtimeBackendSchema } from './models';

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * What every clank in every project knows about the user. It goes into each clank's prompt, so it's
 * kept short: about 300 tokens at most.
 */
export const userProfileSchema = z.object({
  /** What the clanks call the user. Empty is "the user". */
  name: z.string().trim().max(60),
  /** An IANA zone such as `Australia/Sydney`. Empty uses this computer's. */
  timeZone: z
    .string()
    .trim()
    .max(64)
    .refine((zone) => zone === '' || isTimeZone(zone), 'Unknown time zone'),
  /** Language and spelling, such as "Australian English". */
  language: z.string().trim().max(60),
  /** How the user likes replies, and things never to do. */
  preferences: z.string().trim().max(1000),
});

export type UserProfile = z.infer<typeof userProfileSchema>;

/**
 * The account approved emails go out through: any SMTP server, or Gmail's with an app password.
 * Its password is in the keychain, never here. `none` means emails are approved without sending.
 */
export const emailSettingsSchema = z.object({
  kind: z.enum(['none', 'smtp', 'gmail']),
  /** The SMTP server, such as `smtp.fastmail.com`. Gmail's is filled in. */
  host: z
    .string()
    .trim()
    .max(253)
    .regex(/^[\w.-]*$/, 'Use a server name such as smtp.example.com'),
  port: z.number().int().min(1).max(65535),
  /** TLS from the first byte, as on port 465. Otherwise the connection upgrades with STARTTLS. */
  secure: z.boolean(),
  /** What to sign in as: usually the address. */
  user: z.string().trim().max(254),
  /** The address emails come from. */
  from: z
    .string()
    .trim()
    .max(254)
    .refine((a) => a === '' || /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a), 'Use an email address'),
  /** The name beside it, such as "Sam at Surf Shop". Empty uses the profile's name. */
  name: z.string().trim().max(80),
});

export type EmailSettings = z.infer<typeof emailSettingsSchema>;

/** The keychain entry for the email account's password. */
export const EMAIL_PASSWORD = 'email:password';

export const GMAIL_SMTP = { host: 'smtp.gmail.com', port: 465, secure: true } as const;

/** Whether the email account has everything it needs but its password. */
export function emailConfigured(email: EmailSettings): boolean {
  return email.kind !== 'none' && email.host !== '' && email.user !== '' && email.from !== '';
}

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
  profile: userProfileSchema,
  /** Serve pulled models to other apps on 127.0.0.1, with OpenAI- and Ollama-style endpoints. */
  localApiEnabled: z.boolean(),
  localApiPort: z.number().int().min(1024).max(65535),
  /**
   * Where `web_search` searches. SearXNG is the user's own instance; Brave and Tavily use a key from
   * the keychain. With none, clanks get no search tool.
   */
  webSearch: z.enum(['none', 'searxng', 'brave', 'tavily']),
  /** A SearXNG instance's address, such as `http://localhost:8888`. */
  searxngUrl: z
    .string()
    .trim()
    .max(500)
    .refine(
      (url) => url === '' || /^https?:\/\/\S+$/i.test(url),
      'Use an http:// or https:// address',
    ),
  /**
   * When a tool a clank's policy asks about stops for the user's approval: only for risky calls,
   * such as pushing, deleting outside the worktree or deploying, or for every call.
   */
  approvals: z.enum(['risky', 'all']),
  /**
   * What cloud models cost, in dollars per million tokens, by provider id, as the user set them.
   * Budgets in money and the day's spend are worked out from these; local models cost nothing.
   */
  cloudPrices: z.record(
    z.string().regex(/^[a-z][\w-]*$/),
    z.object({ input: z.number().min(0).max(10_000), output: z.number().min(0).max(10_000) }),
  ),
  /** The account emails the user approves are sent through. */
  email: emailSettingsSchema,
  /**
   * Marketplaces besides the public one, such as a team's own: the address of each one's
   * `index.json`, or a folder that holds one.
   */
  marketplaceIndexes: z.array(indexUrlSchema).max(20),
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
  profile: { name: '', timeZone: '', language: '', preferences: '' },
  localApiEnabled: false,
  // Ollama's port, so tools that speak Ollama find clanks with no setup.
  localApiPort: 11434,
  webSearch: 'none',
  searxngUrl: '',
  approvals: 'risky',
  cloudPrices: {},
  email: { kind: 'none', host: '', port: 587, secure: false, user: '', from: '', name: '' },
  marketplaceIndexes: [],
};

export const settingsPatchSchema = settingsSchema.partial().strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
