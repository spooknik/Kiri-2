import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deriveChapterNumber,
  isLikelyNonChapterImageUrl,
  ManifestError,
  normalizeManifest,
  parseManifestFile,
} from "./manifest";

/** A manifest exactly as a V1 ripper wrote it (mangadex-ripper.mjs:788-877). */
const V1_MANIFEST = {
  version: 1,
  site: "mangadex",
  createdAt: "2024-05-01T10:00:00.000Z",
  updatedAt: "2024-05-02T10:00:00.000Z",
  series: {
    url: "https://mangadex.org/title/abc",
    slug: "a-test-series",
    title: "A Test Series",
    id: "abc",
  },
  chapters: [
    {
      slug: "chapter-1",
      chapterId: "c1",
      chapterOrder: 1,
      volume: "1",
      translatedLanguage: "en",
      externalUrl: null,
      url: "https://mangadex.org/chapter/c1",
      title: "Chapter 1",
      releaseDate: "2024-04-01T00:00:00.000Z",
      releaseDateText: "Apr 1, 2024",
      status: "completed",
      imageCount: 2,
      downloadedAt: "2024-05-01T11:00:00.000Z",
      images: [
        { index: 1, file: "001.webp", bytes: 1234, url: "https://cdn.example/1.png" },
        { index: 2, file: "002.webp", bytes: 4321, url: "https://cdn.example/2.png" },
      ],
      lastError: null,
      missingFromSource: false,
    },
    {
      slug: "chapter-2",
      chapterOrder: 2,
      title: "Chapter 2",
      status: "pending",
      imageCount: 0,
      downloadedAt: null,
      images: [],
      lastError: null,
      missingFromSource: true,
    },
  ],
};

describe("normalizeManifest (V1 shape)", () => {
  it("reads a V1 manifest without changes or warnings", () => {
    const { manifest, warnings } = normalizeManifest(V1_MANIFEST);

    expect(warnings).toEqual([]);
    expect(manifest.version).toBe(1);
    expect(manifest.site).toBe("mangadex");
    expect(manifest.series?.title).toBe("A Test Series");
    expect(manifest.chapters).toHaveLength(2);

    const [first, second] = manifest.chapters;
    expect(first?.slug).toBe("chapter-1");
    expect(first?.status).toBe("completed");
    expect(first?.chapterOrder).toBe(1);
    expect(first?.volume).toBe("1");
    expect(first?.downloadedAt).toBe("2024-05-01T11:00:00.000Z");
    expect(first?.images).toEqual([
      { index: 1, file: "001.webp", bytes: 1234, url: "https://cdn.example/1.png" },
      { index: 2, file: "002.webp", bytes: 4321, url: "https://cdn.example/2.png" },
    ]);
    // `lastError: null` degrades to "absent", it never becomes the string "null".
    expect(first?.lastError).toBeUndefined();
    expect(second?.missingFromSource).toBe(true);
    expect(second?.images).toEqual([]);
  });

  it("keeps the new v2 fields when a plugin writes them", () => {
    const { manifest } = normalizeManifest({
      version: 2,
      series: { mediaType: "MANHWA", coverFile: "cover.webp" },
      chapters: [
        {
          slug: "ch-1",
          externalId: "ext-1",
          number: 1.5,
          source: "pdf",
          images: [
            {
              index: 1,
              file: "p1.webp",
              width: 800,
              height: 1200,
              mime: "image/webp",
              sha256: "a",
            },
          ],
        },
      ],
    });

    expect(manifest.series?.mediaType).toBe("MANHWA");
    expect(manifest.series?.coverFile).toBe("cover.webp");
    const chapter = manifest.chapters[0];
    expect(chapter?.externalId).toBe("ext-1");
    expect(chapter?.number).toBe(1.5);
    expect(chapter?.source).toBe("pdf");
    expect(chapter?.images[0]).toEqual({
      index: 1,
      file: "p1.webp",
      width: 800,
      height: 1200,
      mime: "image/webp",
      sha256: "a",
    });
  });
});

