/**
 * A deliberately tiny semver subset — enough for the `sdk` range of
 * `kiri-plugin.json`, with no dependency.
 *
 * This mirrors `packages/source-sdk/src/semver.ts` on purpose rather than
 * importing it: the app never has `@kiri/source-sdk` in its own module graph
 * (the production image ships the SDK as a plain tree at `/app/sdk/<version>`
 * for *plugins* to link against, not as an app dependency), and the two copies
 * are pinned together by `descriptor.test.ts`.
 *
 * Supported ranges: `*` / `x` / empty (any), an exact version, `=`, `>`, `>=`,
 * `<`, `<=`, `^`, `~`, joined by spaces or commas (AND) and `||` (OR).
 *
 * Prerelease rule (as in node-semver): a prerelease version only satisfies a
 * comparator set that itself mentions a prerelease of the *same*
 * `major.minor.patch` tuple, so `2.0.0-alpha.0` never sneaks past `^1.0.0`
 * — and `^2.0.0` does not accept it either, which is exactly why the shipped
 * SDK (`2.0.0-alpha.0`) needs plugins to declare `^2.0.0-alpha.0`.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (string | number)[];
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_RE.exec(value.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease:
      prerelease === undefined || prerelease === ""
        ? []
        : prerelease.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
  };
}

function comparePrerelease(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): number {
  if (a.length === 0 && b.length === 0) return 0;
  // A version without a prerelease outranks one with a prerelease.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftIsNumber = typeof left === "number";
    const rightIsNumber = typeof right === "number";
    if (leftIsNumber && rightIsNumber) return left < right ? -1 : 1;
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    return String(left) < String(right) ? -1 : 1;
  }
  return 0;
}

/** `-1 | 0 | 1`, ignoring build metadata, as semver defines it. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

interface Comparator {
  operator: ">" | ">=" | "<" | "<=" | "=";
  version: ParsedVersion;
}

const COMPARATOR_RE = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/;

function expand(token: string): Comparator[] | null {
  const match = COMPARATOR_RE.exec(token);
  if (!match) return null;
  const operator = match[1] ?? "=";
  const rest = match[2];
  if (rest === undefined) return null;
  const version = parseVersion(rest);
  if (!version) return null;

  switch (operator) {
    case "^": {
      // ^0.2.3 -> >=0.2.3 <0.3.0; ^0.0.3 -> >=0.0.3 <0.0.4; ^1.2.3 -> >=1.2.3 <2.0.0
      const upper: ParsedVersion =
        version.major > 0
          ? { major: version.major + 1, minor: 0, patch: 0, prerelease: [] }
          : version.minor > 0
            ? { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] }
            : { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] };
      return [
        { operator: ">=", version },
        { operator: "<", version: upper },
      ];
    }
    case "~": {
      const upper: ParsedVersion = {
        major: version.major,
        minor: version.minor + 1,
        patch: 0,
        prerelease: [],
      };
      return [
        { operator: ">=", version },
        { operator: "<", version: upper },
      ];
    }
    case ">":
    case ">=":
    case "<":
    case "<=":
    case "=":
      return [{ operator, version }];
    default:
      return null;
  }
}

function testComparator(version: ParsedVersion, comparator: Comparator): boolean {
  const cmp = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case "=":
      return cmp === 0;
  }
}

function sameTuple(a: ParsedVersion, b: ParsedVersion): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

function satisfiesSet(version: ParsedVersion, comparators: Comparator[]): boolean {
  for (const comparator of comparators) {
    if (!testComparator(version, comparator)) return false;
  }
  if (version.prerelease.length > 0) {
    const allowed = comparators.some(
      (comparator) =>
        comparator.version.prerelease.length > 0 && sameTuple(comparator.version, version),
    );
    if (!allowed) return false;
  }
  return true;
}

/**
 * Does `version` satisfy `range`? An unparseable version is never satisfied; an
 * unparseable range is treated as "any" so a typo in a descriptor cannot brick
 * an otherwise working plugin (the host reports it separately).
 */
export function satisfies(version: string, range: string | undefined | null): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  if (range === undefined || range === null) return true;

  const trimmed = range.trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "x" || trimmed === "latest") return true;

  const alternatives = trimmed.split("||");
  let sawValidSet = false;
  for (const alternative of alternatives) {
    const tokens = alternative
      .trim()
      .split(/[\s,]+/)
      .filter((token) => token !== "");
    if (tokens.length === 0) continue;
    const comparators: Comparator[] = [];
    let valid = true;
    for (const token of tokens) {
      const expanded = expand(token);
      if (!expanded) {
        valid = false;
        break;
      }
      comparators.push(...expanded);
    }
    if (!valid) continue;
    sawValidSet = true;
    if (satisfiesSet(parsed, comparators)) return true;
  }
  return !sawValidSet;
}
