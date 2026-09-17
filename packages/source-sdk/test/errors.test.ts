import { describe, expect, it } from "vitest";

import {
  blocked,
  cancelled,
  internalError,
  ioError,
  isPluginError,
  isRetryableByDefault,
  needsCredential,
  networkError,
  notFound,
  parseError,
  PluginError,
  rateLimited,
  toExitCode,
  unsupportedUrl,
} from "../src/errors.js";
import { ERROR_CODES } from "../src/protocol.js";

describe("toExitCode", () => {
  it("implements the ABI table", () => {
    expect(toExitCode("NEEDS_CREDENTIAL")).toBe(3);
    expect(toExitCode("NOT_FOUND")).toBe(4);
    expect(toExitCode("UNSUPPORTED_URL")).toBe(4);
    expect(toExitCode("RATE_LIMITED")).toBe(5);
    expect(toExitCode("BLOCKED")).toBe(5);
    expect(toExitCode("CANCELLED")).toBe(6);
    expect(toExitCode("NETWORK")).toBe(1);
    expect(toExitCode("PARSE")).toBe(1);
    expect(toExitCode("IO")).toBe(1);
    expect(toExitCode("INTERNAL")).toBe(1);
  });

  it("covers every code in the closed set", () => {
    for (const code of ERROR_CODES) {
      expect(Number.isInteger(toExitCode(code))).toBe(true);
    }
  });
});

describe("PluginError", () => {
  it("carries code, retryable and hint into the wire event", () => {
    const error = new PluginError("NEEDS_CREDENTIAL", "cookie expired", { hint: "paste a cookie" });
    expect(error.toEvent()).toEqual({
      t: "error",
      ok: false,
      code: "NEEDS_CREDENTIAL",
      message: "cookie expired",
      retryable: false,
      hint: "paste a cookie",
    });
    expect(error.exitCode).toBe(3);
  });

  it("uses per-code retryable defaults that an option can override", () => {
    expect(new PluginError("NETWORK", "x").retryable).toBe(true);
    expect(new PluginError("PARSE", "x").retryable).toBe(false);
    expect(new PluginError("PARSE", "x", { retryable: true }).retryable).toBe(true);
    expect(isRetryableByDefault("RATE_LIMITED")).toBe(true);
  });

  it("normalises unknown throwables", () => {
    expect(PluginError.from(new PluginError("IO", "x")).code).toBe("IO");
    expect(PluginError.from(new Error("plain")).code).toBe("INTERNAL");
    expect(PluginError.from(new Error("plain"), "PARSE").code).toBe("PARSE");
    expect(PluginError.from("just a string").message).toBe("just a string");

    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(PluginError.from(abort).code).toBe("CANCELLED");

    const enoent: NodeJS.ErrnoException = new Error("no such file");
    enoent.code = "ENOENT";
    expect(PluginError.from(enoent).code).toBe("IO");

    const reset: NodeJS.ErrnoException = new Error("socket hang up");
    reset.code = "ECONNRESET";
    expect(PluginError.from(reset).code).toBe("NETWORK");
  });

  it("recognises a PluginError from another copy of the SDK", () => {
    const foreign = { name: "PluginError", code: "BLOCKED", message: "nope" };
    expect(isPluginError(foreign)).toBe(true);
    expect(isPluginError(new Error("no"))).toBe(false);
    expect(isPluginError(null)).toBe(false);
  });

  it("keeps the original error as `cause`", () => {
    const cause = new Error("root");
    expect(PluginError.from(cause).cause).toBe(cause);
  });
});

describe("helpers", () => {
  it("produce the right codes", () => {
    expect(needsCredential().code).toBe("NEEDS_CREDENTIAL");
    expect(rateLimited().code).toBe("RATE_LIMITED");
    expect(notFound("gone").message).toBe("gone");
    expect(unsupportedUrl().code).toBe("UNSUPPORTED_URL");
    expect(blocked().code).toBe("BLOCKED");
    expect(networkError().code).toBe("NETWORK");
    expect(parseError().code).toBe("PARSE");
    expect(ioError().code).toBe("IO");
    expect(cancelled().code).toBe("CANCELLED");
    expect(internalError().code).toBe("INTERNAL");
  });
});
