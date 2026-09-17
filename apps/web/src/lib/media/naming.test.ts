import { describe, expect, it } from "vitest";
import { padIndex, pageFileName } from "./naming";

describe("padIndex", () => {
  it("pads to a minimum width of 3 digits", () => {
    expect(padIndex(7, 12)).toBe("007");
    expect(padIndex(1, 1)).toBe("001");
  });

  it("widens the pad to match the digit count of total", () => {
    expect(padIndex(7, 12000)).toBe("00007");
    expect(padIndex(123, 999)).toBe("123");
    expect(padIndex(42, 100000)).toBe("000042");
  });

  it("does not truncate an index wider than the pad width", () => {
    expect(padIndex(12345, 10)).toBe("12345");
  });
});

describe("pageFileName", () => {
  it("joins the padded index and extension", () => {
    expect(pageFileName(7, 120, "webp")).toBe("007.webp");
    expect(pageFileName(1, 9999, "png")).toBe("0001.png");
  });

  it("accepts an extension with a leading dot", () => {
    expect(pageFileName(3, 10, ".webp")).toBe("003.webp");
  });
});
