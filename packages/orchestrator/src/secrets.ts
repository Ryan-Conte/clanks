import { type SecretRef, type SecretsStatus, secretRefSchema } from '@clanks/core';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Encrypts with a key the OS keychain holds: Keychain on macOS, DPAPI on Windows,
 * libsecret or KWallet on Linux. The desktop app provides one backed by Electron's `safeStorage`.
 */
export interface SecretCipher {
  backend(): string;
  /** False when there is no keychain, so secrets could only be kept in plain text. */
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export class SecretsUnavailableError extends Error {
  constructor(backend: string) {
    super(
      `No OS keychain is available (backend: ${backend}), so clanks won't store secrets. ` +
        'On Linux, install and unlock a keyring such as GNOME Keyring or KWallet.',
    );
    this.name = 'SecretsUnavailableError';
  }
}

interface SecretsFile {
  version: 1;
  /** Secret ref → base64 of the encrypted value. */
  secrets: Record<string, string>;
}

/**
 * Secrets such as API keys and tokens. Values are encrypted by the OS keychain and kept in their
 * own file, never in the database and never in plain text. Refs are stored in the clear.
 */
export class SecretStore {
  private cache: Map<string, string> | undefined;

  constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
  ) {}

  status(): SecretsStatus {
    return { available: this.cipher.isAvailable(), backend: this.cipher.backend() };
  }

  has(ref: SecretRef): boolean {
    return this.entries().has(secretRefSchema.parse(ref));
  }

  refs(): SecretRef[] {
    return [...this.entries().keys()].sort();
  }

  get(ref: SecretRef): string | undefined {
    const encrypted = this.entries().get(secretRefSchema.parse(ref));
    if (encrypted === undefined) return undefined;
    this.assertAvailable();
    return this.cipher.decrypt(Buffer.from(encrypted, 'base64'));
  }

  set(ref: SecretRef, value: string): void {
    const key = secretRefSchema.parse(ref);
    if (value.length === 0) throw new Error('A secret cannot be empty');
    this.assertAvailable();
    const entries = new Map(this.entries());
    entries.set(key, this.cipher.encrypt(value).toString('base64'));
    this.write(entries);
  }

  /** Returns whether there was a secret to delete. */
  delete(ref: SecretRef): boolean {
    const key = secretRefSchema.parse(ref);
    const entries = new Map(this.entries());
    if (!entries.delete(key)) return false;
    this.write(entries);
    return true;
  }

  private assertAvailable(): void {
    if (!this.cipher.isAvailable()) throw new SecretsUnavailableError(this.cipher.backend());
  }

  private entries(): Map<string, string> {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) return (this.cache = new Map<string, string>());
    let parsed: SecretsFile;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as SecretsFile;
    } catch (error) {
      // Never start over silently: that would lose every key the user saved.
      throw new Error(`The secrets file at ${this.file} is unreadable`, { cause: error });
    }
    if (parsed.version !== 1 || typeof parsed.secrets !== 'object' || parsed.secrets === null) {
      throw new Error(`The secrets file at ${this.file} has an unknown format`);
    }
    return (this.cache = new Map(Object.entries(parsed.secrets)));
  }

  private write(entries: Map<string, string>): void {
    const contents: SecretsFile = {
      version: 1,
      secrets: Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b))),
    };
    // Write a sibling file and rename it over the old one, so a crash never leaves half a file.
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(contents, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
    this.cache = entries;
  }
}
