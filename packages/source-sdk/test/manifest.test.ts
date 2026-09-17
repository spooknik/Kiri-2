import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chapterDirName,
  createManifest,
  findChapter,
  MANIFEST_VERSION,
  manifestPath,
  mergeDiscoveredChapters,
  pageFileName,
  readManifest,
  sanitizePathSegment,
  writeManifest,
  type DiscoveredChapter,
  type Manifest,
  type ManifestChapter,
} from "../src/manifest.js";
import { makeTmpDir } from "../src/testing.js";

let dir: string;

beforeEach(async () => {
  dir = await makeTmpDir("kiri-manifest-");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function chapter(overrides: Partial<ManifestChapter> & { slug: string }): ManifestChapter {
  return {
    url: `https://example.com/${overrides.slug}`,
    title: overrides.slug,
    status: "pending",
    imageCount: 0,
    images: [],
    source: "plugin",
    ...overrides,
  };
}

function completed(slug: string, extra: Partial<ManifestChapter> = {}): ManifestChapter {
  return chapter({
    slug,
    status: "completed",
    imageCount: 2,
    downloadedAt: "2024-01-01T00:00:00.000Z",
    images: [
      { index: 1, url: "u1", file: "001.jpg", bytes: 10, sha256: "a" },
      { index: 2, url: "u2", file: "002.jpg", bytes: 20, sha256: "b" },
    ],
    ...extra,
  });
}

describe("path helpers", () => {
  it("replaces every character a filesystem rejects", () => {
    expect(chapterDirName('chapter <1>:"/\\|?*')).toBe("chapter _1________");
    expect(chapterDirName("chapter-12.5")).toBe("chapter-12.5");
    expect(chapterDirName("Ch 1 — Прощание")).toBe("Ch 1 — Прощание");
  });

  it("strips control characters", () => {
    const withControls = `chapter${String.fromCharCode(0)}-${String.fromCharCode(9)}1`;
    expect(chapterDirName(withControls)).toBe("chapter_-_1");
  });

  it("never produces an empty, dotted or reserved segment", () => {
    expect(chapterDirName("")).toBe("chapter");
    expect(chapterDirName("...")).toBe("chapter");
    expect(chapterDirName("chapter-1.")).toBe("chapter-1");
    expect(chapterDirName(" spaced ")).toBe("spaced");
    expect(chapterDirName("CON")).toBe("_CON");
    expect(sanitizePathSegment("", "fallback")).toBe("fallback");
    expect(chapterDirName("x".repeat(400)).length).toBeLessThanOrEqual(120);
  });

  it("pads page numbers to at least three digits", () => {
    expect(pageFileName(1, 3, ".jpg")).toBe("001.jpg");
    expect(pageFileName(12, 99, "png")).toBe("012.png");
    expect(pageFileName(7, 1200, ".webp")).toBe("0007.webp");
    expect(pageFileName(1, 0, ".jpg")).toBe("001.jpg");
  });
});

describe("read/write", () => {
  it("returns a default manifest when there is none", async () => {
    const manifest = await readManifest(dir, { site: "demo", series: { slug: "s", url: "u" } });
    expect(manifest).toMatchObject({
      version: MANIFEST_VERSION,
      site: "demo",
      chapters: [],
      series: { slug: "s", url: "u", title: "" },
    });
  });

  it("writes atomically and reads back", async () => {
    const manifest = createManifest({ site: "demo", series: { slug: "s", url: "u", title: "S" } });
    manifest.chapters.push(completed("chapter-1"));
    await writeManifest(dir, manifest);

    expect(await readdir(dir)).toEqual(["manifest.json"]);
    const raw = await readFile(manifestPath(dir), "utf8");
    expect(raw.endsWith("\n")).toBe(true);

    const roundTripped = await readManifest(dir);
    expect(roundTripped.chapters).toHaveLength(1);
    expect(findChapter(roundTripped, "chapter-1")?.images).toHaveLength(2);
    expect(roundTripped.updatedAt >= roundTripped.createdAt).toBe(true);
  });

  it("survives a truncated manifest from a hard kill", async () => {
    await writeFile(manifestPath(dir), '{"version":2,"chapters":[{"slug"');
    const manifest = await readManifest(dir, { site: "demo" });
    expect(manifest.chapters).toEqual([]);
    expect(manifest.site).toBe("demo");
  });

  it("tolerates a V1-shaped manifest", async () => {
    await writeFile(
      manifestPath(dir),
      JSON.stringify({
        version: 1,
        site: "mangadex",
        series: { url: "u", slug: "s", title: "T", id: "uuid" },
        chapters: [
          {
            slug: "chapter-1",
            url: "cu",
            title: "One",
            status: "completed",
            imageCount: 1,
            images: [{ index: 1, url: "iu", file: "001.jpg", bytes: 5, sha256: "x" }],
            lastError: null,
            downloadedAt: null,
          },
          { slug: "no-images" },
          "garbage",
        ],
      }),
    );
    const manifest = await readManifest(dir);
    expect(manifest.chapters).toHaveLength(2);
    expect(manifest.chapters[0]).toMatchObject({ slug: "chapter-1", status: "completed" });
    expect(manifest.chapters[0]?.lastError).toBeUndefined();
    expect(manifest.chapters[1]).toMatchObject({
      slug: "no-images",
      status: "pending",
      images: [],
    });
    expect(manifest.series.id).toBe("uuid");
  });
});

describe("mergeDiscoveredChapters", () => {
  const base = (chapters: ManifestChapter[]): Manifest => ({
    ...createManifest({ site: "demo" }),
    chapters,
  });

  const discovered = (slug: string, number: number): DiscoveredChapter => ({
    slug,
    url: `https://example.com/${slug}`,
    title: `Chapter ${number}`,
    number,
    chapterOrder: number,
  });

  it("adds new chapters as pending", () => {
    const merged = mergeDiscoveredChapters(base([]), [discovered("chapter-1", 1)]);
    expect(merged.chapters).toHaveLength(1);
    expect(merged.chapters[0]).toMatchObject({
      slug: "chapter-1",
      status: "pending",
      imageCount: 0,
      images: [],
      source: "plugin",
    });
  });

  it("keeps completed chapters and their images", () => {
    const merged = mergeDiscoveredChapters(base([completed("chapter-1")]), [
      { ...discovered("chapter-1", 1), title: "Renamed" },
      discovered("chapter-2", 2),
    ]);
    expect(merged.chapters[0]).toMatchObject({
      slug: "chapter-1",
      status: "completed",
      imageCount: 2,
      title: "Renamed",
      downloadedAt: "2024-01-01T00:00:00.000Z",
    });
    expect(merged.chapters[0]?.images).toHaveLength(2);
    expect(merged.chapters[1]?.status).toBe("pending");
  });

  it("flags vanished chapters instead of deleting them", () => {
    const merged = mergeDiscoveredChapters(
      base([completed("chapter-1", { number: 1 }), completed("chapter-2", { number: 2 })]),
      [discovered("chapter-1", 1)],
    );
    expect(merged.chapters).toHaveLength(2);
    expect(merged.chapters[0]?.missingFromSource).toBeUndefined();
    expect(merged.chapters[1]).toMatchObject({
      slug: "chapter-2",
      missingFromSource: true,
      status: "completed",
    });
    expect(merged.chapters[1]?.images).toHaveLength(2);
  });

  it("orders by chapterOrder even when the site lists newest first", () => {
    const merged = mergeDiscoveredChapters(base([]), [
      discovered("chapter-3", 3),
      discovered("chapter-10", 10),
      discovered("chapter-1", 1),
      { ...discovered("chapter-2-5", 2), number: 2.5, chapterOrder: 2.5 },
    ]);
    expect(merged.chapters.map((entry) => entry.slug)).toEqual([
      "chapter-1",
      "chapter-2-5",
      "chapter-3",
      "chapter-10",
    ]);
  });

  it("preserves discovery order when the source has no numbers", () => {
    const merged = mergeDiscoveredChapters(base([completed("old-one")]), [
      { slug: "b", url: "u" },
      { slug: "a", url: "u" },
    ]);
    expect(merged.chapters.map((entry) => entry.slug)).toEqual(["b", "a", "old-one"]);
  });

  it("matches on externalId when a slug changed", () => {
    const merged = mergeDiscoveredChapters(base([completed("chapter-1", { externalId: "c1" })]), [
      { ...discovered("chapter-01", 1), externalId: "c1" },
    ]);
    expect(merged.chapters).toHaveLength(1);
    expect(merged.chapters[0]).toMatchObject({
      slug: "chapter-01",
      status: "completed",
      imageCount: 2,
    });
  });

  it("resets a chapter left `downloading` by a killed run", () => {
    const merged = mergeDiscoveredChapters(base([chapter({ slug: "c1", status: "downloading" })]), [
      { slug: "c1", url: "u" },
    ]);
    expect(merged.chapters[0]?.status).toBe("pending");
  });

  it("keeps the failure reason of a failed chapter", () => {
    const merged = mergeDiscoveredChapters(
      base([chapter({ slug: "c1", status: "failed", lastError: "HTTP 500" })]),
      [{ slug: "c1", url: "u" }],
    );
    expect(merged.chapters[0]).toMatchObject({ status: "failed", lastError: "HTTP 500" });
  });

  it("does not mutate the input manifest", () => {
    const original = base([completed("chapter-1")]);
    const merged = mergeDiscoveredChapters(original, [discovered("chapter-2", 2)]);
    expect(original.chapters).toHaveLength(1);
    expect(merged.chapters).toHaveLength(2);
  });
});
