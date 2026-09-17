import { describe, expect, it } from "vitest";

import { compareVersions, parseVersion, satisfies } from "../src/semver.js";

describe("parseVersion", () => {
  it("parses releases and prereleases", () => {
    expect(parseVersion("2.0.0")).toEqual({ major: 2, minor: 0, patch: 0, prerelease: [] });
    expect(parseVersion("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("2.0.0-alpha.0")).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: ["alpha", 0],
    });
    expect(parseVersion("2.0.0+build.5")).toMatchObject({ prerelease: [] });
  });

  it("rejects junk", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("2.0")).toBeNull();
    expect(parseVersion("next")).toBeNull();
  });
});

describe("compareVersions", () => {
  const v = (value: string) => parseVersion(value) as NonNullable<ReturnType<typeof parseVersion>>;

  it("orders by major/minor/patch then prerelease", () => {
    expect(compareVersions(v("1.0.0"), v("2.0.0"))).toBe(-1);
    expect(compareVersions(v("2.1.0"), v("2.0.9"))).toBe(1);
    expect(compareVersions(v("2.0.0"), v("2.0.0"))).toBe(0);
    // A prerelease sorts *before* its release.
    expect(compareVersions(v("2.0.0-alpha.0"), v("2.0.0"))).toBe(-1);
    expect(compareVersions(v("2.0.0-alpha.1"), v("2.0.0-alpha.0"))).toBe(1);
    expect(compareVersions(v("2.0.0-alpha.1"), v("2.0.0-beta.0"))).toBe(-1);
    expect(compareVersions(v("2.0.0-alpha"), v("2.0.0-alpha.1"))).toBe(-1);
  });
});

describe("satisfies", () => {
  it("handles the wildcard and empty ranges", () => {
    expect(satisfies("2.0.0", "*")).toBe(true);
    expect(satisfies("2.0.0", "")).toBe(true);
    expect(satisfies("2.0.0", undefined)).toBe(true);
  });

  it("handles caret ranges", () => {
    expect(satisfies("2.3.4", "^2.0.0")).toBe(true);
    expect(satisfies("2.0.0", "^2.0.0")).toBe(true);
    expect(satisfies("3.0.0", "^2.0.0")).toBe(false);
    expect(satisfies("1.9.9", "^2.0.0")).toBe(false);
    // 0.x is special: only the patch range floats.
    expect(satisfies("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
  });

  it("handles the alpha range the template ships with", () => {
    expect(satisfies("2.0.0-alpha.0", "^2.0.0-alpha.0")).toBe(true);
    expect(satisfies("2.0.0-alpha.5", "^2.0.0-alpha.0")).toBe(true);
    expect(satisfies("2.1.0", "^2.0.0-alpha.0")).toBe(true);
    expect(satisfies("1.0.0", "^2.0.0-alpha.0")).toBe(false);
    expect(satisfies("3.0.0", "^2.0.0-alpha.0")).toBe(false);
  });

  it("never lets an unrelated prerelease slip through", () => {
    expect(satisfies("2.0.0-alpha.0", "^2.0.0")).toBe(false);
    expect(satisfies("3.0.0-beta.1", ">=2.0.0")).toBe(false);
  });

  it("handles tilde, comparators, conjunctions and disjunctions", () => {
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("2.0.0", ">=2.0.0")).toBe(true);
    expect(satisfies("1.9.9", ">=2.0.0")).toBe(false);
    expect(satisfies("2.0.1", ">2.0.0")).toBe(true);
    expect(satisfies("2.0.0", "<=2.0.0")).toBe(true);
    expect(satisfies("2.0.0", "2.0.0")).toBe(true);
    expect(satisfies("2.0.1", "2.0.0")).toBe(false);
    expect(satisfies("2.5.0", ">=2.0.0 <3.0.0")).toBe(true);
    expect(satisfies("3.0.0", ">=2.0.0 <3.0.0")).toBe(false);
    expect(satisfies("1.0.0", "^1.0.0 || ^2.0.0")).toBe(true);
    expect(satisfies("2.4.0", "^1.0.0 || ^2.0.0")).toBe(true);
    expect(satisfies("3.0.0", "^1.0.0 || ^2.0.0")).toBe(false);
  });

  it("is permissive about a broken range and strict about a broken version", () => {
    expect(satisfies("2.0.0", "not-a-range")).toBe(true);
    expect(satisfies("banana", "^2.0.0")).toBe(false);
  });
});
