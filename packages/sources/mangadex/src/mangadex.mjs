/**
 * MangaDex-specific parsing and API glue — no SDK plugin wiring here.
 *
 * Kept separate from `index.mjs` so it can be unit-tested by importing it
 * directly (no subprocess, no `definePlugin` autorun). Ported from the Kiri
 * 1.x tool at `tools/mangadex-ripper/ripper.mjs`: the string-cleanup helpers
 * (`asString`, `selectLocalizedString`, `parseChapterOrder`,
 * `buildChapterTitle`) and the feed-pagination loop (`fetchAllChapters`,
 * modelled on V1's `discoverChaptersViaApi`) carry over almost verbatim.
 *
 * V1 did **not** fetch a cover, infer a media type or dedupe chapters sharing
 * a number across scanlation groups (it kept every chapter as its own
 * `chapter-<uuid>` directory, so a numeric collision was never possible).
 * This plugin's chapters are slugged `chapter-<number>`, so that dedupe is
 * new — see `dedupeChapters` below — and is required, not cosmetic: without
 * it two scanlations of "chapter 5" would both resolve to the slug
 * `chapter-5` and race to write the same directory.
 */
import { parseError } from "@kiri/source-sdk";

export const HOSTS = new Set(["mangadex.org", "www.mangadex.org"]);

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DEFAULT_API_BASE = "https://api.mangadex.org";
export const DEFAULT_UPLOADS_BASE = "https://uploads.mangadex.org";
export const DEFAULT_LANGUAGE = "en";

/** `safe | suggestive | erotica | pornographic` — the full MangaDex set. */
export const CONTENT_RATINGS = ["safe", "suggestive", "erotica", "pornographic"];

/** V1 used 500/page; the feed endpoint's maximum `limit`. */
export const FEED_PAGE_SIZE = 500;
/** Safety cap on pagination requests (matches V1). */
export const MAX_FEED_PAGES = 500;

/* -------------------------------------------------------------------------- */
/* String helpers (ported from ripper.mjs)                                    */
/* -------------------------------------------------------------------------- */

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

/** Only the entities MangaDex's own JSON has ever been seen to contain. */
function decodeHtmlEntities(value) {
  const namedMap = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", raquo: "»" };
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1]?.toLowerCase() === "x";
      const numeric = isHex
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(numeric) ? full : String.fromCodePoint(numeric);
    }
    return namedMap[entity.toLowerCase()] ?? full;
  });
}

/** Trim, decode, collapse whitespace; `null` for anything not a non-empty string. */
export function asString(value) {
  if (typeof value !== "string") return null;
  const normalized = normalizeWhitespace(decodeHtmlEntities(value));
  return normalized.length > 0 ? normalized : null;
}

/**
 * Pick one string out of a MangaDex "localized string" object
 * (`{ en: "...", ja: "..." }`), preferring `locales` in order and falling
 * back to the first non-empty value of any locale.
 */
