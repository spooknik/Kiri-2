/**
 * Session accessors used by route handlers and server components.
 *
 * Backed by better-auth (src/lib/auth/server.ts). The exported signatures are
 * the contract src/lib/api.ts and src/lib/authz.ts code against.
 *
 * `getCurrentUser` is wrapped in React's `cache()` so a server render that asks
 * several times — layout, page, a badge — resolves the session once per
 * request. The session cookie cache (60 s) keeps most of those resolutions off
 * the database entirely.
 */
import { cache } from "react";
import { headers } from "next/headers";
import { auth } from "./server";
import type { SessionUser, UserRole } from "./types";

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Sign in required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Map better-auth's session user onto Kiri's {@link SessionUser}. Exported for
 * tests and for the few places that already hold a better-auth user.
 */
export function toSessionUser(user: {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
  displayName?: string | null;
  showAdult?: boolean | null;
  showSpoilers?: boolean | null;
  mustSetPassword?: boolean | null;
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName?.trim() || user.name?.trim() || user.email,
    role: normalizeRole(user.role),
    showAdult: user.showAdult ?? false,
    showSpoilers: user.showSpoilers ?? false,
    mustSetPassword: user.mustSetPassword ?? false,
  };
}

function normalizeRole(role: string | null | undefined): UserRole {
  return role === "admin" ? "admin" : "member";
}

/**
 * Resolve the session from an explicit header set. Used by `getCurrentUser`
 * and by anything holding a `Request` (route handler tests, the proxy's
 * server-side counterparts).
 */
export async function getUserFromHeaders(requestHeaders: Headers): Promise<SessionUser | null> {
  const result = await auth.api.getSession({ headers: requestHeaders });
  if (!result?.user) return null;
  return toSessionUser(result.user);
}

/** Resolve the current user from the request's session cookie, or null. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  return getUserFromHeaders(await headers());
});

/** Like getCurrentUser but throws an UnauthorizedError when signed out. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new UnauthorizedError();
  }
  return user;
}
