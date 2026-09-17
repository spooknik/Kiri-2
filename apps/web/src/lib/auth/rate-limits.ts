/**
 * Rate limiting for the authentication perimeter.
 *
 * better-auth ships its own limiter, but it keys on the request IP as reported
 * by proxy headers and cannot tell whether those headers are trustworthy: with
 * a spoofable `x-forwarded-for` every request gets a fresh bucket, and with no
 * header at all every request in the instance shares *one* bucket, which turns
 * the limiter itself into a lockout. Kiri disables it (see
 * `src/lib/auth/server.ts`) and uses this module instead, on top of the shared
 * token buckets in `src/lib/rate-limit.ts`.
 *
 * Three buckets are consumed per attempt, and the strictest answer wins:
 *
 * | Bucket   | Capacity | Refill      | Stops                                  |
 * | -------- | -------- | ----------- | -------------------------------------- |
 * | identity | 10       | 1 / 30 s    | password guessing against one account  |
 * | client   | 30       | 0.5 / s     | one IP hammering many accounts         |
 * | global   | 300      | 5 / s       | a distributed flood of the whole stack |
 *
 * The identity bucket is scoped per `scope` (the endpoint), so exhausting
 * sign-in attempts for an address does not also block that address from
 * claiming an invite. The client and global buckets are shared across the whole
 * auth surface on purpose — they exist to cap total pressure.
 */
import { getEnv } from "@/lib/env";
import { checkRateLimit, type RateLimitResult } from "@/lib/rate-limit";

export const AUTH_RATE_LIMITS = {
  /** Per email (or other subject), per endpoint. */
  identity: { capacity: 10, refillPerSecond: 1 / 30 },
  /** Per client, across every auth endpoint. */
  client: { capacity: 30, refillPerSecond: 0.5 },
  /** Whole instance, across every auth endpoint. */
  global: { capacity: 300, refillPerSecond: 5 },
} as const;

/** Header Cloudflare sets with the real client address. */
const CF_IP_HEADER = "cf-connecting-ip";
/** Standard proxy chain; only the first entry is the client the edge saw. */
const FORWARDED_FOR_HEADER = "x-forwarded-for";
/** Used when no header may be trusted: everyone shares one client bucket. */
const DIRECT = "direct";

/**
 * The client identity used for per-client limiting.
 *
 * Proxy headers are only read when `AUTH_TRUST_PROXY=1`, i.e. when the operator
 * has said that every request reaches the app through a reverse proxy that
 * overwrites them. Without that promise a direct caller could hand us any value
 * it likes and get an unlimited number of buckets, so the constant `"direct"`
 * is used and the per-client bucket degrades into a second global one.
 */
export function clientKey(headers: Headers | null | undefined): string {
  if (getEnv().AUTH_TRUST_PROXY !== "1") return DIRECT;
  if (!headers) return DIRECT;
  const cloudflare = headers.get(CF_IP_HEADER)?.trim();
  if (cloudflare) return cloudflare;
  const forwarded = headers.get(FORWARDED_FOR_HEADER)?.split(",")[0]?.trim();
  return forwarded || DIRECT;
}

export interface AuthAttempt {
  /** Endpoint being attempted, e.g. `"/sign-in/email"`. Scopes the identity bucket. */
  scope: string;
  /** Email the attempt is against, when the request carries one. */
  email?: string | null;
  /** Non-email subject (an invite token hash, a user id) when there is no email. */
  subject?: string | null;
  /** Request headers, for the per-client bucket. */
  headers?: Headers | null;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Consume one token from each applicable bucket.
 *
 * Every bucket is consumed even when an earlier one already denied the attempt:
 * a denied request is still work the instance had to do, and charging for it is
 * what makes the client and global buckets meaningful under attack.
 */
export function limitAuthAttempt(attempt: AuthAttempt): RateLimitResult {
  const { scope, headers, now } = attempt;
  const identity = normalizeIdentity(attempt.email) ?? normalizeIdentity(attempt.subject);

  const results: RateLimitResult[] = [];
  if (identity) {
    results.push(
      checkRateLimit(`auth:${scope}:identity:${identity}`, { ...AUTH_RATE_LIMITS.identity, now }),
    );
  }
  results.push(
    checkRateLimit(`auth:client:${clientKey(headers)}`, { ...AUTH_RATE_LIMITS.client, now }),
  );
  results.push(checkRateLimit("auth:global", { ...AUTH_RATE_LIMITS.global, now }));

  const denied = results.filter((result) => !result.allowed);
  if (denied.length === 0) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: Math.max(...denied.map((r) => r.retryAfterMs)) };
}

/** Lower-case and trim; emails are case-insensitive and so are our buckets. */
function normalizeIdentity(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

/** Seconds for a `Retry-After` header, never below 1. */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Number.isFinite(retryAfterMs) ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : 60;
}