export function selectLocalizedString(
  localizedValue,
  locales = ["en", "en-us", "en-gb", "ja-ro", "ja"],
) {
  if (!localizedValue || typeof localizedValue !== "object" || Array.isArray(localizedValue))
    return null;
  for (const locale of locales) {
    const candidate = asString(localizedValue[locale]);
    if (candidate) return candidate;
  }
  for (const value of Object.values(localizedValue)) {
    const candidate = asString(value);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Series title: `attributes.title.en` first, then `altTitles` searched in
 * `en`, `ja-ro`, `ja` order, then `fallback` (the manga id). Deliberately
 * strict (unlike {@link selectLocalizedString}'s "any locale" catch-all): a
 * manga with no English title at all should fall through to its
 * romanisation in `altTitles`, not to a random other language in `title`.
 */
export function pickSeriesTitle(attributes, fallback) {
  const primary = asString(attributes?.title?.en);
  if (primary) return primary;
  if (Array.isArray(attributes?.altTitles)) {
    for (const locale of ["en", "ja-ro", "ja"]) {
      for (const altTitle of attributes.altTitles) {
        const candidate = asString(altTitle?.[locale]);
        if (candidate) return candidate;
      }
    }
  }
  return fallback;
}

/** `originalLanguage` -> Kiri `mediaType`. */
export function mapMediaType(originalLanguage) {
  const lang = (originalLanguage || "").toLowerCase();
  if (lang === "ko") return "MANHWA";
  if (lang === "zh" || lang === "zh-hk") return "MANHUA";
  return "MANGA";
}

export function findCoverFileName(relationships) {
  const relationship = Array.isArray(relationships)
    ? relationships.find((entry) => entry?.type === "cover_art")
    : undefined;
  return asString(relationship?.attributes?.fileName) ?? undefined;
}

/** `.512.jpg` is MangaDex's 512px-wide cover thumbnail rendition. */
export function buildCoverUrl(uploadsBase, mangaId, fileName) {
  if (!fileName) return undefined;
  return `${uploadsBase}/covers/${mangaId}/${fileName}.512.jpg`;
}

export function parseChapterOrder(rawChapterValue) {
  if (typeof rawChapterValue !== "string") return undefined;
  const normalized = rawChapterValue.trim();
  if (!normalized) return undefined;
  const direct = Number.parseFloat(normalized);
  if (Number.isFinite(direct)) return direct;
  const match = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildChapterTitle(chapterNumber, chapterTitle, fallbackChapterId) {
  if (chapterNumber && chapterTitle) return `Chapter ${chapterNumber}: ${chapterTitle}`;
  if (chapterNumber) return `Chapter ${chapterNumber}`;
  if (chapterTitle) return chapterTitle;
  return `Chapter ${fallbackChapterId.slice(0, 8)}`;
}

/* -------------------------------------------------------------------------- */
/* URL parsing                                                                */
/* -------------------------------------------------------------------------- */

/** `/title/<uuid>[/slug]` and the legacy `/manga/<uuid>[...]` shape. */
export function parseMangaIdFromPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] !== "title" && parts[0] !== "manga") return null;
  const id = parts[1];
  return UUID_PATTERN.test(id) ? id.toLowerCase() : null;
}

/* -------------------------------------------------------------------------- */
/* Base URL overrides (tests point these at a fixture server)                 */
/* -------------------------------------------------------------------------- */

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function settingString(settings, key) {
  const value = settings?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The MangaDex REST API base. Overridable via the (undocumented, test-only)
 * `apiBase` setting or the `MANGADEX_API_BASE` environment variable, so tests
 * can point the plugin at a local fixture server instead of the real API.
 */
export function apiBaseFrom(settings, env = process.env) {
  const base = settingString(settings, "apiBase") ?? env?.MANGADEX_API_BASE ?? DEFAULT_API_BASE;
  return trimTrailingSlash(base);
}

/** Same idea as {@link apiBaseFrom}, for `uploads.mangadex.org`. */
export function uploadsBaseFrom(settings, env = process.env) {
  const base =
    settingString(settings, "uploadsBase") ?? env?.MANGADEX_UPLOADS_BASE ?? DEFAULT_UPLOADS_BASE;
  return trimTrailingSlash(base);
}

/** Comma-separated `language` setting -> a non-empty array of codes. */
export function languagesFrom(settings) {
  const raw = settingString(settings, "language") ?? DEFAULT_LANGUAGE;
  const languages = raw
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
  return languages.length > 0 ? languages : [DEFAULT_LANGUAGE];
}

/* -------------------------------------------------------------------------- */
/* Chapter feed                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One feed entry -> the fields we need, or `null` for a malformed entry or an
 * external chapter (MangaDex hosts no images for those; `includeExternalUrl=0`
 * already filters them server-side, this is the defensive fallback).
 */
export function mapFeedEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const chapterId = asString(entry.id);
  if (!chapterId || !UUID_PATTERN.test(chapterId)) return null;

  const attributes = entry.attributes;
  if (!attributes || typeof attributes !== "object") return null;
  if (asString(attributes.externalUrl)) return null;

  const rawChapterValue = asString(attributes.chapter);
  const number = parseChapterOrder(rawChapterValue ?? undefined);
  const chapterTitle = asString(attributes.title);
  const publishAt = asString(attributes.publishAt);

  return {
    chapterId,
    number,
    volume: asString(attributes.volume) ?? undefined,
    title: buildChapterTitle(rawChapterValue, chapterTitle, chapterId),
    publishAt: publishAt ?? undefined,
    url: `https://mangadex.org/chapter/${chapterId}`,
  };
}

export function buildFeedUrl(apiBase, mangaId, { offset, limit, languages }) {
  const url = new URL(`${apiBase}/manga/${mangaId}/feed`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  for (const language of languages) url.searchParams.append("translatedLanguage[]", language);
  url.searchParams.set("order[chapter]", "asc");
  for (const rating of CONTENT_RATINGS) url.searchParams.append("contentRating[]", rating);
  url.searchParams.set("includeExternalUrl", "0");
  return url.href;
}

/**
 * Fetch every feed page (500/page, matching V1) and return the mapped raw
 * chapters, undeduplicated and in feed order. Stops when a page comes back
 * empty or `offset` reaches the API's reported `total`.
 */
export async function fetchAllChapters(http, apiBase, mangaId, languages) {
  const raw = [];
  let offset = 0;
  let total = null;

  for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
    const url = buildFeedUrl(apiBase, mangaId, { offset, limit: FEED_PAGE_SIZE, languages });
    const payload = await http.fetchJson(url);
    if (!payload || payload.result !== "ok" || !Array.isArray(payload.data)) {
      throw parseError(`MangaDex feed returned an unexpected payload at offset ${offset}`);
    }

    const totalRaw = Number.parseInt(String(payload.total ?? ""), 10);
    if (Number.isInteger(totalRaw) && totalRaw >= 0) total = totalRaw;

    for (const entry of payload.data) {
      const mapped = mapFeedEntry(entry);
      if (mapped) raw.push(mapped);
    }

    if (payload.data.length === 0) break;
    offset += payload.data.length;
    if (total !== null && offset >= total) break;
  }

  return raw;
}

/**
 * Multiple scanlation groups routinely translate the same chapter number.
 * Keep the earliest `publishAt` per number (ties keep whichever was seen
 * first); chapters without a parseable number are never merged with anything
 * — each becomes its own chapter, slugged from its id.
 */
export function dedupeChapters(rawChapters) {
  const byNumber = new Map();
  const unnumbered = [];

  for (const chapter of rawChapters) {
    if (chapter.number === undefined) {
      unnumbered.push(chapter);
      continue;
    }
    const key = String(chapter.number);
    const existing = byNumber.get(key);
    if (!existing) {
      byNumber.set(key, chapter);
      continue;
    }
    const existingTime = existing.publishAt
      ? Date.parse(existing.publishAt)
      : Number.POSITIVE_INFINITY;
    const candidateTime = chapter.publishAt
      ? Date.parse(chapter.publishAt)
      : Number.POSITIVE_INFINITY;
    if (Number.isFinite(candidateTime) && candidateTime < existingTime) {
      byNumber.set(key, chapter);
    }
  }

  return [...byNumber.values(), ...unnumbered];
}

/** A deduped raw chapter -> the `ChapterStub` shape `listChapters` returns. */
export function toChapterStub(chapter) {
  const slugPart =
    chapter.number !== undefined
      ? String(chapter.number).replace(/\./g, "-")
      : chapter.chapterId.slice(0, 8);
  const releaseDate =
    chapter.publishAt && Number.isFinite(Date.parse(chapter.publishAt))
      ? new Date(chapter.publishAt).toISOString()
      : undefined;

  return {
    slug: `chapter-${slugPart}`,
    externalId: chapter.chapterId,
    url: chapter.url,
    title: chapter.title,
    chapterOrder: chapter.number,
    number: chapter.number,
    volume: chapter.volume,
    releaseDate,
    releaseDateText: chapter.publishAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Pages (MangaDex@Home)                                                     */
/* -------------------------------------------------------------------------- */

/** Pick the `data` (original) or `dataSaver` (compressed) file list. */
export function pickPageFiles(payload, dataSaver) {
  if (!payload || payload.result !== "ok") {
    throw parseError("MangaDex at-home endpoint returned a non-ok result");
  }
  const baseUrl = asString(payload.baseUrl);
  const hash = asString(payload.chapter?.hash);
  const rawFiles = dataSaver ? payload.chapter?.dataSaver : payload.chapter?.data;
  const files = Array.isArray(rawFiles)
    ? rawFiles.map((file) => asString(file)).filter((file) => file !== null)
    : [];

  if (!baseUrl || !hash) throw parseError("MangaDex at-home endpoint missing baseUrl/hash");
  if (files.length === 0) throw parseError("MangaDex at-home endpoint returned no image files");

  return {
    baseUrl: trimTrailingSlash(baseUrl),
    hash,
    files,
    mode: dataSaver ? "data-saver" : "data",
  };
}

export function buildPageUrl(baseUrl, mode, hash, file) {
  return `${baseUrl}/${mode}/${hash}/${file}`;
}
