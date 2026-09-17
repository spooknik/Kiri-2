/**
 * Cookie handling: the volatile-cookie strip, the bare-token normalisation and
 * — the one that actually bit people in V1 — the recency rule between a cookie
 * pasted on a series and one captured by the browser extension.
 */
import { describe, expect, it } from "vitest";
import {
  chooseCredential,
  normalizeCookieHeader,
  pickCredentialForHost,
  stripVolatileCookies,
} from "@/lib/plugins/credentials";

describe("stripVolatileCookies", () => {
  it("drops Cloudflare's per-session bot cookies and keeps the rest", () => {
    const cookie = "cf_clearance=abc; __cf_bm=xyz; _cfuvid=uvw; session=keepme; cf_chl_rc_ni=1";
    expect(stripVolatileCookies(cookie)).toBe("cf_clearance=abc; session=keepme");
  });

  it("drops every cf_chl_ prefixed cookie", () => {
    expect(stripVolatileCookies("cf_chl_2=a; cf_chl_prog=b; keep=c")).toBe("keep=c");
  });

  it("leaves a bare token alone (there is nothing to strip)", () => {
    expect(stripVolatileCookies("just-a-clearance-token")).toBe("just-a-clearance-token");
  });

  it("tolerates stray separators and whitespace", () => {
    expect(stripVolatileCookies("  a=1 ;; b=2 ; ")).toBe("a=1; b=2");
  });
});

describe("normalizeCookieHeader", () => {
  it("gives a pasted bare token its name back", () => {
    expect(normalizeCookieHeader("  abc123  ")).toBe("cf_clearance=abc123");
  });

  it("keeps a real Cookie header as a header", () => {
    expect(normalizeCookieHeader("cf_clearance=abc; __cf_bm=drop")).toBe("cf_clearance=abc");
  });
});

describe("chooseCredential (V1's recency rule)", () => {
  const older = new Date("2026-01-01T00:00:00Z");
  const newer = new Date("2026-02-01T00:00:00Z");

  it("uses the series cookie when there is no plugin credential", () => {
    expect(
      chooseCredential({ cookie: "a=1", userAgent: "UA-series", updatedAt: older }, null),
    ).toEqual({ cookie: "a=1", userAgent: "UA-series", origin: "series" });
  });

  it("uses the plugin credential when the series has none", () => {
    expect(
      chooseCredential(
        { cookie: null, userAgent: "leftover-UA", updatedAt: null },
        { cookie: "b=2", userAgent: "UA-plugin", updatedAt: older },
      ),
    ).toEqual({ cookie: "b=2", userAgent: "UA-plugin", origin: "plugin" });
  });

  it("prefers whichever was set more recently", () => {
    const seriesWins = chooseCredential(
      { cookie: "a=1", userAgent: "UA-series", updatedAt: newer },
      { cookie: "b=2", userAgent: "UA-plugin", updatedAt: older },
    );
    expect(seriesWins).toEqual({ cookie: "a=1", userAgent: "UA-series", origin: "series" });

    const pluginWins = chooseCredential(
      { cookie: "a=1", userAgent: "UA-series", updatedAt: older },
      { cookie: "b=2", userAgent: "UA-plugin", updatedAt: newer },
    );
    expect(pluginWins).toEqual({ cookie: "b=2", userAgent: "UA-plugin", origin: "plugin" });
  });

  it("lets a dated capture take over from an undated legacy paste", () => {
    expect(
      chooseCredential(
        { cookie: "a=1", userAgent: "UA-series", updatedAt: null },
        { cookie: "b=2", userAgent: "UA-plugin", updatedAt: older },
      ),
    ).toEqual({ cookie: "b=2", userAgent: "UA-plugin", origin: "plugin" });
  });

  it("never mixes a cookie from one source with a User-Agent from the other", () => {
    // cf_clearance is bound to the User-Agent that solved the challenge.
    const chosen = chooseCredential(
      { cookie: "a=1", userAgent: "UA-series", updatedAt: older },
      { cookie: "b=2", userAgent: null, updatedAt: newer },
    );
    expect(chosen).toEqual({ cookie: "b=2", userAgent: null, origin: "plugin" });
  });

  it("reports nothing when neither side has a cookie", () => {
    expect(chooseCredential({ cookie: null, userAgent: "UA", updatedAt: null }, null)).toEqual({
      cookie: null,
      userAgent: null,
      origin: "none",
    });
  });

  it("treats an empty cookie as no cookie", () => {
    expect(
      chooseCredential(
        { cookie: "", userAgent: "UA", updatedAt: newer },
        {
          cookie: "b=2",
          userAgent: "UA-plugin",
          updatedAt: older,
        },
      ),
    ).toMatchObject({ origin: "plugin" });
  });
});

describe("pickCredentialForHost", () => {
  const credentials = [
    { host: "cdn.example.com" },
    { host: "example.com" },
    { host: "*.other.com" },
  ];

  it("prefers an exact host match", () => {
    expect(pickCredentialForHost(credentials, "example.com")).toEqual({ host: "example.com" });
    expect(pickCredentialForHost(credentials, "cdn.example.com")).toEqual({
      host: "cdn.example.com",
    });
  });

  it("falls back to a wildcard pattern", () => {
    expect(pickCredentialForHost(credentials, "images.other.com")).toEqual({ host: "*.other.com" });
  });

  it("uses the only credential a single-host plugin has", () => {
    expect(pickCredentialForHost([{ host: "example.com" }], "unrelated.test")).toEqual({
      host: "example.com",
    });
  });

  it("refuses to guess between several unrelated credentials", () => {
    expect(pickCredentialForHost(credentials, "unrelated.test")).toBeNull();
    expect(pickCredentialForHost([], "example.com")).toBeNull();
  });
});
