import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor";

describe("library cursor", () => {
  it("round-trips an ISO date value", () => {
    const cursor = { v: "2024-05-01T10:00:00.000Z", id: "series-1" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("round-trips a numeric rank", () => {
    const cursor = { v: 0.0607927, id: "series-2" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("round-trips a null sort value (nulls sort last)", () => {
    const cursor = { v: null, id: "series-3" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("round-trips a title with characters base64 would otherwise mangle", () => {
    const cursor = { v: "ぼっち・ざ・ろっく! ~ vol 1/2", id: "series-4" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("encodes url-safe base64 (no +, / or padding)", () => {
    const encoded = encodeCursor({ v: "?????>>>>", id: "aaaaaaaaaaaa" });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns null for anything that is not one of our cursors", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-base64-json")).toBeNull();
    expect(decodeCursor(Buffer.from("[1,2]").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('"nope"').toString("base64url"))).toBeNull();
    // Missing or non-string id.
    expect(decodeCursor(Buffer.from('{"v":"a"}').toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"v":"a","id":7}').toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"v":"a","id":""}').toString("base64url"))).toBeNull();
    // Value of an unsupported type.
    expect(decodeCursor(Buffer.from('{"v":{"a":1},"id":"x"}').toString("base64url"))).toBeNull();
  });

  it("treats a missing value as null", () => {
    expect(decodeCursor(Buffer.from('{"id":"series-9"}').toString("base64url"))).toEqual({
      v: null,
      id: "series-9",
    });
  });
});
