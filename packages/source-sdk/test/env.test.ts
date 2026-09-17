import { describe, expect, it } from "vitest";

import { DEFAULT_CONCURRENCY, getSetting, isTruthy, MAX_CONCURRENCY, readEnv } from "../src/env.js";

describe("readEnv", () => {
  it("defaults everything a plugin may run without", () => {
    const env = readEnv({});
    expect(env).toEqual({ verbose: false, concurrency: DEFAULT_CONCURRENCY, settings: {} });
  });

  it("reads the documented variables", () => {
    const env = readEnv({
      KIRI_COOKIE: "cf_clearance=abc",
      KIRI_USER_AGENT: "Mozilla/5.0",
      KIRI_OUTPUT_DIR: "/data/library/s1",
      KIRI_PLUGIN_DIR: "/data/plugins/demo",
      KIRI_SDK_VERSION: "2.0.0",
      KIRI_APP_VERSION: "2.1.0",
      KIRI_VERBOSE: "1",
      KIRI_CONCURRENCY: "8",
      KIRI_SETTINGS: '{"language":"en"}',
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/usr/bin/chromium",
    });
    expect(env).toMatchObject({
      cookie: "cf_clearance=abc",
      userAgent: "Mozilla/5.0",
      outputDir: "/data/library/s1",
      pluginDir: "/data/plugins/demo",
      sdkVersion: "2.0.0",
      appVersion: "2.1.0",
      verbose: true,
      concurrency: 8,
      settings: { language: "en" },
      chromiumExecutablePath: "/usr/bin/chromium",
    });
  });

  it("clamps concurrency and ignores junk", () => {
    expect(readEnv({ KIRI_CONCURRENCY: "0" }).concurrency).toBe(DEFAULT_CONCURRENCY);
    expect(readEnv({ KIRI_CONCURRENCY: "banana" }).concurrency).toBe(DEFAULT_CONCURRENCY);
    expect(readEnv({ KIRI_CONCURRENCY: "999" }).concurrency).toBe(MAX_CONCURRENCY);
  });

  it("degrades bad settings to {} and reports why", () => {
    const broken = readEnv({ KIRI_SETTINGS: "{oops" });
    expect(broken.settings).toEqual({});
    expect(broken.settingsError).toMatch(/not valid JSON/);
    expect(readEnv({ KIRI_SETTINGS: "[1,2]" }).settingsError).toMatch(/must be a JSON object/);
  });

  it("treats blank values as absent", () => {
    expect(readEnv({ KIRI_COOKIE: "   " }).cookie).toBeUndefined();
  });
});

describe("isTruthy", () => {
  it("accepts the usual spellings", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) expect(isTruthy(value)).toBe(true);
    for (const value of ["0", "false", "", "off", undefined]) expect(isTruthy(value)).toBe(false);
  });
});

describe("getSetting", () => {
  it("coerces to the fallback's type", () => {
    expect(getSetting({ language: "de" }, "language", "en")).toBe("de");
    expect(getSetting({}, "language", "en")).toBe("en");
    expect(getSetting({ pages: "12" }, "pages", 5)).toBe(12);
    expect(getSetting({ pages: "x" }, "pages", 5)).toBe(5);
    expect(getSetting({ hd: "true" }, "hd", false)).toBe(true);
    expect(getSetting({ hd: null }, "hd", false)).toBe(false);
  });
});
