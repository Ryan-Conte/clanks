import { z } from 'zod';

/**
 * Names a secret in the keychain, such as `provider:anthropic` or `hf:token`.
 * The data model stores these references, never the secrets themselves.
 */
export const secretRefSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._:-]{0,127}$/,
    'Use lowercase letters, digits, ".", "_", ":" and "-", up to 128 characters',
  );

export type SecretRef = z.infer<typeof secretRefSchema>;

export interface SecretsStatus {
  /** False when the OS gives clanks no keychain to protect secrets with. Nothing is stored then. */
  available: boolean;
  /** The keychain backend in use, such as `keychain`, `dpapi` or `gnome_libsecret`. */
  backend: string;
}
