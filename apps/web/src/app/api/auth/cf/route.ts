/**
 * Cloudflare Access sign-in bridge.
 *
 * Active only when `AUTH_CF_ACCESS=1`. Cloudflare terminates the login and
 * hands us a signed identity; this route turns that into a normal Kiri
 * session so everything downstream (the proxy, `getCurrentUser`, the admin
 * plugin) works exactly as it does for password sign-in.
 *
 * Identity comes from, in order:
 *  1. `Cf-Access-Jwt-Assertion` (falling back to the `CF_Authorization`
 *     cookie), verified with `jose` against
 *     `https://<team>/cdn-cgi/access/certs` and checked against
 *     `CF_ACCESS_AUD`. This is the only mode that is safe on its own.
 *  2. The `cf-access-authenticated-user-email` header, but only when
 *     `AUTH_CF_TRUST_HEADER=1` — that header is trivially spoofable unless the
 *     instance is genuinely only reachable through Cloudflare.
 *
 * Provisioning follows the same rules as sign-up (see
 * `resolveCloudflareProvisioning`): first run, a pending invite pinned to that
 * address, or open registration. The assertion is never logged.
 */
import { NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { resolveCloudflareProvisioning } from "@/lib/auth/registration";
import { safeNext } from "@/lib/auth/safe-next";
import { issueSession } from "@/lib/auth/session-cookie";
import { consumeInvite, normalizeEmail } from "@/lib/invites";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const JWT_HEADER = "cf-access-jwt-assertion";
const EMAIL_HEADER = "cf-access-authenticated-user-email";
const JWT_COOKIE = "CF_Authorization";

const jwksCache = new Map<string, JWTVerifyGetKey>();

/** Test seam: forget cached remote key sets between cases. */
export function resetCfJwksCache(): void {
  jwksCache.clear();
}

function jwksFor(teamDomain: string): JWTVerifyGetKey {
  const cached = jwksCache.get(teamDomain);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
  jwksCache.set(teamDomain, jwks);
  return jwks;
}

function readAssertion(request: Request): string | null {
  const header = request.headers.get(JWT_HEADER);
  if (header?.trim()) return header.trim();
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== JWT_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

/**
 * Browser navigations that cannot be bridged fall back to the password login
 * page (an instance reachable both through and around Cloudflare must still
 * be usable); API-style callers get a JSON 401.
 */
function deny(request: Request, next: string, message: string): NextResponse {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    const url = new URL(request.url);
    const login = new URL("/login", url.origin);
    login.searchParams.set("next", next);
    login.searchParams.set("error", "cf_access");
    return NextResponse.redirect(login, 302);
  }
  return NextResponse.json({ error: { code: "CF_ACCESS_DENIED", message } }, { status: 401 });
}

export async function GET(request: Request): Promise<NextResponse> {
  const env = getEnv();
  if (env.AUTH_CF_ACCESS !== "1") {
    return NextResponse.json(
      { error: { code: "NOT_ENABLED", message: "Cloudflare Access sign-in is not enabled." } },
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));

  let email: string | null = null;
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.CF_ACCESS_AUD?.trim();

  if (teamDomain && audience) {
    const token = readAssertion(request);
    if (!token) {
      return deny(request, next, "No Cloudflare Access assertion on this request.");
    }
    try {
      const { payload } = await jwtVerify(token, jwksFor(teamDomain), {
        audience,
        issuer: `https://${teamDomain}`,
      });
      const claim = payload["email"];
      if (typeof claim === "string" && claim.includes("@")) {
        email = normalizeEmail(claim);
      }
    } catch {
      // Never log the assertion or the verification detail.
      return deny(request, next, "The Cloudflare Access assertion could not be verified.");
    }
    if (!email) {
      return deny(request, next, "The Cloudflare Access assertion carries no email claim.");
    }
  } else if (env.AUTH_CF_TRUST_HEADER === "1") {
    const claim = request.headers.get(EMAIL_HEADER);
    if (!claim?.includes("@")) {
      return deny(request, next, "No Cloudflare Access identity on this request.");
    }
    email = normalizeEmail(claim);
  } else {
    return deny(
      request,
      next,
      "Cloudflare Access is enabled but not configured. Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, or AUTH_CF_TRUST_HEADER=1.",
    );
  }

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const provisioning = await resolveCloudflareProvisioning(email);
    if (!provisioning.allowed) {
      return NextResponse.json(
        {
          error: {
            code: "NOT_INVITED",
            message: "This account is not allowed on this instance. Ask an admin for an invite.",
          },
        },
        { status: 403 },
      );
    }
    const displayName = email.split("@")[0] || email;
    user = await prisma.user.create({
      data: {
        email,
        name: displayName,
        displayName,
        emailVerified: true,
        role: provisioning.role,
      },
    });
    if (provisioning.inviteId) {
      await consumeInvite(provisioning.inviteId, user.id);
    }
  }

  if (user.banned) {
    return NextResponse.json(
      { error: { code: "BANNED", message: user.banReason ?? "This account is suspended." } },
      { status: 403 },
    );
  }

  const session = await issueSession(user.id, request);
  const response = NextResponse.redirect(new URL(next, url.origin), 302);
  response.headers.append("set-cookie", session.setCookie);
  return response;
}
