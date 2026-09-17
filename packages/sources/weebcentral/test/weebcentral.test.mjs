/**
 * End-to-end test of the WeebCentral plugin, spawned as a subprocess exactly
 * as the Kiri host spawns it, against a local fixture server built from HTML
 * recorded once from the live site (see `test/fixtures/`).
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  eventsOfType,
  makeTmpDir,
  readJsonFile,
  runPlugin,
  startFixtureServer,
} from "@kiri/source-sdk/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "index.mjs");

const SERIES_ID = "01M1RVH8101S8AMAE8WHDWQ8AK";
const SERIES_SLUG = "still-you";
// Newest-first, matching how WeebCentral lists them (and thus fixture order).
const CHAPTER_IDS = [
  "01M21JX38XTD2PBZXJ2HRTF6MR",
  "01M21JWW0WQF6WDWV1AZSGP5EP",
  "01M1RVJCXC2S6CEPE3Z7WS3GVE",
];

let server;
let seriesUrl;
let outputDir;

beforeAll(async () => {
  server = await startFixtureServer(path.join(here, "fixtures", "site"));
  seriesUrl = server.url(`series/${SERIES_ID}/${SERIES_SLUG}`);
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  outputDir = await makeTmpDir("kiri-weebcentral-");
  server.clearFailures();
  server.requests.length = 0;
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

function run(argv, env = {}) {
  return runPlugin(entry, argv, { env: { WEEBCENTRAL_BASE: server.baseUrl, ...env } });
}

function manifestFile() {
  return readJsonFile(path.join(outputDir, "manifest.json"));
}

function expectCleanProtocol(result) {
  expect(result.unparsed, `unexpected stdout: ${result.unparsed.join(" | ")}`).toEqual([]);
  expect(result.events[0]).toMatchObject({ t: "hello", v: 1, plugin: "weebcentral" });
}

describe("hello", () => {
  it("answers the handshake and exits 0", async () => {
    const result = await run(["hello"]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.hello).toMatchObject({ t: "hello", plugin: "weebcentral", version: "0.1.0" });
  });
});

describe("resolve", () => {
  it("resolves a series URL, pulling title/type/cover off the series page", async () => {
    const result = await run(["resolve", seriesUrl]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      handled: true,
      normalizedUrl: seriesUrl,
      slug: SERIES_SLUG,
      title: "Still You",
      mediaType: "MANGA",
      externalId: SERIES_ID,
    });
    expect(result.data.coverUrl).toBe(server.url("img/cover.png"));
  });

  it("resolves from the id alone and recovers the canonical slug from og:url", async () => {
    const result = await run(["resolve", server.url(`series/${SERIES_ID}`)]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      handled: true,
      normalizedUrl: seriesUrl,
      slug: SERIES_SLUG,
    });
  });

  it("declines a URL from another site without failing", async () => {
    const result = await run(["resolve", "https://example.com/series/other/thing"]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ handled: false });
  });

  it("declines a non-series path on its own host", async () => {
    const result = await run(["resolve", server.url("about")]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ handled: false });
  });

  it("exits 4 for a series that does not exist", async () => {
    const result = await run(["resolve", server.url("series/does-not-exist")]);
    expect(result.exitCode).toBe(4);
    expect(result.error?.code).toBe("NOT_FOUND");
  });
});

describe("discover", () => {
  it("merges the series page and the full chapter list, newest first", async () => {
    const result = await run(["discover", seriesUrl]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);

    const chapters = eventsOfType(result.events, "chapter");
    expect(chapters).toHaveLength(3);
    expect(chapters.map((event) => event.slug).sort()).toEqual([...CHAPTER_IDS].sort());
    expect(result.data).toMatchObject({ chapterCount: 3 });

    // Fetched the series page AND the (htmx) full chapter list.
    expect(server.requests).toContain(`/series/${SERIES_ID}/${SERIES_SLUG}`);
    expect(server.requests).toContain(`/series/${SERIES_ID}/full-chapter-list`);
  });
});

describe("sync", () => {
  it("downloads everything, writes manifest v2 with natural chapter numbering", async () => {
    const result = await run(["sync", seriesUrl, "--output", outputDir]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      chaptersTotal: 3,
      chaptersCompleted: 3,
      chaptersFailed: 0,
      pagesDownloaded: 9,
    });

    const manifest = await manifestFile();
    expect(manifest.version).toBe(2);
    expect(manifest.site).toBe("weebcentral");
    expect(manifest.series).toMatchObject({
      url: seriesUrl,
      slug: SERIES_SLUG,
      title: "Still You",
      id: SERIES_ID,
      mediaType: "MANGA",
      coverFile: "cover.png",
    });

    // The SDK orders by chapterOrder/number, parsed from "Chapter N" titles —
    // so the manifest is oldest-first regardless of site listing order.
    expect(
      manifest.chapters.map((chapter) => ({ slug: chapter.slug, number: chapter.number })),
    ).toEqual([
      { slug: "01M1RVJCXC2S6CEPE3Z7WS3GVE", number: 1 },
      { slug: "01M21JWW0WQF6WDWV1AZSGP5EP", number: 2 },
      { slug: "01M21JX38XTD2PBZXJ2HRTF6MR", number: 3 },
    ]);

    manifest.chapters.forEach((chapter, index) => {
      expect(chapter).toMatchObject({
        status: "completed",
        imageCount: 3,
        chapterOrder: index + 1,
        title: `Chapter ${index + 1}`,
        source: "plugin",
      });
      expect(chapter.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(chapter.images.map((image) => image.file)).toEqual(["001.png", "002.png", "003.png"]);
      for (const image of chapter.images) {
        expect(image.sha256).toHaveLength(64);
        expect(image.mime).toBe("image/png");
        expect(image.width).toBeGreaterThan(0);
      }
    });

    expect((await stat(path.join(outputDir, "cover.png"))).size).toBeGreaterThan(0);
    expect((await readdir(outputDir)).sort()).toEqual([
      ...CHAPTER_IDS.slice().sort(),
      "cover.png",
      "manifest.json",
    ]);
  });

  it("builds the images endpoint straight from the chapter id (no hx-get scrape)", async () => {
    await run(["sync", seriesUrl, "--output", outputDir, "--limit", "1"]);
    const imageRequests = server.requests.filter((request) => request.includes("/images"));
    expect(imageRequests).toEqual([`/chapters/${CHAPTER_IDS[2]}/images`]);
  });

  it("re-uses what is already on disk on a second run", async () => {
    await run(["sync", seriesUrl, "--output", outputDir]);
    const before = server.requests.length;

    const second = await run(["sync", seriesUrl, "--output", outputDir]);
    expect(second.exitCode).toBe(0);
    expect(second.data).toMatchObject({ chaptersCompleted: 3, pagesDownloaded: 0 });

    const requested = server.requests.slice(before);
    expect(requested.filter((entry) => entry.endsWith(".png"))).toEqual([]);
  });

  it("honours --limit", async () => {
    const result = await run(["sync", seriesUrl, "--output", outputDir, "--limit", "1"]);
    expect(result.data).toMatchObject({
      chaptersTotal: 3,
      chaptersCompleted: 1,
      pagesDownloaded: 3,
    });
  });

  it("checkpoints: one broken page fails only its chapter, and the retry heals it", async () => {
    server.fail(`/chapters/${CHAPTER_IDS[1]}/images`, 500);
    const first = await run(["sync", seriesUrl, "--output", outputDir]);
    expect(first.exitCode).toBe(0);
    expect(first.data).toMatchObject({ chaptersCompleted: 2, chaptersFailed: 1 });

    const failedManifest = await manifestFile();
    const failedChapter = failedManifest.chapters.find(
      (chapter) => chapter.slug === CHAPTER_IDS[1],
    );
    expect(failedChapter).toMatchObject({ status: "failed" });
    expect(failedChapter.lastError).toBeTruthy();

    server.clearFailures();
    const second = await run(["sync", seriesUrl, "--output", outputDir]);
    expect(second.exitCode).toBe(0);
    expect(second.data).toMatchObject({ chaptersCompleted: 3, chaptersFailed: 0 });

    const healed = await manifestFile();
    expect(healed.chapters.every((chapter) => chapter.status === "completed")).toBe(true);
  });
});

describe("verify", () => {
  it("confirms a healthy library", async () => {
    await run(["sync", seriesUrl, "--output", outputDir]);
    const result = await run(["verify", "--output", outputDir]);
    expectCleanProtocol(result);
    expect(result.data).toMatchObject({
      chaptersTotal: 3,
      chaptersCompleted: 3,
      pagesVerified: 9,
      pagesMissing: 0,
    });
  });
});
