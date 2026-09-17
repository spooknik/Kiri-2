/**
 * The Cookie Bridge token: derived from APP_SECRET, stable per instance,
 * compared in constant time, and read from either header the extension may
 * send.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import {
  extensionToken,
  extensionTokenResponse,
  hasValidExtensionToken,
  readBearerToken,
  tokensMatch,
} from "@/lib/plugins/extension-token";

const ORIGINAL_SECRET = process.env["APP_SECRET"];
const ORIGINAL_URL = process.env["PUBLIC_URL"];

function withSecret(secret: string): void {
  process.env["APP_SECRET"] = secret;
  resetEnvCache();
}

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env["APP_SECRET"];
  else process.env["APP_SECRET"] = ORIGINAL_SECRET;
  if (ORIGINAL_URL === undefined) delete process.env["PUBLIC_URL"];
  else process.env["PUBLIC_URL"] = ORIGINAL_URL;
  resetEnvCache();
});

describe("extensionToken", () => {
  it("is a 32-byte base64url string", () => {
    const token = extensionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("is stable for one secret and different for another", () => {
    withSecret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const first = extensionToken();
    expect(extensionToken()).toBe(first);

    withSecret("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(extensionToken()).not.toBe(first);
  });
});

describe("tokensMatch", () => {
  it("accepts an identical token", () => {
    expect(tokensMatch("abcdef", "abcdef")).toBe(true);
  });

  it("rejects a different token of the same length", () => {
    expect(tokensMatch("abcdef", "abcdeg")).toBe(false);
  });

  it("rejects tokens of different lengths without throwing", () => {
    expect(tokensMatch("", "abcdef")).toBe(false);
    expect(tokensMatch("abcdefgh", "abcdef")).toBe(false);
  });
});

describe("readBearerToken", () => {
  it("reads an Authorization header, case-insensitively", () => {
    expect(readBearerToken(new Headers({ authorization: "Bearer abc123" }))).toBe("abc123");
    expect(readBearerToken(new Headers({ authorization: "bearer  abc123 " }))).toBe("abc123");
  });

  it("reads the X-Kiri-Token fallback", () => {
    expect(readBearerToken(new Headers({ "x-kiri-token": "abc123" }))).toBe("abc123");
  });

  it("is null when nothing is presented", () => {
    expect(readBearerToken(new Headers())).toBeNull();
    expect(readBearerToken(new Headers({ authorization: "Basic abc" }))).toBeNull();
  });
});

describe("hasValidExtensionToken", () => {
  it("accepts this instance's token and nothing else", () => {
    withSecret("cccccccccccccccccccccccccccccccccccccccc");
    const token = extensionToken();
    expect(hasValidExtensionToken(new Headers({ authorization: `Bearer ${token}` }))).toBe(true);
    expect(hasValidExtensionToken(new Headers({ authorization: "Bearer wrong" }))).toBe(false);
    expect(hasValidExtensionToken(new Headers())).toBe(false);
  });
});

describe("extensionTokenResponse", () => {
  it("builds the two URLs from PUBLIC_URL without doubling a slash", () => {
    process.env["PUBLIC_URL"] = "https://kiri.example.com/";
    resetEnvCache();
    const response = extensionTokenResponse();
    expect(response.ingestUrl).toBe("https://kiri.example.com/api/plugins/credentials");
    expect(response.hostsUrl).toBe("https://kiri.example.com/api/plugins/hosts");
    expect(response.token).toBe(extensionToken());
  });
});
