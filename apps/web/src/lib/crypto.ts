/**
 * Credential encryption at rest (plugin cookies, tokens, passwords for sites).
 *
 * AES-256-GCM with a per-envelope key derived from APP_SECRET via HKDF-SHA256,
 * so two credentials never share a key stream and rotating APP_SECRET only
 * requires keeping the old value in APP_SECRET_PREVIOUS.
 *
 * Envelope layout (single Buffer, stored in a bytea column):
 *
 *   offset  bytes  field
 *   ------  -----  -----------------------------------------------------------
 *        0      1  version, currently 0x01
 *        1      4  keyId = first 4 bytes of sha256(secret) - picks the secret
 *        5     16  salt, random per envelope, HKDF salt
 *       21     12  iv, random per envelope, GCM nonce
 *       33     16  GCM auth tag
 *       49      n  ciphertext
 *
 * Bytes 0..32 (version | keyId | salt | iv) are fed to GCM as additional
 * authenticated data, so header tampering fails the tag check.
 *
 * Decryption never throws: a wrong key, a truncated buffer or a flipped bit all
 * return null, and callers surface that as NEEDS_CREDENTIAL.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { getEnv } from "@/lib/env";

const VERSION = 0x01;
const INFO = "kiri-credential-v1";
const KEY_ID_LENGTH = 4;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

const KEY_ID_OFFSET = 1;
const SALT_OFFSET = KEY_ID_OFFSET + KEY_ID_LENGTH; // 5
const IV_OFFSET = SALT_OFFSET + SALT_LENGTH; // 21
const TAG_OFFSET = IV_OFFSET + IV_LENGTH; // 33
const HEADER_LENGTH = TAG_OFFSET + TAG_LENGTH; // 49

/** Stable, non-secret fingerprint of a secret; identifies which key to use. */
function keyIdFor(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest().subarray(0, KEY_ID_LENGTH);
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  const key = hkdfSync("sha256", Buffer.from(secret, "utf8"), salt, INFO, KEY_LENGTH);
  return Buffer.from(key);
}

function toBuffer(value: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Encrypt with the current APP_SECRET. Throws only if the env is unusable. */
export function encryptSecret(plain: string): Buffer {
  const secret = getEnv().APP_SECRET;
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const header = Buffer.concat([Buffer.from([VERSION]), keyIdFor(secret), salt, iv]);

  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, salt), iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);

  return Buffer.concat([header, cipher.getAuthTag(), ciphertext]);
}

/** Every secret that may have produced an envelope, current one first. */
function candidateSecrets(): string[] {
  const env = getEnv();
  return env.APP_SECRET_PREVIOUS ? [env.APP_SECRET, env.APP_SECRET_PREVIOUS] : [env.APP_SECRET];
}

/** Decrypt an envelope, or null when it cannot be read with the known keys. */
export function decryptSecret(envelope: Uint8Array | Buffer): string | null {
  try {
    const buf = toBuffer(envelope);
    if (buf.length < HEADER_LENGTH) return null;
    if (buf[0] !== VERSION) return null;

    const keyId = buf.subarray(KEY_ID_OFFSET, SALT_OFFSET);
    const secret = candidateSecrets().find((candidate) => {
      const candidateId = keyIdFor(candidate);
      return candidateId.length === keyId.length && timingSafeEqual(candidateId, keyId);
    });
    if (!secret) return null;

    const salt = buf.subarray(SALT_OFFSET, IV_OFFSET);
    const iv = buf.subarray(IV_OFFSET, TAG_OFFSET);
    const tag = buf.subarray(TAG_OFFSET, HEADER_LENGTH);
    const ciphertext = buf.subarray(HEADER_LENGTH);

    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, salt), iv);
    decipher.setAAD(buf.subarray(0, TAG_OFFSET));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * True when the envelope was sealed with the current APP_SECRET. A rotation
 * tool re-encrypts everything this returns false for.
 */
export function isEncryptedWithCurrentKey(envelope: Uint8Array | Buffer): boolean {
  try {
    const buf = toBuffer(envelope);
    if (buf.length < HEADER_LENGTH) return false;
    if (buf[0] !== VERSION) return false;
    const keyId = buf.subarray(KEY_ID_OFFSET, SALT_OFFSET);
    const currentId = keyIdFor(getEnv().APP_SECRET);
    return currentId.length === keyId.length && timingSafeEqual(currentId, keyId);
  } catch {
    return false;
  }
}

/** Hex sha256, used for invite/session token lookups (never store the token). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** URL-safe random token for invites and one-time links. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
