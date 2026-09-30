import { describe, expect, it } from "vitest";
import {
  CLI_SIGNATURE_HEADER,
  CLI_SIGNATURE_TOLERANCE_SECONDS,
  signCliRequest,
  verifyCliRequest,
} from "../src/lib/auth/cli-signature";
import * as script from "./reset-password.mjs";

const SECRET = "test-secret-that-is-at-least-32-characters-long";
const BODY = JSON.stringify({ email: "owner@example.com" });

describe("reset-password.mjs signing", () => {
  it("produces exactly the server's signature", () => {
    expect(script.CLI_SIGNATURE_HEADER).toBe(CLI_SIGNATURE_HEADER);
    expect(script.signCliRequest(SECRET, 1_700_000_000, BODY)).toBe(
      signCliRequest(SECRET, 1_700_000_000, BODY),
    );
  });
});

describe("verifyCliRequest", () => {
  const now = 1_700_000_000;
  const header = signCliRequest(SECRET, now, BODY);

  it("accepts a fresh signature over the same body", () => {
    expect(verifyCliRequest(SECRET, header, BODY, now + 5)).toBe(true);
  });

  it("rejects a different body, secret, or a missing header", () => {
    expect(verifyCliRequest(SECRET, header, JSON.stringify({ email: "x@example.com" }), now)).toBe(
      false,
    );
    expect(verifyCliRequest(`${SECRET}-other`, header, BODY, now)).toBe(false);
    expect(verifyCliRequest(SECRET, null, BODY, now)).toBe(false);
    expect(verifyCliRequest(SECRET, "t=1,v1=nothex", BODY, now)).toBe(false);
  });

  it("rejects a signature outside the clock tolerance", () => {
    const late = now + CLI_SIGNATURE_TOLERANCE_SECONDS + 1;
    expect(verifyCliRequest(SECRET, header, BODY, late)).toBe(false);
  });
});
