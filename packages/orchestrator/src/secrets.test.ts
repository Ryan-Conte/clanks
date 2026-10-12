import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore, SecretsUnavailableError } from './secrets';
import { fakeCipher, tempDir } from './test-helpers';

const KEY = 'sk-ant-test-0123456789';

describe('secret store', () => {
  it('stores, reads and deletes a secret', () => {
    const store = new SecretStore(join(tempDir(), 'secrets.json'), fakeCipher());
    expect(store.has('provider:anthropic')).toBe(false);
    expect(store.get('provider:anthropic')).toBeUndefined();

    store.set('provider:anthropic', KEY);
    expect(store.has('provider:anthropic')).toBe(true);
    expect(store.get('provider:anthropic')).toBe(KEY);
    expect(store.refs()).toEqual(['provider:anthropic']);

    expect(store.delete('provider:anthropic')).toBe(true);
    expect(store.delete('provider:anthropic')).toBe(false);
    expect(store.has('provider:anthropic')).toBe(false);
  });

  it('never writes the plain text to disk', () => {
    const file = join(tempDir(), 'secrets.json');
    new SecretStore(file, fakeCipher()).set('provider:anthropic', KEY);
    const contents = readFileSync(file, 'utf8');
    expect(contents).toContain('provider:anthropic');
    expect(contents).not.toContain(KEY);
    expect(contents).not.toContain(Buffer.from(KEY).toString('base64'));
  });

  it.skipIf(process.platform === 'win32')('keeps the file private to the user', () => {
    const file = join(tempDir(), 'secrets.json');
    new SecretStore(file, fakeCipher()).set('provider:anthropic', KEY);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps secrets across restarts', () => {
    const file = join(tempDir(), 'secrets.json');
    new SecretStore(file, fakeCipher()).set('hf:token', 'hf_abc');
    expect(new SecretStore(file, fakeCipher()).get('hf:token')).toBe('hf_abc');
  });

  it('refuses to store anything without a keychain', () => {
    const file = join(tempDir(), 'secrets.json');
    const store = new SecretStore(file, fakeCipher({ available: false }));
    expect(store.status()).toEqual({ available: false, backend: 'basic_text' });
    expect(() => store.set('provider:anthropic', KEY)).toThrow(SecretsUnavailableError);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses to read when the keychain goes away', () => {
    const cipher = fakeCipher();
    const store = new SecretStore(join(tempDir(), 'secrets.json'), cipher);
    store.set('provider:anthropic', KEY);
    cipher.available = false;
    expect(store.has('provider:anthropic')).toBe(true);
    expect(() => store.get('provider:anthropic')).toThrow(SecretsUnavailableError);
  });

  it('rejects bad refs and empty values', () => {
    const store = new SecretStore(join(tempDir(), 'secrets.json'), fakeCipher());
    expect(() => store.set('../escape', KEY)).toThrow();
    expect(() => store.set('provider:anthropic', '')).toThrow();
  });

  it('never overwrites a secrets file it cannot read', () => {
    const file = join(tempDir(), 'secrets.json');
    writeFileSync(file, '{ not json');
    const store = new SecretStore(file, fakeCipher());
    expect(() => store.set('provider:anthropic', KEY)).toThrow(/unreadable/);
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });
});
