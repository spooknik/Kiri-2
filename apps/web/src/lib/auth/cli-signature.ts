/**
 * Request signing for the container CLI (`scripts/reset-password.mjs`).
 *
 * The CLI runs inside the Kiri container and talks to the server over
 * loopback. It proves it is running there by signing with a key derived from
 * `APP_SECRET`, which only the container's environment holds — anyone who has
 * that secret can already forge sessions, so this grants nothing new.
 *
 * Header: `x-kiri-cli-signature: t=<unix seconds>,v1=<hex HMAC-SHA256>` over
 * `<t>.<raw body>`. The script re-implements this in plain JS (it cannot import
 * TypeScript); `scripts/reset-password.test.mts` keeps the two in step.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const CLI_SIGNATURE_HEADER = "x-kiri-cli-signature";

/** How far a signature's timestamp may drift from the server clock. */
export const CLI_SIGNATURE_TOLERANCE_SECONDS = 300;

function cliKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "kiri-cli", "password-reset/v1", 32));
}

export function signCliRequest(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", cliKey(secret)).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verifyCliRequest(
  secret: string,
  header: string | null,
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header?.trim() ?? "");
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (Math.abs(nowSeconds - timestamp) > CLI_SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(signCliRequest(secret, timestamp, body));
  const actual = Buffer.from(header!.trim());
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
