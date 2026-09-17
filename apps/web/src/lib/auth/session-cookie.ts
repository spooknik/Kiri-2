/**
 * Issue a better-auth session outside of a better-auth endpoint.
 *
 * Two Kiri routes sign a user in without a password: the Cloudflare Access
 * bridge (`/api/auth/cf`) and invite claiming for imported V1 accounts
 * (`/api/auth/claim-invite`). Both create the `Session` row through
 * `auth.$context.internalAdapter.createSession` and then have to write the
 * cookie themselves, because better-auth's `setSessionCookie` needs an endpoint
 * context that only exists inside its own router.
 *
 * The cookie format is better-auth's (better-call's, really): the session token
 * followed by a dot and the base64 HMAC-SHA256 of the token under the app
 * secret, URL-encoded. `src/lib/auth/session.int.test.ts` round-trips a cookie
 * produced here through `auth.api.getSession`, so a format change in
 * better-auth fails the test suite instead of silently breaking sign-in.
 */
import { createHmac } from "node:crypto";
import { auth } from "@/lib/auth/server";

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  /** Ready-to-send `Set-Cookie` header value. */
  setCookie: string;
  cookieName: string;
}

/** better-call's signed-cookie encoding: `encodeURIComponent(value + "." + hmac)`. */
export function signCookieValue(value: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(value).digest("base64");
  return encodeURIComponent(`${value}.${signature}`);
}

interface CookieAttributes {
  domain?: string | undefined;
  expires?: Date | undefined;
  httpOnly?: boolean | undefined;
  maxAge?: number | undefined;
  path?: string | undefined;
  secure?: boolean | undefined;
  sameSite?: string | undefined;
}

export function serializeCookie(name: string, value: string, attrs: CookieAttributes): string {
  let out = `${name}=${value}`;
  if (typeof attrs.maxAge === "number") out += `; Max-Age=${Math.floor(attrs.maxAge)}`;
  if (attrs.domain) out += `; Domain=${attrs.domain}`;
  out += `; Path=${attrs.path ?? "/"}`;
  if (attrs.expires) out += `; Expires=${attrs.expires.toUTCString()}`;
  if (attrs.httpOnly) out += "; HttpOnly";
  if (attrs.secure) out += "; Secure";
  if (attrs.sameSite) {
    out += `; SameSite=${attrs.sameSite.charAt(0).toUpperCase()}${attrs.sameSite.slice(1)}`;
  }
  return out;
}

/** Create a database session for `userId` and return the cookie that carries it. */
export async function issueSession(userId: string, request?: Request): Promise<IssuedSession> {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId, false, {
    ipAddress: clientIp(request) ?? "",
    userAgent: request?.headers.get("user-agent") ?? "",
  });
  if (!session) {
    throw new Error("Failed to create session");
  }
  const { name, attributes } = ctx.authCookies.sessionToken;
  const setCookie = serializeCookie(name, signCookieValue(session.token, ctx.secret), {
    ...attributes,
    maxAge: ctx.sessionConfig.expiresIn,
  });
  return { token: session.token, expiresAt: session.expiresAt, setCookie, cookieName: name };
}

function clientIp(request?: Request): string | null {
  if (!request) return null;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return request.headers.get("cf-connecting-ip");
}
