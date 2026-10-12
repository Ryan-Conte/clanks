import type { SecretCipher } from '@clanks/orchestrator';
import { safeStorage } from 'electron';

/**
 * Encrypts secrets with Electron's safeStorage, whose key lives in the OS keychain.
 * On Linux without a keyring, safeStorage falls back to a hardcoded key (`basic_text`),
 * which is no better than plain text, so that counts as unavailable.
 */
export const keychainCipher: SecretCipher = {
  backend() {
    if (process.platform === 'darwin') return 'keychain';
    if (process.platform === 'win32') return 'dpapi';
    return safeStorage.getSelectedStorageBackend();
  },
  isAvailable() {
    return safeStorage.isEncryptionAvailable() && this.backend() !== 'basic_text';
  },
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (encrypted) => safeStorage.decryptString(encrypted),
};
