import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** The slice of Electron's `safeStorage` used here (injected so the store is testable without Electron). */
export type Crypto = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

/**
 * Holds the refresh token. With OS-backed encryption it is written encrypted to `file`; without it the token
 * lives in memory only (lost on quit) and `persistent` is false, so the renderer can say so. Never plaintext on disk.
 */
export function createTokenStore(file: string, crypto: Crypto) {
  const persistent = crypto.isEncryptionAvailable();
  let memory: string | null = null;

  return {
    persistent,
    get(): string | null {
      if (!persistent) return memory;
      try {
        return crypto.decryptString(readFileSync(file));
      } catch {
        rmSync(file, { force: true }); // missing, or unreadable (keychain reset): start signed out
        return null;
      }
    },
    set(token: string) {
      if (!persistent) {
        memory = token;
        return;
      }
      // write-then-rename: a crash mid-write never leaves a torn token (which would end the session)
      writeFileSync(`${file}.tmp`, crypto.encryptString(token), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
    clear() {
      memory = null;
      rmSync(file, { force: true });
    },
  };
}
