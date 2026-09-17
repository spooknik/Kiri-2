/**
 * Tests for the MangaDex content-source plugin.
 *
 * Two layers:
 *
 *  - Pure unit tests (no subprocess) against `../src/mangadex.mjs` — parsing,
 *    dedupe, URL building. The feed-pagination loop is exercised with a real
 *    `HttpClient` whose `fetchImpl` is mocked, so the *real* production
 *    pagination code runs against two distinct, scripted responses.
 *  - End-to-end subprocess tests via `runPlugin` + `startFixtureServer`,
 *    covering `resolve` / `discover` / `sync` / `verify` exactly as the Kiri
 *    host would run them.
 *
 * The fixture server (`@kiri/source-sdk/testing`) is a static file server: it
 * dispatches purely on the request *pathname* and ignores the query string.
 * The real MangaDex feed paginates via `?offset=`, which a static server
 * cannot answer differently per call — so the E2E fixtures use a single feed
 * page whose declared `total` equals its own length (a manga with fewer than
 * 500 chapters needs only one request in production too), and pagination
 * *itself* — including the "second page comes back empty" case — is verified
 * separately in the mocked-`HttpClient` unit test above.
 *
 * Similarly, the `translatedLanguage[]` query parameter can't be asserted by
 * inspecting what the static server received (it only records pathnames), so
 * the language setting is verified against `buildFeedUrl`/`languagesFrom`
 * directly instead of through the fixture server.
 *
 * `manga.json` and `feed.json` under `test/fixtures/` are real recorded
 * responses (`curl`) for a small public one-shot-ish series
 * (`c77d242d-437c-4a4a-aec3-06bf86a96821`, "Kagakubu Girl" / "Science
 * Department Girl"), chosen because three of its chapters have more than one
 * scanlation — real, live proof of the dedupe scenario this suite tests.
 * `at-home.chapter-*.json` are templated from a real recorded `/at-home/server`
 * response (`baseUrl` is a placeholder, substituted with the fixture server's
 * own address once it is listening). Page/cover images are tiny generated
 * PNGs, not downloaded ones.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HttpClient } from "@kiri/source-sdk";
import {
  eventsOfType,
  makeTmpDir,
  readJsonFile,
  runPlugin,
  startFixtureServer,
} from "@kiri/source-sdk/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  apiBaseFrom,
  buildChapterTitle,
  buildCoverUrl,
  buildFeedUrl,
  dedupeChapters,
  fetchAllChapters,
  findCoverFileName,
  languagesFrom,
  mapFeedEntry,
  mapMediaType,
  parseChapterOrder,
  parseMangaIdFromPath,
  pickPageFiles,
  pickSeriesTitle,
  selectLocalizedString,
  toChapterStub,
  uploadsBaseFrom,
} from "../src/mangadex.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..");
const entry = path.join(packageDir, "src", "index.mjs");
const fixturesDir = path.join(here, "fixtures");

/* -------------------------------------------------------------------------- */
/* Part 1 — pure unit tests                                                   */
/* -------------------------------------------------------------------------- */

const UUID_A = "11111111-1111-1111-8111-111111111111";
const UUID_B = "22222222-2222-1222-8222-222222222222";
const UUID_C = "33333333-3333-1333-8333-333333333333";

