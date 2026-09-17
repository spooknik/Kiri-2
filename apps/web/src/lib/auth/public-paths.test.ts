import { describe, expect, it } from "vitest";
import { isApiPath, isPublicPath, normalizePathname } from "./public-paths";

describe("normalizePathname", () => {
  it("drops the query string and trailing slashes", () => {
    expect(normalizePathname("/login?next=%2F")).toBe("/login");
    expect(normalizePathname("/offline/")).toBe("/offline");
    expect(normalizePathname("/")).toBe("/");
  });
});

describe("isPublicPath", () => {
  it.each([
    "/login",
    "/register",
    "/setup",
    "/offline",
    "/offline/reader",
    "/api/auth/sign-in/email",
    "/api/auth/cf",
    "/api/health",
    "/api/version",
    "/api/plugins/hosts",
    "/api/plugins/credentials",
    "/_next/static/chunk.js",
    "/manifest.json",
    "/icons/apple-touch-icon.png",
    "/favicon.ico",
    "/sw.js",
  ])("allows %s", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each([
    "/",
    "/read",
    "/read?series=1",
    "/series/abc",
    "/admin/users",
    "/api/library",
    "/api/series/abc/chapters",
    "/api/plugins",
    "/api/plugins/resolve",
    "/api/plugins/hosts/extra",
    "/api/plugins/credentials/x",
    "/loginish",
    "/setup-guide",
    "/offlinex",
  ])("gates %s", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });

  it("does not treat a lookalike prefix as public", () => {
    expect(isPublicPath("/api/authz/tokens")).toBe(false);
    expect(isPublicPath("/iconsets/x.png")).toBe(false);
  });

  it("opens only the two extension endpoints under /api/plugins", () => {
    // The extension carries a bearer token instead of a session cookie; the
    // rest of the plugin API must keep its session gate.
    expect(isPublicPath("/api/plugins/hosts")).toBe(true);
    expect(isPublicPath("/api/plugins/credentials")).toBe(true);
    expect(isPublicPath("/api/plugins")).toBe(false);
    expect(isPublicPath("/api/plugins/resolve")).toBe(false);
    expect(isPublicPath("/api/plugins/abc")).toBe(false);
    expect(isPublicPath("/api/plugins/hostsx")).toBe(false);
  });
});

describe("isApiPath", () => {
  it("matches only /api routes", () => {
    expect(isApiPath("/api/library")).toBe(true);
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/apiary")).toBe(false);
    expect(isApiPath("/read")).toBe(false);
  });
});
