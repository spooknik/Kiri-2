/**
 * Access gating. Runs before every route (Next 16 `proxy` convention, the
 * replacement for `middleware`; it defaults to the Node.js runtime).
 *
 * This only checks that a signed better-auth session cookie is *present* — no
 * database round trip, no session validation. Anything that actually depends on
 * the identity re-resolves it server side through `getCurrentUser()`, which is
 * where an expired or forged cookie is rejected. Keeping the proxy dumb is what
 * lets it stay on the hot path for every request.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { isApiPath, isPublicPath } from "@/lib/auth/public-paths";

export const config = {
  // Static assets and the image optimizer never need gating; everything else
  // goes through isPublicPath below.
  matcher: ["/((?!_next/static|_next/image).*)"],
};

export default function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }
  if (getSessionCookie(request)) {
    return NextResponse.next();
  }

  if (isApiPath(pathname)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Sign in required" } },
      { status: 401 },
    );
  }

  const accept = request.headers.get("accept") ?? "";
  const isNavigation = accept.includes("text/html") || request.headers.has("rsc");
  if (!isNavigation) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Sign in required" } },
      { status: 401 },
    );
  }

  const next = `${pathname}${search}`;
  const cloudflare = process.env.AUTH_CF_ACCESS === "1";
  const target = cloudflare
    ? `/api/auth/cf?next=${encodeURIComponent(next)}`
    : `/login?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(new URL(target, request.nextUrl.origin));
}
