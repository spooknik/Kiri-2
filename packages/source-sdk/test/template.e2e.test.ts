/**
 * End-to-end test of the whole plugin ABI: the real template plugin, spawned as
 * a subprocess exactly as the Kiri host spawns it, against a local fixture site.
 *
 * It covers every verb, the event stream, the exit codes, the manifest and the
 * files on disk — including the checkpointing behaviour that lets a failed
 * chapter be retried without re-downloading the ones that worked.
 */
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Manifest } from "../src/manifest.js";
import type { ChapterEvent, ProgressEvent } from "../src/protocol.js";
import {
  eventsOfType,
  makeTmpDir,
  readJsonFile,
  runPlugin,
  startFixtureServer,
  type FixtureServer,
  type RunPluginResult,
} from "../src/testing.js";
import { SDK_VERSION } from "../src/version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.resolve(here, "..", "..", "source-template");
const entry = path.join(templateDir, "src", "index.mjs");

let server: FixtureServer;
let seriesUrl: string;
let outputDir: string;

beforeAll(async () => {
  server = await startFixtureServer(path.join(templateDir, "fixture-site"));
  seriesUrl = server.url("series/starlight-express/");
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  outputDir = await makeTmpDir("kiri-e2e-");
  server.clearFailures();
  server.requests.length = 0;
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

function run(argv: string[], env: Record<string, string> = {}): Promise<RunPluginResult> {
  return runPlugin(entry, argv, { env });
}

function manifestFile(): Promise<Manifest> {
  return readJsonFile<Manifest>(path.join(outputDir, "manifest.json"));
}

/** Every run must open with a valid hello and print nothing but protocol lines. */
function expectCleanProtocol(result: RunPluginResult): void {
  expect(result.unparsed, `unexpected stdout: ${result.unparsed.join(" | ")}`).toEqual([]);
  expect(result.events[0]).toMatchObject({
    t: "hello",
    v: 1,
    plugin: "template",
    sdk: SDK_VERSION,
  });
}

describe("hello", () => {
  it("answers the handshake and exits 0", async () => {
    const result = await run(["hello"]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.hello).toEqual({
      t: "hello",
      v: 1,
      plugin: "template",
      version: "0.1.0",
      sdk: SDK_VERSION,
    });
  });

  it("exits 7 when the host's SDK does not satisfy the descriptor range", async () => {
    const result = await run(["hello"], { KIRI_SDK_VERSION: "1.4.0" });
    // hello is still first, so the host can tell *which* plugin is incompatible.
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(7);
    expect(result.error?.message).toMatch(/requires @kiri\/source-sdk \^2\.0\.0-alpha\.0/);
    expect(result.error?.retryable).toBe(false);
  });

  it("accepts a newer compatible SDK", async () => {
    const result = await run(["hello"], { KIRI_SDK_VERSION: "2.4.1" });
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });
});

describe("usage", () => {
  it("exits 2 on an unknown verb", async () => {
    const result = await run(["frobnicate"]);
    expect(result.exitCode).toBe(2);
    expect(result.error?.message).toMatch(/Unknown verb/);
  });

  it("exits 2 when sync has no output directory", async () => {
    const result = await run(["sync", seriesUrl]);
    expect(result.exitCode).toBe(2);
    expect(result.error?.message).toMatch(/--output/);
  });
});

describe("resolve", () => {
  it("resolves a series URL", async () => {
    const result = await run(["resolve", seriesUrl]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      handled: true,
      normalizedUrl: seriesUrl,
      slug: "starlight-express",
      title: "Starlight Express",
      mediaType: "MANGA",
      externalId: "fixture-starlight-1",
    });
  });

  it("declines a URL from another site without failing", async () => {
    const result = await run(["resolve", "https://example.com/manga/other"]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ handled: false });
  });

  it("exits 4 for a series that does not exist", async () => {
    const result = await run(["resolve", server.url("series/nope/")]);
    expect(result.exitCode).toBe(4);
    expect(result.error?.code).toBe("NOT_FOUND");
  });
});

describe("discover", () => {
  it("emits one chapter event per chapter and a count", async () => {
    const result = await run(["discover", seriesUrl]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);

    const chapters = eventsOfType(result.events, "chapter");
    expect(chapters).toHaveLength(3);
    expect(chapters.map((event) => event.slug)).toEqual(["chapter-3", "chapter-2", "chapter-1"]);
    expect(chapters[0]).toMatchObject({
      title: "Chapter 3: Terminal",
      number: 3,
      status: "pending",
    });
    expect(result.data).toMatchObject({ chapterCount: 3 });
  });
});

