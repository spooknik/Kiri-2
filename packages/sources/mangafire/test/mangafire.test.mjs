/**
 * End-to-end tests for the MangaFire plugin: the real plugin, spawned as a
 * subprocess exactly as the Kiri host spawns it, against a local fixture
 * server standing in for mangafire.to (via the `MANGAFIRE_BASE` override —
 * see `src/index.mjs`).
 *
 * Fixture provenance: mangafire.to is Cloudflare-gated, and an unauthenticated
 * request to it during authoring returned the Cloudflare interstitial (see
 * the "live smoke" note in the plugin's README) — so nothing under
 * `test/fixtures/` is a recording of real traffic. It is *synthesised* from
 * the shapes the ported V1 parser (`tools/mangafire-ripper/ripper.mjs` in the
 * Kiri 1.x repo) expects: an og:title/og:image series page, a `list-body`
 * chapter list, the `/ajax/read/<mangaId>/chapter/<n>` image JSON (`[url,
 * offset]` pairs — V1 never used the offset, and neither does this port), an
 * HTML fallback reader page, and a "Just a moment…" Cloudflare interstitial
 * served with a 200 status.
 */
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SDK_VERSION } from "@kiri/source-sdk";
import {
  eventsOfType,
  makeTmpDir,
  readJsonFile,
  runPlugin,
  startFixtureServer,
} from "@kiri/source-sdk/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const entry = path.join(pluginDir, "src", "index.mjs");

/* -------------------------------------------------------------------------- */
/* Tiny real PNGs — materialised at test time so the committed fixtures stay  */
/* text-only. Same technique as `packages/source-sdk/test/helpers/images.ts`. */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** A real, tiny, 8-bit RGB PNG — valid enough for the SDK's sniffer and
 * dimension parser, which is exactly what `listPages`/`downloadImage` exercise. */
function makePng(width, height, rgb = [1, 2, 3]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function writePng(file, width, height, rgb) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, makePng(width, height, rgb));
}

/* -------------------------------------------------------------------------- */
/* Fixture server                                                             */
/* -------------------------------------------------------------------------- */

let fixtureRoot;
let server;
let seriesUrl;
let langFilterUrl;
let challengeUrl;
let outputDir;

beforeAll(async () => {
  // Copy the (text-only, committed) fixtures into a scratch dir, then drop in
  // real PNG bytes at the paths the HTML/JSON fixtures reference.
  fixtureRoot = await makeTmpDir("kiri-mangafire-fixtures-");
  await cp(path.join(here, "fixtures"), fixtureRoot, { recursive: true });

  await writePng(path.join(fixtureRoot, "cover.png"), 60, 90, [10, 20, 30]);
  let tone = 0;
  for (const chapter of [1, 2, 3]) {
    for (const page of [1, 2, 3]) {
      tone += 1;
      await writePng(
        path.join(fixtureRoot, "images", "moonlit-atlas", `chapter-${chapter}`, `0${page}.png`),
        40 + page,
        60 + page,
        [tone, tone, tone],
      );
    }
  }

  server = await startFixtureServer(fixtureRoot);
  seriesUrl = server.url("manga/moonlit-atlas.k9f31");
  langFilterUrl = server.url("manga/lang-filter.z9k1");
  challengeUrl = server.url("manga/challenged.zz001");
});

afterAll(async () => {
  await server.close();
  await rm(fixtureRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  outputDir = await makeTmpDir("kiri-mangafire-out-");
  server.clearFailures();
  server.requests.length = 0;
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

/** `MANGAFIRE_BASE` is what makes the plugin treat the fixture server as "its" site. */
function run(argv, env = {}) {
  return runPlugin(entry, argv, {
    env: { MANGAFIRE_BASE: server.baseUrl, ...env },
    timeoutMs: 90_000,
  });
}

function manifestFile() {
  return readJsonFile(path.join(outputDir, "manifest.json"));
}

function expectCleanProtocol(result) {
  expect(result.unparsed, `unexpected stdout: ${result.unparsed.join(" | ")}`).toEqual([]);
  expect(result.events[0]).toMatchObject({
    t: "hello",
    v: 1,
    plugin: "mangafire",
    sdk: SDK_VERSION,
  });
}

describe("hello", () => {
  it("answers the handshake", async () => {
    const result = await run(["hello"]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.hello).toMatchObject({
      plugin: "mangafire",
      version: "0.1.0",
      sdk: SDK_VERSION,
    });
  });
});

describe("resolve", () => {
  it("resolves a MangaFire series URL", async () => {
    const result = await run(["resolve", seriesUrl]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      handled: true,
      normalizedUrl: seriesUrl,
      slug: "moonlit-atlas.k9f31",
      title: "Moonlit Atlas",
      mediaType: "MANGA",
      externalId: "k9f31",
    });
    expect(result.data.coverUrl).toBe(server.url("cover.png"));
  });

  it("declines a URL on another host", async () => {
    const result = await run(["resolve", "https://example.com/manga/other.xyz1"]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ handled: false });
  });

  it("declines a chapter URL (not a series URL)", async () => {
    const result = await run(["resolve", server.url("read/moonlit-atlas.k9f31/en/chapter-1")]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ handled: false });
  });

  it("reports NEEDS_CREDENTIAL for a Cloudflare challenge served with a 200 status", async () => {
    const result = await run(["resolve", challengeUrl]);
    expect(result.exitCode).toBe(3);
    expect(result.error).toMatchObject({ code: "NEEDS_CREDENTIAL", retryable: false });
  });
});

