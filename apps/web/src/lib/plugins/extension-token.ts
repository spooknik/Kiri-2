/**
 * The Kiri Cookie Bridge token.
 *
 * The browser extension has no session — it is a background script POSTing
 * cookies from a machine that may never have signed in to Kiri in that tab. It
 * authenticates with one long-lived bearer token, shown to admins in the
 * plugins UI and pasted into the extension once.
 *
 * The token is *derived*, not stored: HKDF-SHA256 over `APP_SECRET` with a
 * fixed salt and info. That means no migration, no table, no way to leak it out
 * of the database — and rotating `APP_SECRET` rotates it, which is the correct
 * behaviour (the same rotation invalidates every stored cookie anyway).
 *
 * Comparison is constant-time. The endpoints that use it are `withPublic` and
 * check it by hand, because a session is exactly what the extension lacks.
 */
import { hkdfSync, timingSafeEqual } from "node:crypto";
import type { ExtensionTokenResponse } from "@/lib/contracts/plugins";
import { getEnv } from "@/lib/env";

const SALT = "kiri-extension";
const INFO = "cookie-bridge";
const TOKEN_BYTES = 32;

/** The instance's extension token (base64url, 43 chars). */
export function extensionToken(): string {
  const key = hkdfSync("sha256", Buffer.from(getEnv().APP_SECRET, "utf8"), SALT, INFO, TOKEN_BYTES);
  return Buffer.from(key).toString("base64url");
}

/** Constant-time equality that tolerates different lengths. */
export function tokensMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still do a comparison so the timing does not leak the length.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Read `Authorization: Bearer <token>` (or `X-Kiri-Token`) from a request. */
export function readBearerToken(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  const direct = headers.get("x-kiri-token");
  return direct && direct.trim() !== "" ? direct.trim() : null;
}

/** True when the request carries this instance's extension token. */
export function hasValidExtensionToken(headers: Headers): boolean {
  const presented = readBearerToken(headers);
  if (presented === null) return false;
  return tokensMatch(presented, extensionToken());
}

/** What the admin UI shows: the token and the two URLs to paste with it. */
export function extensionTokenResponse(): ExtensionTokenResponse {
  const base = getEnv().PUBLIC_URL.replace(/\/+$/, "");
  return {
    token: extensionToken(),
    ingestUrl: `${base}/api/plugins/credentials`,
    hostsUrl: `${base}/api/plugins/hosts`,
  };
}
