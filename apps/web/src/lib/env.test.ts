import { afterEach, describe, expect, it } from "vitest";
import { getEnv, resetEnvCache } from "./env";

describe("getEnv", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    resetEnvCache();
  });

  it("parses a valid environment with defaults", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.APP_SECRET = "x".repeat(40);
    delete process.env.JOB_CONCURRENCY;
    resetEnvCache();

    const env = getEnv();
    expect(env.DATABASE_URL).toBe("postgresql://u:p@localhost:5432/db");
    expect(env.JOB_CONCURRENCY).toBe(1);
    expect(env.KIRI_PLUGIN_SANDBOX).toBe("warn");
    expect(env.DATA_ROOT).toBe("./data");
  });

  it("rejects a short APP_SECRET with a readable message", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.APP_SECRET = "short";
    resetEnvCache();

    expect(() => getEnv()).toThrow(/APP_SECRET/);
  });

  it("coerces numeric settings", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.APP_SECRET = "x".repeat(40);
    process.env.JOB_CONCURRENCY = "3";
    resetEnvCache();

    expect(getEnv().JOB_CONCURRENCY).toBe(3);
  });

  it("defaults AUTH_TRUST_PROXY to 0", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.APP_SECRET = "x".repeat(40);
    delete process.env.AUTH_TRUST_PROXY;
    resetEnvCache();

    expect(getEnv().AUTH_TRUST_PROXY).toBe("0");
  });

  it("accepts AUTH_TRUST_PROXY=1", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.APP_SECRET = "x".repeat(40);
    process.env.AUTH_TRUST_PROXY = "1";
    resetEnvCache();

    expect(getEnv().AUTH_TRUST_PROXY).toBe("1");
  });

  it("rejects AUTH_CF_TRUST_HEADER=1 on a plain-http PUBLIC_URL", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.APP_SECRET = "x".repeat(40);
    process.env.AUTH_CF_TRUST_HEADER = "1";
    process.env.PUBLIC_URL = "http://kiri.example.com";
    resetEnvCache();

    expect(() => getEnv()).toThrow(/AUTH_CF_TRUST_HEADER/);
    expect(() => getEnv()).toThrow(/https/);
  });

  it("allows AUTH_CF_TRUST_HEADER=1 behind https", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.APP_SECRET = "x".repeat(40);
    process.env.AUTH_CF_TRUST_HEADER = "1";
    process.env.PUBLIC_URL = "https://kiri.example.com";
    resetEnvCache();

    expect(getEnv().AUTH_CF_TRUST_HEADER).toBe("1");
  });

  it("skips the cross-field check during the production build phase", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.APP_SECRET = "x".repeat(40);
    process.env.AUTH_CF_TRUST_HEADER = "1";
    process.env.PUBLIC_URL = "http://localhost:3000";
    process.env.NEXT_PHASE = "phase-production-build";
    resetEnvCache();

    expect(() => getEnv()).not.toThrow();
  });
});
