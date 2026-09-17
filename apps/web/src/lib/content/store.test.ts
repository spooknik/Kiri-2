import path from "node:path";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chapterDir,
  chapterDirName,
  chapterFilePath,
  coversDir,
  ensureDir,
  getDataRoot,
  libraryDir,
  manifestPath,
  pluginsDir,
  readJsonFile,
  removeChapterDir,
  removeDirSafe,
  removeLibraryDir,
  resolveInside,
  tmpDir,
  uploadsDir,
  writeFileAtomic,
} from "./store";
import { resetEnvCache } from "@/lib/env";

const DATA_ROOT = path.resolve(process.cwd(), "data", `test-store-${process.pid}`);

beforeEach(() => {
  process.env.DATA_ROOT = DATA_ROOT;
  resetEnvCache();
});

afterEach(async () => {
  await rm(DATA_ROOT, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

describe("getDataRoot", () => {
  it("resolves DATA_ROOT to an absolute path", () => {
    expect(path.isAbsolute(getDataRoot())).toBe(true);
    expect(getDataRoot()).toBe(DATA_ROOT);
  });
});

describe("resolveInside", () => {
  it("joins segments below the base", () => {
    expect(resolveInside(DATA_ROOT, "covers", "abc")).toBe(path.join(DATA_ROOT, "covers", "abc"));
  });

  it("allows the base itself", () => {
    expect(resolveInside(DATA_ROOT)).toBe(DATA_ROOT);
  });

  it("throws when a segment escapes the base", () => {
    expect(() => resolveInside(DATA_ROOT, "..", "etc")).toThrow(/outside/);
    expect(() => resolveInside(DATA_ROOT, "covers", "..", "..", "secrets")).toThrow(/outside/);
  });

  it("throws for an absolute segment", () => {
    const elsewhere = path.resolve(path.parse(DATA_ROOT).root, "elsewhere");
    expect(() => resolveInside(DATA_ROOT, elsewhere)).toThrow(/outside/);
  });

  it("throws for a null byte", () => {
    expect(() => resolveInside(DATA_ROOT, "cover\0.webp")).toThrow(/null byte/);
  });
});

describe("coversDir", () => {
  it("is one directory per series under DATA_ROOT/covers", () => {
    expect(coversDir("series-1")).toBe(path.join(DATA_ROOT, "covers", "series-1"));
  });

  it("sanitises traversal attempts instead of escaping", () => {
    expect(coversDir("../../etc")).toBe(path.join(DATA_ROOT, "covers", ".._.._etc"));
  });
});

describe("removeDirSafe", () => {
  it("removes a directory inside the store", async () => {
    const dir = coversDir("gone");
    await ensureDir(dir);
    await writeFile(path.join(dir, "cover.webp"), "x");
    await removeDirSafe(dir);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("is a no-op for a missing directory", async () => {
    await expect(removeDirSafe(coversDir("never-existed"))).resolves.toBeUndefined();
  });

  it("refuses the data root itself and anything outside it", async () => {
    await expect(removeDirSafe(DATA_ROOT)).rejects.toThrow(/outside the content store/);
    await expect(removeDirSafe(path.resolve(DATA_ROOT, ".."))).rejects.toThrow(
      /outside the content store/,
    );
  });
});

describe("library paths", () => {
  it("puts a series under DATA_ROOT/library", () => {
    expect(libraryDir("series-1")).toBe(path.join(DATA_ROOT, "library", "series-1"));
    expect(manifestPath("series-1")).toBe(
      path.join(DATA_ROOT, "library", "series-1", "manifest.json"),
    );
  });

  it("names a chapter directory after the sanitised slug", () => {
    expect(chapterDirName("chapter-1")).toBe("chapter-1");
    expect(chapterDirName("../../etc")).toBe(".._.._etc");
    expect(chapterDir("s", "chapter-1")).toBe(path.join(DATA_ROOT, "library", "s", "chapter-1"));
  });

  it("refuses an empty slug instead of collapsing to the series directory", () => {
    expect(() => chapterDirName("")).toThrow(/must not be empty/);
    expect(() => chapterDirName("   ")).toThrow(/must not be empty/);
    expect(() => chapterDir("s", "")).toThrow(/must not be empty/);
  });

  it("keeps a page file inside its chapter directory", () => {
    expect(chapterFilePath("s", "c", "001.webp")).toBe(
      path.join(DATA_ROOT, "library", "s", "c", "001.webp"),
    );
    expect(chapterFilePath("s", "c", "sub/001.webp")).toBe(
      path.join(DATA_ROOT, "library", "s", "c", "sub", "001.webp"),
    );
    expect(chapterFilePath("s", "c", "../../../etc/passwd")).toBe(
      path.join(DATA_ROOT, "library", "s", "c", "_", "_", "_", "etc", "passwd"),
    );
    expect(() => chapterFilePath("s", "c", "")).toThrow(/must not be empty/);
  });

  it("keeps plugins and scratch space under DATA_ROOT", () => {
    expect(pluginsDir()).toBe(path.join(DATA_ROOT, "plugins"));
    expect(tmpDir("job-1")).toBe(path.join(DATA_ROOT, "tmp", "job-1"));
    expect(uploadsDir()).toBe(path.join(DATA_ROOT, "tmp", "uploads"));
    expect(tmpDir("../escape")).toBe(path.join(DATA_ROOT, "tmp", ".._escape"));
  });
});

describe("writeFileAtomic", () => {
  it("creates the directory, writes the file and leaves no temp file behind", async () => {
    const target = manifestPath("atomic");
    await writeFileAtomic(target, '{"chapters":[]}');
    expect(await readFile(target, "utf8")).toBe('{"chapters":[]}');
    expect(await readdir(path.dirname(target))).toEqual(["manifest.json"]);
  });

  it("replaces an existing file", async () => {
    const target = manifestPath("atomic");
    await writeFileAtomic(target, "first");
    await writeFileAtomic(target, "second");
    expect(await readFile(target, "utf8")).toBe("second");
  });
});

describe("readJsonFile", () => {
  it("parses a JSON file", async () => {
    const target = manifestPath("json");
    await writeFileAtomic(target, JSON.stringify({ a: 1 }));
    expect(await readJsonFile(target)).toEqual({ a: 1 });
  });

  it("is null for a missing file", async () => {
    expect(await readJsonFile(manifestPath("missing"))).toBeNull();
  });

  it("throws for malformed JSON", async () => {
    const target = manifestPath("broken");
    await writeFileAtomic(target, "{ nope");
    await expect(readJsonFile(target)).rejects.toThrow(/not valid JSON/);
  });
});

describe("removeChapterDir / removeLibraryDir", () => {
  it("removes one chapter and then the whole series", async () => {
    const dir = chapterDir("series-9", "chapter-1");
    await ensureDir(dir);
    await writeFile(path.join(dir, "001.webp"), "x");
    await writeFileAtomic(manifestPath("series-9"), "{}");

    await removeChapterDir("series-9", "chapter-1");
    await expect(stat(dir)).rejects.toThrow();
    await expect(stat(manifestPath("series-9"))).resolves.toBeTruthy();

    await removeLibraryDir("series-9");
    await expect(stat(libraryDir("series-9"))).rejects.toThrow();
  });
});