describe("normalizeManifest (tolerance)", () => {
  it("degrades odd field values instead of failing", () => {
    const { manifest } = normalizeManifest({
      version: "3",
      chapters: [
        {
          // numeric ids are stringified, unknown statuses vanish
          slug: 12345,
          externalId: 999,
          status: "COMPLETED",
          source: "MANUAL",
          missingFromSource: "true",
          chapterOrder: "7",
          images: [{ index: "2", file: "b.png", bytes: "10" }],
        },
      ],
    });

    const chapter = manifest.chapters[0];
    expect(manifest.version).toBe(3);
    expect(chapter?.slug).toBe("12345");
    expect(chapter?.externalId).toBe("999");
    expect(chapter?.status).toBe("completed");
    expect(chapter?.source).toBe("manual");
    expect(chapter?.missingFromSource).toBe(true);
    expect(chapter?.chapterOrder).toBe(7);
    expect(chapter?.images[0]).toMatchObject({ index: 2, file: "b.png", bytes: 10 });
  });

  it("drops what cannot be used and says so", () => {
    const { manifest, warnings } = normalizeManifest({
      chapters: [
        { title: "no slug here", images: [] },
        "not an object",
        { slug: "ok", images: [{ index: 1, file: "a.png" }, { url: "https://x/y.png" }, null] },
        { slug: "ok", images: [] },
      ],
    });

    expect(manifest.chapters.map((chapter) => chapter.slug)).toEqual(["ok"]);
    expect(manifest.chapters[0]?.images).toHaveLength(1);
    expect(warnings).toEqual([
      "chapters[0] has no slug — skipped",
      "chapters[1] has no slug — skipped",
      'chapter "ok": 2 image(s) without a file name — skipped',
      'chapters[3] repeats slug "ok" — kept the first',
    ]);
  });

  it("keeps the first of two images that claim the same index", () => {
    const { manifest, warnings } = normalizeManifest({
      chapters: [
        {
          slug: "dup",
          images: [
            { index: 1, file: "first.png" },
            { index: 1, file: "second.png" },
          ],
        },
      ],
    });

    expect(manifest.chapters[0]?.images).toEqual([{ index: 1, file: "first.png" }]);
    expect(warnings[0]).toContain("duplicate image index 1");
  });

  it("sorts images by index and numbers unnumbered ones by position", () => {
    const { manifest } = normalizeManifest({
      chapters: [{ slug: "s", images: [{ index: 3, file: "c.png" }, { file: "a.png" }] }],
    });

    expect(manifest.chapters[0]?.images.map((image) => [image.index, image.file])).toEqual([
      [2, "a.png"],
      [3, "c.png"],
    ]);
  });

  it("warns about a placeholder URL but keeps the page (files win)", () => {
    const { manifest, warnings } = normalizeManifest({
      chapters: [
        {
          slug: "s",
          images: [
            {
              index: 1,
              file: "001.webp",
              url: "https://site.test/wp-content/themes/madara/images/dflazy.jpg",
            },
          ],
        },
      ],
    });

    expect(manifest.chapters[0]?.images).toHaveLength(1);
    expect(warnings[0]).toContain("placeholder or thumbnail");
  });

  it("treats a missing or non-array chapters key as empty", () => {
    expect(normalizeManifest({}).manifest.chapters).toEqual([]);
    expect(normalizeManifest({ chapters: "nope" }).manifest.chapters).toEqual([]);
  });

  it("refuses something that is not an object at all", () => {
    expect(() => normalizeManifest("nope")).toThrow(ManifestError);
    expect(() => normalizeManifest(null)).toThrow(ManifestError);
  });
});

describe("deriveChapterNumber", () => {
  it.each([
    [{ number: 12.5, chapterOrder: 3, slug: "chapter-1" }, 12.5],
    [{ chapterOrder: 3, slug: "chapter-1" }, 3],
    [{ chapterOrder: 0, slug: "prologue" }, 0],
    [{ slug: "chapter-12-5" }, 12.5],
    [{ slug: "chapter-12-25" }, 12.25],
    [{ slug: "chapter-12" }, 12],
    [{ slug: "ch-12" }, 12],
    [{ title: "Ch. 12.5" }, 12.5],
    [{ title: "Episode 3" }, 3],
    [{ slug: "vol-2-ch-7" }, 7],
    [{ title: "Vol 2 Ch 7 — The Duel" }, 7],
    [{ slug: "chapter-7", title: "Chapter 99" }, 7],
    [{ slug: "part-4" }, 4],
    [{ slug: "12.5" }, 12.5],
    [{ slug: "0007" }, 7],
  ])("derives %o as %s", (chapter, expected) => {
    expect(deriveChapterNumber(chapter)).toBe(expected);
  });

  it.each([
    [{ slug: "notice" }],
    [{ slug: "one-shot", title: "A Special" }],
    // A negative number is not a chapter number; fall through to the text.
    [{ number: -1, slug: "extra" }],
    // Not a chapter number either: too long to be one.
    [{ slug: "chapter-1234567" }],
    [{}],
  ])("gives up on %o", (chapter) => {
    expect(deriveChapterNumber(chapter)).toBeNull();
  });
});

describe("isLikelyNonChapterImageUrl", () => {
  it.each([
    "https://site.test/wp-content/themes/madara/images/dflazy.jpg",
    "https://site.test/wp-content/uploads/2023/07/cover-150x150.jpg",
    "https://site.test/wp-content/uploads/2023/07/cover.jpg?w=100&h=140",
  ])("flags %s", (url) => {
    expect(isLikelyNonChapterImageUrl(url)).toBe(true);
  });

  it.each([
    "https://cdn.example/chapter/1/001.png",
    "https://site.test/wp-content/uploads/2023/07/page-1200x1800.jpg",
    "not a url",
  ])("keeps %s", (url) => {
    expect(isLikelyNonChapterImageUrl(url)).toBe(false);
  });
});

describe("parseManifestFile", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kiri-manifest-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads and normalises a manifest from disk", async () => {
    const file = path.join(dir, "manifest.json");
    await writeFile(file, JSON.stringify(V1_MANIFEST));
    const { manifest } = await parseManifestFile(file);
    expect(manifest.chapters).toHaveLength(2);
  });

  it("throws for a missing manifest", async () => {
    await expect(parseManifestFile(path.join(dir, "nope.json"))).rejects.toThrow(ManifestError);
  });

  it("throws for malformed JSON rather than reporting an empty library", async () => {
    const file = path.join(dir, "broken.json");
    await writeFile(file, "{ not json");
    await expect(parseManifestFile(file)).rejects.toThrow(ManifestError);
  });
});