describe("discover", () => {
  it("lists every chapter, in the order the series page lists them", async () => {
    const result = await run(["discover", seriesUrl]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);

    // The fixture lists newest-first, like the real site; `discover` reports
    // raw `listChapters` order (only `sync`'s manifest is sorted by number).
    const chapters = eventsOfType(result.events, "chapter");
    expect(chapters.map((event) => event.slug)).toEqual(["chapter-3", "chapter-2", "chapter-1"]);
    expect(chapters[0]).toMatchObject({
      title: "Chapter 3: Horizon",
      number: 3,
      status: "pending",
    });
    expect(result.data).toMatchObject({ chapterCount: 3 });
  });

  it('filters chapters by the "language" setting (default "en")', async () => {
    const result = await run(["discover", langFilterUrl]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ chapterCount: 2 });
    const chapters = eventsOfType(result.events, "chapter");
    expect(chapters.map((event) => event.slug)).toEqual(["chapter-3", "chapter-1"]);
  });

  it("honours an explicit language setting", async () => {
    const result = await run(["discover", langFilterUrl], {
      KIRI_SETTINGS: JSON.stringify({ language: "ja" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ chapterCount: 1 });
    const chapters = eventsOfType(result.events, "chapter");
    expect(chapters.map((event) => event.slug)).toEqual(["chapter-2"]);
  });
});

describe("sync", () => {
  it("downloads every chapter via the AJAX image list and writes manifest v2", async () => {
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
    expect(manifest.site).toBe("mangafire");
    expect(manifest.series).toMatchObject({
      url: seriesUrl,
      slug: "moonlit-atlas.k9f31",
      title: "Moonlit Atlas",
      mediaType: "MANGA",
      id: "k9f31",
      coverFile: "cover.png",
    });
    // The manifest is ordered by chapterOrder (ascending), unlike raw discover order.
    expect(manifest.chapters.map((chapter) => chapter.slug)).toEqual([
      "chapter-1",
      "chapter-2",
      "chapter-3",
    ]);
    expect(manifest.chapters.map((chapter) => chapter.number)).toEqual([1, 2, 3]);

    for (const chapter of manifest.chapters) {
      expect(chapter).toMatchObject({ status: "completed", imageCount: 3, source: "plugin" });
      expect(chapter.releaseDate).toMatch(/^2024-03-\d{2}T00:00:00\.000Z$/);
      expect(chapter.images.map((image) => image.file)).toEqual(["001.png", "002.png", "003.png"]);
      for (const image of chapter.images) {
        expect(image.mime).toBe("image/png");
        expect(image.width).toBeGreaterThan(0);
        expect(image.height).toBeGreaterThan(0);
        expect(image.sha256).toHaveLength(64);
        const info = await stat(path.join(outputDir, chapter.slug, image.file));
        expect(info.size).toBe(image.bytes);
      }
    }

    expect((await stat(path.join(outputDir, "cover.png"))).size).toBeGreaterThan(0);
    expect(server.requests.some((request) => request.startsWith("/ajax/read/k9f31/chapter/"))).toBe(
      true,
    );
  });

  it("falls back to HTML scraping when the AJAX endpoint is unavailable", async () => {
    server.fail("/ajax/read/k9f31/chapter/2", 500);
    const result = await run(["sync", seriesUrl, "--output", outputDir, "--chapter", "chapter-2"]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ chaptersCompleted: 1, pagesDownloaded: 3 });

    const manifest = await manifestFile();
    const chapter2 = manifest.chapters.find((chapter) => chapter.slug === "chapter-2");
    expect(chapter2).toMatchObject({ status: "completed", imageCount: 3 });
    // Proof the HTML reader page (not just the AJAX endpoint) was fetched.
    expect(server.requests).toContain("/read/moonlit-atlas.k9f31/en/chapter-2");
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

  it("reports NEEDS_CREDENTIAL cleanly instead of crashing", async () => {
    const result = await run(["sync", challengeUrl, "--output", outputDir]);
    expect(result.exitCode).toBe(3);
    expect(result.error?.code).toBe("NEEDS_CREDENTIAL");
  });
});

describe("verify", () => {
  it("confirms a fully-downloaded series", async () => {
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
});

describe("Cloudflare 403 + cf-mitigated header", () => {
  it("is also caught by the SDK's own detection, independent of this plugin's check", async () => {
    const cfServer = await startFixtureServer(fixtureRoot, {
      headers: { "cf-mitigated": "challenge" },
    });
    try {
      cfServer.fail("/manga/moonlit-atlas.k9f31", 403);
      const result = await runPlugin(
        entry,
        ["resolve", cfServer.url("manga/moonlit-atlas.k9f31")],
        { env: { MANGAFIRE_BASE: cfServer.baseUrl }, timeoutMs: 90_000 },
      );
      expect(result.exitCode).toBe(3);
      expect(result.error?.code).toBe("NEEDS_CREDENTIAL");
    } finally {
      await cfServer.close();
    }
  });
});
