/**
 * Archive handling: page ordering, entry filtering and real extraction of a
 * ZIP built by the test itself (test/zip-fixture.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildZip, TINY_PNG } from "../../../test/zip-fixture";
import { resetEnvCache } from "@/lib/env";
import {
  ArchiveError,
  classifyArchiveEntry,
  extractArchiveImages,
  naturalCompare,
  sortImagesNaturally,
  type ExtractedImage,
} from "@/lib/uploads/archive";

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "kiri-archive-"));
  process.env.DATA_ROOT = root;
  resetEnvCache();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  resetEnvCache();
});

function image(name: string): ExtractedImage {
  return { path: `/tmp/${name}`, name, bytes: 1, ext: path.extname(name) };
}

describe("naturalCompare", () => {
  it("orders digit runs numerically, not lexically", () => {
    const names = ["10.jpg", "9.jpg", "1.jpg", "2.jpg", "21.jpg"];
    expect(names.sort(naturalCompare)).toEqual(["1.jpg", "2.jpg", "9.jpg", "10.jpg", "21.jpg"]);
  });

  it("treats zero padding as irrelevant to order", () => {
    expect(["007.png", "8.png", "0009.png"].sort(naturalCompare)).toEqual([
      "007.png",
      "8.png",
      "0009.png",
    ]);
  });

  it("keeps directories together and sorts inside them", () => {
    const names = ["ch2/1.jpg", "ch10/1.jpg", "ch1/2.jpg", "ch1/10.jpg", "ch1/1.jpg"];
    expect(names.sort(naturalCompare)).toEqual([
      "ch1/1.jpg",
      "ch1/2.jpg",
      "ch1/10.jpg",
      "ch2/1.jpg",
      "ch10/1.jpg",
    ]);
  });

  it("is case-insensitive but still total", () => {
    expect(naturalCompare("Page1.jpg", "page1.jpg")).not.toBe(0);
    expect(["b.jpg", "A.jpg"].sort(naturalCompare)).toEqual(["A.jpg", "b.jpg"]);
  });

  it("sorts long digit runs without losing precision", () => {
    const long = ["9999999999999999991.jpg", "9999999999999999990.jpg"];
    expect(long.sort(naturalCompare)).toEqual([
      "9999999999999999990.jpg",
      "9999999999999999991.jpg",
    ]);
  });

  it("sortImagesNaturally does not mutate its input", () => {
    const input = [image("2.jpg"), image("1.jpg")];
    const sorted = sortImagesNaturally(input);
    expect(sorted.map((i) => i.name)).toEqual(["1.jpg", "2.jpg"]);
    expect(input.map((i) => i.name)).toEqual(["2.jpg", "1.jpg"]);
  });
});

describe("classifyArchiveEntry", () => {
  it("accepts a plain image", () => {
    expect(classifyArchiveEntry("001.jpg")).toEqual({ ok: true, name: "001.jpg", ext: ".jpg" });
  });

  it("accepts an image in a folder and keeps the path as the sort key", () => {
    expect(classifyArchiveEntry("Chapter 1/002.WEBP")).toEqual({
      ok: true,
      name: "Chapter 1/002.WEBP",
      ext: ".webp",
    });
  });

  it.each([
    ["../../etc/passwd.jpg", "traversal"],
    ["a/../../b.jpg", "traversal"],
    ["/etc/passwd.jpg", "absolute"],
    ["C:/windows/system32/evil.png", "absolute"],
    ["..\\..\\evil.png", "traversal"],
    ["__MACOSX/001.jpg", "macos-metadata"],
    ["folder/__MACOSX/001.jpg", "macos-metadata"],
    [".hidden.jpg", "dotfile"],
    ["folder/.DS_Store", "dotfile"],
    ["ComicInfo.xml", "not-an-image"],
    ["notes.txt", "not-an-image"],
    ["folder/", "directory"],
  ])("rejects %s as %s", (name, reason) => {
    expect(classifyArchiveEntry(name)).toEqual({ ok: false, reason });
  });

  it("rejects an entry that declares more than the per-file limit", () => {
    expect(classifyArchiveEntry("big.jpg", 500 * 1024 * 1024)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });
});

describe("extractArchiveImages", () => {
  it("extracts only the images, in archive order, and reports their bytes", async () => {
    const zipPath = path.join(root, "chapter.cbz");
    writeFileSync(
      zipPath,
      buildZip([
        { name: "10.png", data: TINY_PNG },
        { name: "2.png", data: TINY_PNG },
        { name: "1.png", data: TINY_PNG },
        { name: "ComicInfo.xml", data: Buffer.from("<xml/>") },
        { name: "__MACOSX/._1.png", data: Buffer.from("junk") },
      ]),
    );
    const dest = path.join(root, "out");

    const images = await extractArchiveImages(zipPath, dest);

    expect(images.map((i) => i.name)).toEqual(["10.png", "2.png", "1.png"]);
    expect(images.every((i) => i.bytes === TINY_PNG.length)).toBe(true);
    expect(readdirSync(dest).sort()).toEqual([
      "entry-00000.png",
      "entry-00001.png",
      "entry-00002.png",
    ]);
    expect(sortImagesNaturally(images).map((i) => i.name)).toEqual(["1.png", "2.png", "10.png"]);
  });

  it("refuses an archive that contains a traversal entry", async () => {
    const zipPath = path.join(root, "evil.cbz");
    writeFileSync(
      zipPath,
      buildZip([
        { name: "safe.png", data: TINY_PNG },
        { name: "../escaped.png", data: TINY_PNG },
      ]),
    );
    const dest = path.join(root, "evil-out");

    // yauzl rejects the entry name itself, and we surface that as a bad
    // archive rather than quietly importing half of it.
    await expect(extractArchiveImages(zipPath, dest)).rejects.toMatchObject({
      name: "ArchiveError",
      code: "INVALID_ARCHIVE",
    });
    // Nothing outside the destination was created either way.
    expect(readdirSync(dest)).toEqual(["entry-00000.png"]);
  });

  it("reports a corrupt archive as INVALID_ARCHIVE", async () => {
    const zipPath = path.join(root, "broken.cbz");
    writeFileSync(zipPath, Buffer.from("this is definitely not a zip file"));

    await expect(extractArchiveImages(zipPath, path.join(root, "broken-out"))).rejects.toThrow(
      ArchiveError,
    );
  });

  it("calls back once per accepted file", async () => {
    const zipPath = path.join(root, "callback.cbz");
    writeFileSync(
      zipPath,
      buildZip([
        { name: "a.png", data: TINY_PNG },
        { name: "b.png", data: TINY_PNG },
      ]),
    );
    const seen: number[] = [];

    await extractArchiveImages(zipPath, path.join(root, "callback-out"), {
      onFile: (_image, count) => seen.push(count),
    });

    expect(seen).toEqual([1, 2]);
  });
});