function feedEntry(id, chapterNumber, publishAt, extra = {}) {
  return {
    id,
    type: "chapter",
    attributes: {
      chapter: chapterNumber,
      volume: null,
      title: null,
      translatedLanguage: "en",
      externalUrl: null,
      publishAt,
      readableAt: publishAt,
      createdAt: publishAt,
      updatedAt: publishAt,
      ...extra,
    },
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("parseMangaIdFromPath", () => {
  it("accepts /title/<uuid>[/slug]", () => {
    expect(parseMangaIdFromPath(`/title/${UUID_A}/some-slug`)).toBe(UUID_A);
    expect(parseMangaIdFromPath(`/title/${UUID_A}`)).toBe(UUID_A);
  });

  it("accepts the legacy /manga/<uuid> shape", () => {
    expect(parseMangaIdFromPath(`/manga/${UUID_A}`)).toBe(UUID_A);
  });

  it("rejects anything else", () => {
    expect(parseMangaIdFromPath("/title/not-a-uuid")).toBeNull();
    expect(parseMangaIdFromPath("/chapter/" + UUID_A)).toBeNull();
    expect(parseMangaIdFromPath("/")).toBeNull();
  });
});

describe("pickSeriesTitle", () => {
  it("prefers attributes.title.en", () => {
    const title = pickSeriesTitle({ title: { en: "English Title", ja: "Other" } }, "fallback");
    expect(title).toBe("English Title");
  });

  it("falls back to altTitles in en, ja-ro, ja order", () => {
    const attributes = {
      title: { "ja-ro": "Romaji Title" },
      altTitles: [{ ja: "Japanese" }, { "ja-ro": "Alt Romaji" }, { en: "Alt English" }],
    };
    expect(pickSeriesTitle(attributes, "fallback")).toBe("Alt English");
  });

  it("falls back to the provided fallback when nothing matches", () => {
    expect(pickSeriesTitle({ title: {}, altTitles: [{ fr: "Francais" }] }, "fallback-id")).toBe(
      "fallback-id",
    );
  });
});

describe("selectLocalizedString", () => {
  it("prefers the earliest matching locale, then any non-empty value", () => {
    expect(selectLocalizedString({ ja: "Japanese", en: "English" })).toBe("English");
    expect(selectLocalizedString({ "ja-ro": "Romaji" })).toBe("Romaji");
    expect(selectLocalizedString({ fr: "Francais" })).toBe("Francais");
    expect(selectLocalizedString(null)).toBeNull();
    expect(selectLocalizedString({})).toBeNull();
  });
});

describe("mapMediaType", () => {
  it("maps originalLanguage to a Kiri mediaType", () => {
    expect(mapMediaType("ko")).toBe("MANHWA");
    expect(mapMediaType("zh")).toBe("MANHUA");
    expect(mapMediaType("zh-hk")).toBe("MANHUA");
    expect(mapMediaType("ja")).toBe("MANGA");
    expect(mapMediaType(undefined)).toBe("MANGA");
  });
});

describe("cover helpers", () => {
  it("finds the cover_art relationship and builds the 512px thumbnail URL", () => {
    const relationships = [
      { type: "author", attributes: { name: "Someone" } },
      { type: "cover_art", attributes: { fileName: "abc.png" } },
    ];
    expect(findCoverFileName(relationships)).toBe("abc.png");
    expect(buildCoverUrl("https://uploads.mangadex.org", UUID_A, "abc.png")).toBe(
      `https://uploads.mangadex.org/covers/${UUID_A}/abc.png.512.jpg`,
    );
  });

  it("is undefined when there is no cover_art relationship", () => {
    expect(findCoverFileName([])).toBeUndefined();
    expect(buildCoverUrl("https://uploads.mangadex.org", UUID_A, undefined)).toBeUndefined();
  });
});

describe("parseChapterOrder", () => {
  it("parses integers and decimals", () => {
    expect(parseChapterOrder("12")).toBe(12);
    expect(parseChapterOrder("12.5")).toBe(12.5);
  });

  it("pulls a number out of noisy text", () => {
    expect(parseChapterOrder("Extra 3.5")).toBe(3.5);
  });

  it("is undefined for anything without a number", () => {
    expect(parseChapterOrder("")).toBeUndefined();
    expect(parseChapterOrder(undefined)).toBeUndefined();
    expect(parseChapterOrder("oneshot")).toBeUndefined();
  });
});

describe("buildChapterTitle", () => {
  it("combines number and title, or falls back", () => {
    expect(buildChapterTitle("5", "Homecoming", UUID_A)).toBe("Chapter 5: Homecoming");
    expect(buildChapterTitle("5", null, UUID_A)).toBe("Chapter 5");
    expect(buildChapterTitle(null, "Homecoming", UUID_A)).toBe("Homecoming");
    expect(buildChapterTitle(null, null, UUID_A)).toBe(`Chapter ${UUID_A.slice(0, 8)}`);
  });
});

describe("mapFeedEntry", () => {
  it("maps a well-formed entry", () => {
    const mapped = mapFeedEntry(
      feedEntry(UUID_A, "5", "2024-01-01T00:00:00Z", { volume: "2", title: "Foo" }),
    );
    expect(mapped).toMatchObject({
      chapterId: UUID_A,
      number: 5,
      volume: "2",
      title: "Chapter 5: Foo",
      publishAt: "2024-01-01T00:00:00Z",
      url: `https://mangadex.org/chapter/${UUID_A}`,
    });
  });

  it("skips external chapters and malformed entries", () => {
    expect(mapFeedEntry(null)).toBeNull();
    expect(mapFeedEntry({ id: "not-a-uuid", attributes: {} })).toBeNull();
    expect(mapFeedEntry({ id: UUID_A })).toBeNull();
    expect(
      mapFeedEntry(
        feedEntry(UUID_A, "5", "2024-01-01T00:00:00Z", { externalUrl: "https://example.com" }),
      ),
    ).toBeNull();
  });
});

describe("dedupeChapters", () => {
  it("keeps the earliest publishAt when two scanlations share a number", () => {
    const raw = [
      mapFeedEntry(feedEntry(UUID_A, "1", "2024-01-02T00:00:00Z")), // later
      mapFeedEntry(feedEntry(UUID_B, "1", "2024-01-01T00:00:00Z")), // earlier — wins
      mapFeedEntry(feedEntry(UUID_C, "2", "2024-01-03T00:00:00Z")),
    ];
    const deduped = dedupeChapters(raw);
    expect(deduped).toHaveLength(2);
    const chapterOne = deduped.find((chapter) => chapter.number === 1);
    expect(chapterOne.chapterId).toBe(UUID_B);
  });

  it("keeps a tie on the first entry seen", () => {
    const raw = [
      mapFeedEntry(feedEntry(UUID_A, "1", "2024-01-01T00:00:00Z")),
      mapFeedEntry(feedEntry(UUID_B, "1", "2024-01-01T00:00:00Z")),
    ];
    expect(dedupeChapters(raw)[0].chapterId).toBe(UUID_A);
  });

  it("never merges chapters with no parseable number", () => {
    const raw = [
      mapFeedEntry(feedEntry(UUID_A, null, "2024-01-01T00:00:00Z")),
      mapFeedEntry(feedEntry(UUID_B, null, "2024-01-02T00:00:00Z")),
    ];
    expect(dedupeChapters(raw)).toHaveLength(2);
  });
});

describe("toChapterStub", () => {
  it("slugs numbered chapters by number, decimals become dashes", () => {
    const stub = toChapterStub(mapFeedEntry(feedEntry(UUID_A, "3.5", "2024-01-01T00:00:00Z")));
    expect(stub).toMatchObject({ slug: "chapter-3-5", number: 3.5, chapterOrder: 3.5 });
    expect(stub.releaseDate).toBe("2024-01-01T00:00:00.000Z");
  });

  it("falls back to the chapter id when there is no number", () => {
    const stub = toChapterStub(mapFeedEntry(feedEntry(UUID_A, null, "2024-01-01T00:00:00Z")));
    expect(stub.slug).toBe(`chapter-${UUID_A.slice(0, 8)}`);
  });
});

describe("buildFeedUrl", () => {
  it("encodes the language filter, content ratings and excludes external chapters", () => {
    const url = new URL(
      buildFeedUrl("https://api.mangadex.org", UUID_A, {
        offset: 0,
        limit: 500,
        languages: ["en", "fr"],
      }),
    );
    expect(url.pathname).toBe(`/manga/${UUID_A}/feed`);
    expect(url.searchParams.getAll("translatedLanguage[]")).toEqual(["en", "fr"]);
    expect(url.searchParams.getAll("contentRating[]")).toEqual([
      "safe",
      "suggestive",
      "erotica",
      "pornographic",
    ]);
    expect(url.searchParams.get("order[chapter]")).toBe("asc");
    expect(url.searchParams.get("includeExternalUrl")).toBe("0");
  });
});

describe("apiBaseFrom / uploadsBaseFrom / languagesFrom", () => {
  it("default to the real MangaDex hosts", () => {
    expect(apiBaseFrom({}, {})).toBe("https://api.mangadex.org");
    expect(uploadsBaseFrom({}, {})).toBe("https://uploads.mangadex.org");
    expect(languagesFrom({})).toEqual(["en"]);
  });

  it("settings override the base URLs and language list", () => {
    expect(apiBaseFrom({ apiBase: "http://127.0.0.1:9/" }, {})).toBe("http://127.0.0.1:9");
    expect(uploadsBaseFrom({ uploadsBase: "http://127.0.0.1:9/" }, {})).toBe("http://127.0.0.1:9");
    expect(languagesFrom({ language: "en, es , fr" })).toEqual(["en", "es", "fr"]);
  });

  it("falls back to MANGADEX_API_BASE / MANGADEX_UPLOADS_BASE", () => {
    const env = {
      MANGADEX_API_BASE: "http://api.test",
      MANGADEX_UPLOADS_BASE: "http://uploads.test",
    };
    expect(apiBaseFrom({}, env)).toBe("http://api.test");
    expect(uploadsBaseFrom({}, env)).toBe("http://uploads.test");
  });
});

describe("pickPageFiles", () => {
  const payload = {
    result: "ok",
    baseUrl: "https://cdn.test/",
    chapter: { hash: "h", data: ["1.png"], dataSaver: ["1.jpg"] },
  };

  it("picks the normal file list by default", () => {
    expect(pickPageFiles(payload, false)).toMatchObject({
      baseUrl: "https://cdn.test",
      mode: "data",
      files: ["1.png"],
    });
  });

  it("picks the data-saver file list when requested", () => {
    expect(pickPageFiles(payload, true)).toMatchObject({ mode: "data-saver", files: ["1.jpg"] });
  });

  it("throws PARSE when the payload is missing baseUrl/hash/files", () => {
    expect(() => pickPageFiles({ result: "ok" }, false)).toThrow(/baseUrl\/hash/);
    expect(() =>
      pickPageFiles({ result: "ok", baseUrl: "x", chapter: { hash: "h", data: [] } }, false),
    ).toThrow(/no image files/);
  });
});

describe("fetchAllChapters pagination", () => {
  it("stops on an empty page after a total larger than the first page, and dedupe spans both pages", async () => {
    const calls = [];
    const http = new HttpClient({
      requestsPerSecond: 0,
      retries: 0,
      jitterMs: 0,
      delayMs: 0,
      fetchImpl: async (input) => {
        calls.push(input);
        const offset = Number(new URL(input).searchParams.get("offset"));
        if (offset === 0) {
          return jsonResponse({
            result: "ok",
            total: 4,
            data: [
              feedEntry(UUID_A, "1", "2024-01-02T00:00:00Z"), // later scanlation of chapter 1
              feedEntry(UUID_B, "1", "2024-01-01T00:00:00Z"), // earlier — should win
              feedEntry(UUID_C, "2", "2024-01-03T00:00:00Z"),
            ],
          });
        }
        if (offset === 3) {
          // The second page: empty, terminating the loop via data.length === 0.
          return jsonResponse({ result: "ok", total: 4, data: [] });
        }
        throw new Error(`unexpected offset ${offset}`);
      },
    });

    const raw = await fetchAllChapters(http, "https://api.mangadex.test", UUID_A, ["en"]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]).searchParams.get("offset")).toBe("0");
    expect(new URL(calls[1]).searchParams.get("offset")).toBe("3");
    expect(raw).toHaveLength(3);

    const deduped = dedupeChapters(raw);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((chapter) => chapter.number === 1).chapterId).toBe(UUID_B);
  });

  it("stops as soon as offset reaches total, without a second request", async () => {
    let calls = 0;
    const http = new HttpClient({
      requestsPerSecond: 0,
      retries: 0,
      jitterMs: 0,
      delayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({
          result: "ok",
          total: 1,
          data: [feedEntry(UUID_A, "1", "2024-01-01T00:00:00Z")],
        });
      },
    });
    const raw = await fetchAllChapters(http, "https://api.mangadex.test", UUID_A, ["en"]);
    expect(calls).toBe(1);
    expect(raw).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Part 2 — end-to-end subprocess tests                                       */
/* -------------------------------------------------------------------------- */

const MANGA_ID = "c77d242d-437c-4a4a-aec3-06bf86a96821";
const EMPTY_MANGA_ID = "00000000-0000-1000-8000-000000000099";
const MISSING_MANGA_ID = "99999999-9999-1999-8999-999999999999";
const COVER_FILE_NAME = "a675a647-2b02-4189-8968-d759323e9421.png";

// The earliest-publishAt scanlation of chapter 1, per the recorded feed.json
// (ec974c4f... publishAt 2023-07-12T19:11:51Z beats edaf4c93...'s 07-18).
const CHAPTER_1_ID = "ec974c4f-85bd-4395-bb0c-bd81c95b5695";
const CHAPTER_1_HASH = "f478c66ecb50c5a0e02fee8e78f84341";
const CHAPTER_3_ID = "a64b9653-14f7-4ead-9f24-1544aa2d5483";
const CHAPTER_3_HASH = "35c1c2f2b8b3f1a2c9d4e5f60718293a";

const SERIES_URL = `https://mangadex.org/title/${MANGA_ID}/kagakubu-girl`;

// The smallest valid PNG: an 89 50 4e 47 ... 1x1 pixel, base64-encoded.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function writePages(root, mode, hash, files) {
  const dir = path.join(root, mode, hash);
  await mkdir(dir, { recursive: true });
  for (const file of files) await writeFile(path.join(dir, file), TINY_PNG);
}

/**
 * Build the fixture server's document root. `/manga/<id>` and
 * `/manga/<id>/feed` share a path prefix, so `<id>` must be a *directory*
 * containing `index.html` (the fixture server's directory rule) alongside a
 * sibling `feed` file — the same trick the SDK's own fixture-site README
 * documents for `startFixtureServer`.
 */
async function buildFixtureRoot() {
  const root = await makeTmpDir("kiri-mangadex-fixture-");

  const mangaDir = path.join(root, "manga", MANGA_ID);
  await mkdir(mangaDir, { recursive: true });
  await writeFile(
    path.join(mangaDir, "index.html"),
    await readFile(path.join(fixturesDir, "manga.json")),
  );
  await writeFile(path.join(mangaDir, "feed"), await readFile(path.join(fixturesDir, "feed.json")));

  const emptyDir = path.join(root, "manga", EMPTY_MANGA_ID);
  await mkdir(emptyDir, { recursive: true });
  await writeFile(
    path.join(emptyDir, "index.html"),
    await readFile(path.join(fixturesDir, "manga-empty.json")),
  );
  await writeFile(
    path.join(emptyDir, "feed"),
    await readFile(path.join(fixturesDir, "feed-empty.json")),
  );

  const coverDir = path.join(root, "covers", MANGA_ID);
  await mkdir(coverDir, { recursive: true });
  await writeFile(path.join(coverDir, `${COVER_FILE_NAME}.512.jpg`), TINY_PNG);

  await writePages(root, "data", CHAPTER_1_HASH, ["page-1.png", "page-2.png", "page-3.png"]);
  await writePages(root, "data-saver", CHAPTER_1_HASH, [
    "saver-1.png",
    "saver-2.png",
    "saver-3.png",
  ]);
  await writePages(root, "data", CHAPTER_3_HASH, ["page-1.png", "page-2.png"]);
  await writePages(root, "data-saver", CHAPTER_3_HASH, ["saver-1.png", "saver-2.png"]);

  return root;
}

/** Write the at-home fixtures now that the server's own address is known. */
async function writeAtHomeFixtures(root, baseUrl) {
  const dir = path.join(root, "at-home", "server");
  await mkdir(dir, { recursive: true });
  for (const [chapterId, fixtureFile] of [
    [CHAPTER_1_ID, "at-home.chapter-1.json"],
    [CHAPTER_3_ID, "at-home.chapter-3.json"],
  ]) {
    const template = await readFile(path.join(fixturesDir, fixtureFile), "utf8");
    await writeFile(path.join(dir, chapterId), template.replace("__BASE_URL__", baseUrl));
  }
}

let root;
let server;
let outputDir;

beforeAll(async () => {
  root = await buildFixtureRoot();
  server = await startFixtureServer(root);
  await writeAtHomeFixtures(root, server.baseUrl);
});

afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  outputDir = await makeTmpDir("kiri-mangadex-e2e-");
  server.requests.length = 0;
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

function run(argv, settings = {}, extraEnv = {}) {
  const env = {
    KIRI_SETTINGS: JSON.stringify({
      apiBase: server.baseUrl,
      uploadsBase: server.baseUrl,
      ...settings,
    }),
    ...extraEnv,
  };
  return runPlugin(entry, argv, { env });
}

function manifestFile(dir = outputDir) {
  return readJsonFile(path.join(dir, "manifest.json"));
}

function expectCleanProtocol(result) {
  expect(result.unparsed, `unexpected stdout: ${result.unparsed.join(" | ")}`).toEqual([]);
  expect(result.events[0]).toMatchObject({ t: "hello", v: 1, plugin: "mangadex" });
}

describe("hello", () => {
  it("answers the handshake", async () => {
    const result = await run(["hello"]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.hello).toMatchObject({ plugin: "mangadex", version: "0.1.0" });
  });
});

describe("resolve", () => {
  it("resolves /title/<uuid>/<slug>", async () => {
    const result = await run(["resolve", SERIES_URL]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      handled: true,
      normalizedUrl: `https://mangadex.org/title/${MANGA_ID}`,
      slug: MANGA_ID,
      title: "Science Department Girl",
      mediaType: "MANGA",
      externalId: MANGA_ID,
    });
    expect(result.data.coverUrl).toBe(
      `${server.baseUrl}/covers/${MANGA_ID}/${COVER_FILE_NAME}.512.jpg`,
    );
  });

  it("resolves the legacy /manga/<uuid> shape", async () => {
    const result = await run(["resolve", `https://mangadex.org/manga/${MANGA_ID}`]);
    expect(result.data).toMatchObject({ handled: true, slug: MANGA_ID });
  });

  it("declines a foreign URL without failing", async () => {
    const result = await run(["resolve", "https://example.com/title/" + MANGA_ID]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ handled: false });
  });

  it("exits 4 for a manga id MangaDex does not have", async () => {
    const result = await run(["resolve", `https://mangadex.org/title/${MISSING_MANGA_ID}`]);
    expect(result.exitCode).toBe(4);
    expect(result.error?.code).toBe("NOT_FOUND");
  });
});

