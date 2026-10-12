import { z } from 'zod';

/** The cloud providers clanks has adapters for. Each needs the user's own key. */
export const CLOUD_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const;

export type CloudProviderId = (typeof CLOUD_PROVIDERS)[number];

/**
 * Where a model runs: `builtin` for models clanks pulled itself, a cloud provider, or a model
 * server the user added, such as LM Studio or vLLM (`server-<slug>`).
 */
export const providerIdSchema = z
  .string()
  .regex(
    /^(?:builtin|anthropic|openai|google|openrouter|server-[a-z0-9][a-z0-9-]{0,39})$/,
    'Unknown provider',
  );

export type ProviderId = z.infer<typeof providerIdSchema>;

/** A model to run, at its provider. */
export const modelChoiceSchema = z.object({
  provider: providerIdSchema,
  model: z.string().trim().min(1).max(200),
});

export type ModelChoice = z.infer<typeof modelChoiceSchema>;

export type ProviderKind = 'builtin' | CloudProviderId | 'server';

/** A provider as Settings shows it. Keys never leave the orchestrator; only whether there is one. */
export interface ProviderStatus {
  id: ProviderId;
  kind: ProviderKind;
  name: string;
  baseUrl: string | null;
  /** Cloud providers need a key before they can be used. Servers may not need one. */
  hasKey: boolean;
  /** Ready to use: the built-in runtime always is, a cloud provider once it has a key. */
  configured: boolean;
}

export interface ProviderModel {
  id: string;
  title: string;
  /** Tokens, when the provider says. */
  contextWindow: number | null;
}

export const serverInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine((url) => /^https?:\/\//i.test(url), 'Use an http:// or https:// address'),
  /** Optional: most local servers take any key, or none. */
  apiKey: z.string().trim().max(4096).optional(),
});

export type ServerInput = z.infer<typeof serverInputSchema>;
