/**
 * Every schema field that names a URL Kiri will fetch, clone or hand to a
 * plugin must be http(s).
 *
 * zod's `z.url()` accepts *every* scheme — `file:`, `javascript:`, and git's
 * `ext::sh -c …`, which executes the rest of the string — so this suite pins
 * the refinement that closes that, and the first case here is the proof that
 * `z.url()` alone would not.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  configureSourceSchema,
  installPluginSchema,
  resolveUrlSchema,
} from "@/lib/contracts/plugins";
import { createSeriesSchema, HTTP_URL_MESSAGE, httpUrl } from "@/lib/contracts/series";

const HOSTILE = [
  "file:///etc/passwd",
  "ext::sh -c whoami",
  "javascript:alert(1)",
  "git://example.com/plugin.git",
  "ssh://git@example.com/plugin.git",
];

describe("httpUrl", () => {
  it("is needed: bare z.url() takes anything with a scheme", () => {
    for (const value of HOSTILE) {
      expect(z.url().safeParse(value).success).toBe(true);
    }
  });

  it("accepts http and https", () => {
    expect(httpUrl().safeParse("https://mangadex.org/title/abc").success).toBe(true);
    expect(httpUrl().safeParse("http://localhost:3000/x").success).toBe(true);
  });

  it.each(HOSTILE)("refuses %s with a message that says why", (value) => {
    const parsed = httpUrl().safeParse(value);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(HTTP_URL_MESSAGE);
  });

  it("still enforces the length cap", () => {
    expect(httpUrl().safeParse(`https://x.test/${"a".repeat(2001)}`).success).toBe(false);
  });
});

describe("schemas that take a URL", () => {
  it.each(HOSTILE)("installPluginSchema refuses %s for both url variants", (url) => {
    expect(installPluginSchema.safeParse({ type: "url", url }).success).toBe(false);
    expect(installPluginSchema.safeParse({ type: "git", url }).success).toBe(false);
  });

  it("installPluginSchema still accepts an https archive and an https clone", () => {
    expect(
      installPluginSchema.safeParse({ type: "url", url: "https://example.com/plugin.zip" }).success,
    ).toBe(true);
    expect(
      installPluginSchema.safeParse({
        type: "git",
        url: "https://example.com/plugin.git",
        ref: "main",
      }).success,
    ).toBe(true);
  });

  it.each(HOSTILE)("resolveUrlSchema refuses %s", (url) => {
    expect(resolveUrlSchema.safeParse({ url }).success).toBe(false);
  });

  it.each(HOSTILE)("configureSourceSchema refuses %s", (url) => {
    expect(configureSourceSchema.safeParse({ url }).success).toBe(false);
  });

  it.each(HOSTILE)("createSeriesSchema refuses %s as a source or a cover", (url) => {
    expect(createSeriesSchema.safeParse({ title: "X", sourceUrl: url }).success).toBe(false);
    expect(createSeriesSchema.safeParse({ title: "X", coverUrl: url }).success).toBe(false);
  });

  it("createSeriesSchema still accepts https, null and undefined", () => {
    expect(
      createSeriesSchema.safeParse({
        title: "X",
        sourceUrl: "https://mangadex.org/title/abc",
        coverUrl: "https://cdn.example/cover.jpg",
      }).success,
    ).toBe(true);
    expect(
      createSeriesSchema.safeParse({ title: "X", sourceUrl: null, coverUrl: null }).success,
    ).toBe(true);
    expect(createSeriesSchema.safeParse({ title: "X" }).success).toBe(true);
  });
});