describe("discover", () => {
  it("dedupes ten raw feed entries down to seven chapters, keeping the earliest scanlation", async () => {
    const result = await run(["discover", SERIES_URL]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ chapterCount: 7 });

    const chapters = eventsOfType(result.events, "chapter");
    expect(chapters).toHaveLength(7);
    expect(chapters.map((chapter) => chapter.slug)).toEqual([
      "chapter-1",
      "chapter-2",
      "chapter-3",
      "chapter-4",
      "chapter-5",
      "chapter-6",
      "chapter-7",
    ]);
    // The recorded feed has two scanlations of chapter 1; the earlier
    // publishAt (ec974c4f..., "...Wants to Become Invisible") must win over
    // the later one (edaf4c93..., "...Who Wants to Be Invisible").
    expect(chapters[0]).toMatchObject({
      title: "Chapter 1: Science Club Girl Wants to Become Invisible",
      number: 1,
    });
  });

  it("throws PARSE when the source has no chapters in the configured language", async () => {
    const url = `https://mangadex.org/title/${EMPTY_MANGA_ID}`;
    const result = await run(["discover", url]);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe("PARSE");
  });
});

describe("sync", () => {
  it("downloads the requested chapters, writes the cover and a manifest v2", async () => {
    const result = await run([
      "sync",
      SERIES_URL,
      "--output",
      outputDir,
      "--chapter",
      "chapter-1",
      "--chapter",
      "chapter-3",
    ]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      chaptersTotal: 7,
      chaptersCompleted: 2,
      chaptersFailed: 0,
      pagesDownloaded: 5,
    });

    const manifest = await manifestFile();
    expect(manifest.version).toBe(2);
    expect(manifest.site).toBe("mangadex");
    expect(manifest.series).toMatchObject({
      slug: MANGA_ID,
      title: "Science Department Girl",
      mediaType: "MANGA",
    });
    expect(manifest.series.coverFile).toBe("cover.png");
    expect(manifest.chapters).toHaveLength(7);

    const chapterOne = manifest.chapters.find((chapter) => chapter.slug === "chapter-1");
    // externalId proves the dedupe kept the earlier-publishAt scanlation.
    expect(chapterOne).toMatchObject({
      externalId: CHAPTER_1_ID,
      status: "completed",
      imageCount: 3,
      volume: "1",
    });
    expect(chapterOne.images.map((image) => image.file)).toEqual(["001.png", "002.png", "003.png"]);
    for (const image of chapterOne.images) {
      expect(image.sha256).toHaveLength(64);
      expect(image.bytes).toBeGreaterThan(0);
      expect(image.mime).toBe("image/png");
    }

    const chapterThree = manifest.chapters.find((chapter) => chapter.slug === "chapter-3");
    expect(chapterThree).toMatchObject({
      externalId: CHAPTER_3_ID,
      status: "completed",
      imageCount: 2,
    });

    const untouched = manifest.chapters.filter(
      (chapter) => !["chapter-1", "chapter-3"].includes(chapter.slug),
    );
    expect(untouched.every((chapter) => chapter.status === "pending")).toBe(true);

    expect((await stat(path.join(outputDir, "cover.png"))).size).toBeGreaterThan(0);
  });

  it("re-uses what is already on disk on a second run", async () => {
    await run(["sync", SERIES_URL, "--output", outputDir, "--chapter", "chapter-3"]);
    const second = await run(["sync", SERIES_URL, "--output", outputDir, "--chapter", "chapter-3"]);
    expect(second.exitCode).toBe(0);
    expect(second.data).toMatchObject({ chaptersCompleted: 1, pagesDownloaded: 0 });
  });

  it("requests the data-saver path when the dataSaver setting is on", async () => {
    const result = await run(
      ["sync", SERIES_URL, "--output", outputDir, "--chapter", "chapter-3"],
      { dataSaver: true },
    );
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({ chaptersCompleted: 1 });

    const requested = server.requests.filter((entry) => entry.includes(`/${CHAPTER_3_HASH}/`));
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((entry) => entry.startsWith("/data-saver/"))).toBe(true);
    expect(requested.some((entry) => entry.startsWith("/data/"))).toBe(false);
  });

  it("exits 4 for an unknown chapter slug", async () => {
    const result = await run([
      "sync",
      SERIES_URL,
      "--output",
      outputDir,
      "--chapter",
      "chapter-999",
    ]);
    expect(result.exitCode).toBe(4);
    expect(result.error?.code).toBe("NOT_FOUND");
  });
});