describe("sync", () => {
  it("downloads everything, writes manifest v2 and the cover", async () => {
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
    expect(manifest.site).toBe("template");
    expect(manifest.series).toMatchObject({
      url: seriesUrl,
      slug: "starlight-express",
      title: "Starlight Express",
      mediaType: "MANGA",
      id: "fixture-starlight-1",
      coverFile: "cover.png",
    });
    expect(new Date(manifest.updatedAt).getTime()).toBeGreaterThan(0);

    // The fixture lists chapters newest-first; the manifest is ordered.
    expect(manifest.chapters.map((chapter) => chapter.slug)).toEqual([
      "chapter-1",
      "chapter-2",
      "chapter-3",
    ]);

    for (const chapter of manifest.chapters) {
      expect(chapter).toMatchObject({ status: "completed", imageCount: 3, source: "plugin" });
      expect(chapter.downloadedAt).toBeTruthy();
      expect(chapter.lastError).toBeUndefined();
      expect(chapter.externalId).toMatch(/^c\d$/);
      expect(chapter.volume).toBe("1");
      expect(chapter.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(chapter.images.map((image) => image.file)).toEqual(["001.png", "002.png", "003.png"]);

      for (const image of chapter.images) {
        expect(image.sha256).toHaveLength(64);
        expect(image.bytes).toBeGreaterThan(0);
        expect(image.mime).toBe("image/png");
        expect(image.width).toBeGreaterThan(0);
        expect(image.height).toBeGreaterThan(0);
        const info = await stat(path.join(outputDir, chapter.slug, image.file));
        expect(info.size).toBe(image.bytes);
      }
    }

    expect((await stat(path.join(outputDir, "cover.png"))).size).toBeGreaterThan(0);
    expect((await readdir(outputDir)).sort()).toEqual([
      "chapter-1",
      "chapter-2",
      "chapter-3",
      "cover.png",
      "manifest.json",
    ]);
  });

  it("reports progress and chapter events while it works", async () => {
    const result = await run(["sync", seriesUrl, "--output", outputDir]);
    const progress = eventsOfType(result.events, "progress") as ProgressEvent[];
    expect(progress.some((event) => event.phase === "resolve")).toBe(true);
    expect(progress.some((event) => event.phase === "cover")).toBe(true);
    expect(progress.some((event) => event.phase === "discover")).toBe(true);
    expect(progress.filter((event) => event.phase === "chapter")).toHaveLength(3);

    const pageProgress = progress.filter((event) => event.phase === "page");
    expect(pageProgress).toHaveLength(9);
    expect(pageProgress.every((event) => event.total === 3)).toBe(true);
    expect(pageProgress.every((event) => (event.bytes ?? 0) > 0)).toBe(true);

    const chapters = eventsOfType(result.events, "chapter") as ChapterEvent[];
    expect(chapters.filter((event) => event.status === "downloading")).toHaveLength(3);
    expect(chapters.filter((event) => event.status === "completed")).toHaveLength(3);
  });

  it("re-uses what is already on disk on a second run", async () => {
    await run(["sync", seriesUrl, "--output", outputDir]);
    const before = server.requests.length;

    const second = await run(["sync", seriesUrl, "--output", outputDir]);
    expect(second.exitCode).toBe(0);
    expect(second.data).toMatchObject({ chaptersCompleted: 3, pagesDownloaded: 0 });

    // Only the series page was fetched again; no image and no cover.
    const requested = server.requests.slice(before);
    expect(requested.filter((entry) => entry.endsWith(".png"))).toEqual([]);
  });

  it("re-downloads everything with --force", async () => {
    await run(["sync", seriesUrl, "--output", outputDir]);
    const forced = await run(["sync", seriesUrl, "--output", outputDir, "--force"]);
    expect(forced.data).toMatchObject({ chaptersCompleted: 3, pagesDownloaded: 9 });
  });

  it("honours --limit", async () => {
    const result = await run(["sync", seriesUrl, "--output", outputDir, "--limit", "1"]);
    expect(result.data).toMatchObject({
      chaptersTotal: 3,
      chaptersCompleted: 1,
      pagesDownloaded: 3,
    });
    const manifest = await manifestFile();
    expect(manifest.chapters.map((chapter) => chapter.status)).toEqual([
      "completed",
      "pending",
      "pending",
    ]);
  });

  it("honours --chapter", async () => {
    const result = await run([
      "sync",
      seriesUrl,
      "--output",
      outputDir,
      "--chapter",
      "chapter-2",
      "--chapter",
      "chapter-3",
    ]);
    expect(result.data).toMatchObject({ chaptersCompleted: 2 });
    const manifest = await manifestFile();
    expect(manifest.chapters.map((chapter) => chapter.status)).toEqual([
      "pending",
      "completed",
      "completed",
    ]);
  });

  it("takes the output directory from KIRI_OUTPUT_DIR", async () => {
    const result = await run(["sync", seriesUrl], { KIRI_OUTPUT_DIR: outputDir });
    expect(result.exitCode).toBe(0);
    expect((await manifestFile()).chapters).toHaveLength(3);
  });

  it("checkpoints: one broken page fails only its chapter, and the retry is targeted", async () => {
    server.fail("/series/starlight-express/chapters/2/p02.png", 500);
    const first = await run(["sync", seriesUrl, "--output", outputDir]);

    // The run itself succeeds; the failure is recorded per chapter.
    expect(first.exitCode).toBe(0);
    expect(first.data).toMatchObject({ chaptersCompleted: 2, chaptersFailed: 1 });

    const failedManifest = await manifestFile();
    const [one, two, three] = failedManifest.chapters;
    expect(one?.status).toBe("completed");
    expect(three?.status).toBe("completed");
    expect(two).toMatchObject({ slug: "chapter-2", status: "failed", imageCount: 0 });
    expect(two?.lastError).toMatch(/HTTP 500/);
    // The chapters that worked are fully described, so nothing is re-fetched.
    expect(one?.images).toHaveLength(3);

    server.clearFailures();
    const before = server.requests.length;
    const second = await run(["sync", seriesUrl, "--output", outputDir]);

    expect(second.exitCode).toBe(0);
    expect(second.data).toMatchObject({
      chaptersCompleted: 3,
      chaptersFailed: 0,
      pagesDownloaded: 3,
    });

    const retried = server.requests.slice(before).filter((entry) => entry.endsWith(".png"));
    expect(retried.every((entry) => entry.includes("/chapters/2/"))).toBe(true);
    expect(retried).toHaveLength(3);

    const healed = await manifestFile();
    expect(healed.chapters.every((chapter) => chapter.status === "completed")).toBe(true);
    expect(healed.chapters[1]?.lastError).toBeUndefined();
  });

  it("exits 4 for a chapter slug that does not exist", async () => {
    const result = await run(["sync", seriesUrl, "--output", outputDir, "--chapter", "chapter-99"]);
    expect(result.exitCode).toBe(4);
    expect(result.error?.code).toBe("NOT_FOUND");
  });
});

describe("verify", () => {
  it("confirms a healthy library", async () => {
    await run(["sync", seriesUrl, "--output", outputDir]);
    const result = await run(["verify", "--output", outputDir]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      chaptersTotal: 3,
      chaptersCompleted: 3,
      chaptersFailed: 0,
      pagesVerified: 9,
      pagesMissing: 0,
    });
  });

  it("marks a chapter with a missing file as pending, and sync heals it", async () => {
    await run(["sync", seriesUrl, "--output", outputDir]);
    await rm(path.join(outputDir, "chapter-2", "002.png"));

    const verified = await run(["verify", "--output", outputDir]);
    expect(verified.data).toMatchObject({
      pagesVerified: 8,
      pagesMissing: 1,
      chaptersCompleted: 2,
    });

    const manifest = await manifestFile();
    expect(manifest.chapters[1]).toMatchObject({ slug: "chapter-2", status: "pending" });
    expect(manifest.chapters[1]?.lastError).toMatch(/1 of 3 files are missing/);

    const healed = await run(["sync", seriesUrl, "--output", outputDir]);
    expect(healed.data).toMatchObject({ chaptersCompleted: 3, pagesDownloaded: 1 });
    expect((await stat(path.join(outputDir, "chapter-2", "002.png"))).size).toBeGreaterThan(0);
  });
});
