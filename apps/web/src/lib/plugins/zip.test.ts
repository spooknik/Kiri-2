/**
 * Safe zip extraction. A plugin archive is untrusted input from the internet,
 * so these cases are the security boundary, not a formality: traversal,
 * absolute paths, symlinks, bombs — plus the GitHub wrapper folder every
 * "Download ZIP" produces.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildZip, type ZipEntry } from "../../../test/zip-fixture";
import { classifyEntry, commonRoot, extractZipSafely, ZipError } from "@/lib/plugins/zip";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "kiri-zip-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Write a zip built from `entries` and return its path. */
function writeZip(entries: ZipEntry[], name = "plugin.zip"): string {
  const file = path.join(root, name);
  writeFileSync(file, buildZip(entries));
  return file;
}

const DESCRIPTOR = text('{"id":"demo"}');

describe("classifyEntry", () => {
  it("accepts a plain relative path", () => {
    expect(classifyEntry("src/index.mjs")).toEqual({ ok: true, segments: ["src", "index.mjs"] });
  });

  it("normalises backslashes and drops redundant segments", () => {
    expect(classifyEntry("src\\./index.mjs")).toEqual({
      ok: true,
      segments: ["src", "index.mjs"],
    });
  });

  it("refuses traversal, absolute paths and drive letters", () => {
    expect(classifyEntry("../escape.txt")).toEqual({ ok: false, reason: "unsafe" });
    expect(classifyEntry("a/../../escape.txt")).toEqual({ ok: false, reason: "unsafe" });
    expect(classifyEntry("/etc/passwd")).toEqual({ ok: false, reason: "unsafe" });
    expect(classifyEntry("C:/windows/system32")).toEqual({ ok: false, reason: "unsafe" });
    expect(classifyEntry("a\0b")).toEqual({ ok: false, reason: "unsafe" });
  });

  it("reports directory entries separately", () => {
    expect(classifyEntry("src/")).toEqual({ ok: false, reason: "directory" });
  });
});

describe("commonRoot", () => {
  it("finds the single wrapper folder of a GitHub archive", () => {
    expect(
      commonRoot([
        ["repo-main", "kiri-plugin.json"],
        ["repo-main", "src", "index.mjs"],
      ]),
    ).toBe("repo-main");
  });

  it("is null when the root already holds a file", () => {
    expect(commonRoot([["kiri-plugin.json"], ["src", "index.mjs"]])).toBeNull();
  });

  it("is null when two folders share the root", () => {
    expect(
      commonRoot([
        ["a", "one.txt"],
        ["b", "two.txt"],
      ]),
    ).toBeNull();
  });
});

describe("extractZipSafely", () => {
  it("extracts a flat plugin archive", async () => {
    const zip = writeZip([
      { name: "kiri-plugin.json", data: DESCRIPTOR },
      { name: "src/index.mjs", data: text("export default 1;\n") },
      { name: "README.md", data: text("# demo\n") },
    ]);
    const dest = path.join(root, "out");

    const result = await extractZipSafely(zip, dest);

    expect(result.files).toBe(3);
    expect(result.strippedRoot).toBeNull();
    expect(readFileSync(path.join(dest, "kiri-plugin.json"), "utf8")).toBe('{"id":"demo"}');
    expect(existsSync(path.join(dest, "src", "index.mjs"))).toBe(true);
  });

  it("strips a single top-level folder (GitHub's Download ZIP)", async () => {
    const zip = writeZip([
      { name: "kiri-source-main/kiri-plugin.json", data: DESCRIPTOR },
      { name: "kiri-source-main/src/index.mjs", data: text("export default 1;\n") },
    ]);
    const dest = path.join(root, "out");

    const result = await extractZipSafely(zip, dest);

    expect(result.strippedRoot).toBe("kiri-source-main");
    expect(existsSync(path.join(dest, "kiri-plugin.json"))).toBe(true);
    expect(existsSync(path.join(dest, "kiri-source-main"))).toBe(false);
  });

  it("keeps a shared folder when the root also holds a file", async () => {
    const zip = writeZip([
      { name: "kiri-plugin.json", data: DESCRIPTOR },
      { name: "src/index.mjs", data: text("x") },
    ]);
    const dest = path.join(root, "out");
    const result = await extractZipSafely(zip, dest);
    expect(result.strippedRoot).toBeNull();
  });

  it("refuses an entry that escapes the destination", async () => {
    const zip = writeZip([
      { name: "kiri-plugin.json", data: DESCRIPTOR },
      { name: "../../evil.txt", data: text("pwned") },
    ]);
    const dest = path.join(root, "out");

    await expect(extractZipSafely(zip, dest)).rejects.toMatchObject({
      name: "ZipError",
      code: "UNSAFE_PATH",
    });
    // Nothing was written outside — and because the listing pass runs before
    // any write, nothing was written at all.
    expect(existsSync(path.join(root, "evil.txt"))).toBe(false);
    expect(existsSync(path.resolve(root, "..", "evil.txt"))).toBe(false);
  });

  it("refuses an absolute entry", async () => {
    const zip = writeZip([{ name: "/etc/passwd", data: text("root:x:0:0") }]);
    await expect(extractZipSafely(zip, path.join(root, "out"))).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
  });

  it("enforces the entry-count cap", async () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      name: `file-${index}.txt`,
      data: text(String(index)),
    }));
    await expect(
      extractZipSafely(writeZip(entries), path.join(root, "out"), { maxEntries: 5 }),
    ).rejects.toMatchObject({ code: "TOO_MANY_ENTRIES" });
  });

  it("enforces the per-entry cap", async () => {
    const zip = writeZip([{ name: "big.bin", data: text("x".repeat(2048)) }]);
    await expect(
      extractZipSafely(zip, path.join(root, "out"), { maxEntryBytes: 512 }),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("enforces the total cap", async () => {
    const zip = writeZip([
      { name: "a.bin", data: text("x".repeat(1024)) },
      { name: "b.bin", data: text("y".repeat(1024)) },
      { name: "c.bin", data: text("z".repeat(1024)) },
    ]);
    await expect(
      extractZipSafely(zip, path.join(root, "out"), { maxTotalBytes: 1500 }),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("rejects an empty archive", async () => {
    await expect(extractZipSafely(writeZip([]), path.join(root, "out"))).rejects.toMatchObject({
      code: "EMPTY",
    });
  });

  it("rejects a file that is not a zip at all", async () => {
    const notZip = path.join(root, "not.zip");
    writeFileSync(notZip, "just some text, definitely not a zip archive");
    await expect(extractZipSafely(notZip, path.join(root, "out"))).rejects.toBeInstanceOf(ZipError);
  });
});