describe("verify", () => {
  it("confirms a healthy download and leaves untouched chapters pending", async () => {
    await run([
      "sync",
      SERIES_URL,
      "--output",
      outputDir,
      "--chapter",
      "chapter-1",
      "--chapter",
      "chapter-3",
    ]);
    const result = await run(["verify", "--output", outputDir]);
    expectCleanProtocol(result);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      chaptersTotal: 7,
      chaptersCompleted: 2,
      pagesVerified: 5,
      pagesMissing: 0,
    });
  });

  it("notices a deleted page and sync heals it", async () => {
    await run(["sync", SERIES_URL, "--output", outputDir, "--chapter", "chapter-3"]);
    await rm(path.join(outputDir, "chapter-3", "002.png"));

    const verified = await run(["verify", "--output", outputDir]);
    expect(verified.data).toMatchObject({ pagesVerified: 1, pagesMissing: 1 });
    const manifest = await manifestFile();
    expect(manifest.chapters.find((chapter) => chapter.slug === "chapter-3")).toMatchObject({
      status: "pending",
    });

    const healed = await run(["sync", SERIES_URL, "--output", outputDir, "--chapter", "chapter-3"]);
    expect(healed.data).toMatchObject({ chaptersCompleted: 1, pagesDownloaded: 1 });
  });
});
