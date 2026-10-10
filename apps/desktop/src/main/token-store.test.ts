import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTokenStore } from "./token-store";

// Stand-in for safeStorage: reversible, and never the plaintext.
const crypto = (available: boolean) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString("hex")}`),
  decryptString: (b: Buffer) => {
    const text = b.toString();
    if (!text.startsWith("enc:")) throw new Error("bad");
    return Buffer.from(text.slice(4), "hex").toString();
  },
});
const file = () => join(mkdtempSync(join(tmpdir(), "loop-ts-")), "session.bin");

describe("token store", () => {
  it("with encryption: writes the token encrypted, reads it back, clear deletes the file", () => {
    const f = file();
    const store = createTokenStore(f, crypto(true));
    expect(store.persistent).toBe(true);
    store.set("tok_123");
    expect(readFileSync(f).toString()).not.toContain("tok_123");
    expect(createTokenStore(f, crypto(true)).get()).toBe("tok_123"); // survives a restart
    store.clear();
    expect(existsSync(f)).toBe(false);
    expect(store.get()).toBeNull();
  });

  it("without encryption: never touches the disk, keeps the token in memory, reports not persistent", () => {
    const f = file();
    const store = createTokenStore(f, crypto(false));
    expect(store.persistent).toBe(false);
    store.set("tok_123");
    expect(existsSync(f)).toBe(false);
    expect(existsSync(`${f}.tmp`)).toBe(false);
    expect(store.get()).toBe("tok_123");
    expect(createTokenStore(f, crypto(false)).get()).toBeNull(); // gone after a restart
    store.clear();
    expect(store.get()).toBeNull();
  });

  it("an unreadable file means signed out, and is removed", () => {
    const f = file();
    writeFileSync(f, "garbage");
    expect(createTokenStore(f, crypto(true)).get()).toBeNull();
    expect(existsSync(f)).toBe(false);
  });
});
