/**
 * The Kiri Cookie Bridge extension (`extension/`, at the repo root — a
 * sibling of `apps/`) has no build step and isn't part of this workspace's
 * package graph, so its cookie-handling helper is tested here via a
 * relative import into `extension/cookies.js`, a dependency-free ESM
 * module (no `chrome.*` APIs) written specifically to be importable by a
 * plain Node test runner. See `extension/background.js` for how the real
 * service worker uses it against `chrome.cookies.getAll()` results.
 */
import { describe, expect, it } from "vitest";
import {
  buildCookieHeader,
  cfClearanceValue,
  isVolatileCookieName,
  matchKnownHost,
  VOLATILE_COOKIE_NAMES,
} from "../../../../extension/cookies.js";

describe("isVolatileCookieName", () => {
  it("flags the known Cloudflare bot-management cookie names", () => {
    for (const name of VOLATILE_COOKIE_NAMES) {
      expect(isVolatileCookieName(name)).toBe(true);
    }
  });

  it("flags any cf_chl_* challenge cookie", () => {
    expect(isVolatileCookieName("cf_chl_rc_ni")).toBe(true);
    expect(isVolatileCookieName("cf_chl_2")).toBe(true);
  });

  it("does not flag cf_clearance or an ordinary cookie", () => {
    expect(isVolatileCookieName("cf_clearance")).toBe(false);
    expect(isVolatileCookieName("session")).toBe(false);
  });
});

describe("buildCookieHeader", () => {
  it("drops volatile cookies and joins the rest as name=value pairs", () => {
    const header = buildCookieHeader([
      { name: "cf_clearance", value: "abc123" },
      { name: "__cf_bm", value: "should-be-dropped" },
      { name: "_cfuvid", value: "should-be-dropped-too" },
      { name: "cf_chl_rc_ni", value: "also-dropped" },
      { name: "session", value: "xyz" },
    ]);
    expect(header).toBe("cf_clearance=abc123; session=xyz");
  });

  it("dedupes repeated cookie names (last write wins)", () => {
    const header = buildCookieHeader([
      { name: "cf_clearance", value: "host-scoped" },
      { name: "cf_clearance", value: "domain-scoped" },
    ]);
    expect(header).toBe("cf_clearance=domain-scoped");
  });

  it("returns an empty string for no cookies", () => {
    expect(buildCookieHeader([])).toBe("");
  });

  it("ignores malformed entries", () => {
    expect(buildCookieHeader([null, {}, { name: "ok", value: "1" }])).toBe("ok=1");
  });
});

describe("cfClearanceValue", () => {
  it("returns the cf_clearance value when present", () => {
    expect(
      cfClearanceValue([
        { name: "session", value: "xyz" },
        { name: "cf_clearance", value: "abc123" },
      ]),
    ).toBe("abc123");
  });

  it("returns null when absent", () => {
    expect(cfClearanceValue([{ name: "session", value: "xyz" }])).toBeNull();
  });
});

describe("matchKnownHost", () => {
  const knownHosts = ["mangadex.org", "example.com"];

  it("matches an exact host", () => {
    expect(matchKnownHost("mangadex.org", knownHosts)).toBe("mangadex.org");
  });

  it("matches a subdomain of a known host", () => {
    expect(matchKnownHost("www.mangadex.org", knownHosts)).toBe("mangadex.org");
    expect(matchKnownHost("m.example.com", knownHosts)).toBe("example.com");
  });

  it("is case-insensitive", () => {
    expect(matchKnownHost("WWW.MangaDex.ORG", knownHosts)).toBe("mangadex.org");
  });

  it("returns null for an unrelated host", () => {
    expect(matchKnownHost("notmangadex.org", knownHosts)).toBeNull();
    expect(matchKnownHost("unrelated.net", knownHosts)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(matchKnownHost("", knownHosts)).toBeNull();
    expect(matchKnownHost("mangadex.org", [])).toBeNull();
  });
});
