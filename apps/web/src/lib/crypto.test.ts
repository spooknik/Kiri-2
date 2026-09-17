import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedWithCurrentKey,
  randomToken,
  sha256Hex,
} from "@/lib/crypto";
import { resetEnvCache } from "@/lib/env";

const SECRET_A = "secret-a-secret-a-secret-a-secret-a-0001";
const SECRET_B = "secret-b-secret-b-secret-b-secret-b-0002";

const originalEnv = { ...process.env };

function useSecrets(current: string, previous?: string): void {
  process.env.APP_SECRET = current;
  if (previous) {
    process.env.APP_SECRET_PREVIOUS = previous;
  } else {
    delete process.env.APP_SECRET_PREVIOUS;
  }
  resetEnvCache();
}

beforeEach(() => {
  useSecrets(SECRET_A);
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCache();
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a credential", () => {
    const envelope = encryptSecret("cf_clearance=abc123; path=/");
    expect(Buffer.isBuffer(envelope)).toBe(true);
    expect(decryptSecret(envelope)).toBe("cf_clearance=abc123; path=/");
  });

  it("round-trips unicode and empty strings", () => {
    expect(decryptSecret(encryptSecret("パスワード🔐"))).toBe("パスワード🔐");
    expect(decryptSecret(encryptSecret(""))).toBe("");
  });

  it("uses a fresh salt and iv per envelope", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(5, 33).equals(b.subarray(5, 33))).toBe(false);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  it("writes the documented envelope header", () => {
    const envelope = encryptSecret("x");
    expect(envelope[0]).toBe(0x01);
    // version(1) + keyId(4) + salt(16) + iv(12) + tag(16) = 49 bytes of header.
    expect(envelope.length).toBe(49 + 1);
  });

  it("accepts a plain Uint8Array view of the envelope", () => {
    const envelope = encryptSecret("view me");
    const view = new Uint8Array(envelope);
    expect(decryptSecret(view)).toBe("view me");
  });

  it("returns null when the ciphertext is tampered with", () => {
    const envelope = encryptSecret("tamper me please");
    const copy = Buffer.from(envelope);
    const last = copy.length - 1;
    copy[last] = (copy[last] ?? 0) ^ 0xff;
    expect(decryptSecret(copy)).toBeNull();
  });

  it("returns null when the header is tampered with", () => {
    const envelope = encryptSecret("tamper the salt");
    const copy = Buffer.from(envelope);
    copy[6] = (copy[6] ?? 0) ^ 0xff; // inside the salt, covered by the AAD
    expect(decryptSecret(copy)).toBeNull();
  });

  it("returns null for a truncated or empty envelope", () => {
    const envelope = encryptSecret("truncate me");
    expect(decryptSecret(envelope.subarray(0, 20))).toBeNull();
    expect(decryptSecret(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for an unknown version byte", () => {
    const envelope = Buffer.from(encryptSecret("versioned"));
    envelope[0] = 0x02;
    expect(decryptSecret(envelope)).toBeNull();
  });

  it("returns null when the secret is unknown", () => {
    const envelope = encryptSecret("locked out");
    useSecrets(SECRET_B);
    expect(decryptSecret(envelope)).toBeNull();
  });

  it("decrypts with APP_SECRET_PREVIOUS after rotation", () => {
    const envelope = encryptSecret("survives rotation");
    useSecrets(SECRET_B, SECRET_A);
    expect(decryptSecret(envelope)).toBe("survives rotation");
    // New writes use the new key.
    const reEncrypted = encryptSecret("survives rotation");
    expect(reEncrypted.subarray(1, 5).equals(envelope.subarray(1, 5))).toBe(false);
    expect(decryptSecret(reEncrypted)).toBe("survives rotation");
  });
});

describe("isEncryptedWithCurrentKey", () => {
  it("is true for the current key and false after rotation", () => {
    const envelope = encryptSecret("rotate me");
    expect(isEncryptedWithCurrentKey(envelope)).toBe(true);
    useSecrets(SECRET_B, SECRET_A);
    expect(isEncryptedWithCurrentKey(envelope)).toBe(false);
    expect(isEncryptedWithCurrentKey(encryptSecret("rotate me"))).toBe(true);
  });

  it("is false for junk", () => {
    expect(isEncryptedWithCurrentKey(Buffer.alloc(4))).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of an empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("kiri")).toHaveLength(64);
  });
});

describe("randomToken", () => {
  it("returns url-safe unique tokens", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toBe(randomToken());
    expect(randomToken(8).length).toBeLessThan(token.length);
  });
});
