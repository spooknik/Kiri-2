/**
 * Kiri content-source plugin — MangaDex.
 *
 * Ported from the Kiri 1.x standalone tool at
 * `tools/mangadex-ripper/ripper.mjs`. The site-specific pieces (URL/UUID
 * parsing, title/date/chapter-number parsing, feed pagination, the
 * MangaDex@Home page-URL dance) live in `./mangadex.mjs`, which has no SDK
 * plugin wiring so it can be unit-tested directly. Everything else — argv,
 * `hello`, events, retries, the manifest, checkpointing — is `definePlugin`'s
 * job; see `docs/PLUGINS.md`.
 */
import { definePlugin, getSetting, parseError } from "@kiri/source-sdk";

import {
  HOSTS,
  apiBaseFrom,
  buildCoverUrl,
  buildPageUrl,
  dedupeChapters,
  fetchAllChapters,
  findCoverFileName,
  languagesFrom,
  mapMediaType,
  parseMangaIdFromPath,
  pickPageFiles,
  pickSeriesTitle,
  toChapterStub,
  uploadsBaseFrom,
} from "./mangadex.mjs";

async function fetchMangaMetadata(http, apiBase, mangaId) {
  const url = new URL(`${apiBase}/manga/${mangaId}`);
  url.searchParams.append("includes[]", "cover_art");
  url.searchParams.append("includes[]", "author");
  url.searchParams.append("includes[]", "artist");

  const payload = await http.fetchJson(url.href);
  if (!payload || payload.result !== "ok" || !payload.data || typeof payload.data !== "object") {
    throw parseError(`MangaDex manga endpoint returned an unexpected payload for ${mangaId}`);
  }
  return payload.data;
}

export default definePlugin({
  id: "mangadex",
  name: "MangaDex",
  version: "0.1.0",
  hosts: [...HOSTS],

  // MangaDex asks integrations to stay at or below 5 requests/second and to
  // send a descriptive User-Agent identifying the client.
  http: {
    requestsPerSecond: 4,
    headers: { "User-Agent": "Kiri/2.0 (+https://github.com/spooknik/Kiri2)" },
  },

  settings: [
    {
      key: "language",
      type: "string",
      default: "en",
      label: "Translated language",
      description: "Translated language code(s), comma separated",
    },
    {
      key: "dataSaver",
      type: "boolean",
      default: false,
      label: "Data saver",
      description:
        "Download the compressed MangaDex@Home data-saver images instead of the originals",
    },
  ],

  /** `/title/<uuid>[/slug]` and the legacy `/manga/<uuid>[...]`. */
  async resolve(url, ctx) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!HOSTS.has(parsed.hostname)) return null;

    const mangaId = parseMangaIdFromPath(parsed.pathname);
    if (!mangaId) return null;

    const apiBase = apiBaseFrom(ctx.settings);
    const uploadsBase = uploadsBaseFrom(ctx.settings);

    // A 404 here is mapped to NOT_FOUND by ctx.http (exit code 4).
    const data = await fetchMangaMetadata(ctx.http, apiBase, mangaId);
    const attributes = data.attributes ?? {};

    return {
      handled: true,
      normalizedUrl: `https://mangadex.org/title/${mangaId}`,
      slug: mangaId,
      title: pickSeriesTitle(attributes, mangaId),
      mediaType: mapMediaType(attributes.originalLanguage),
      coverUrl: buildCoverUrl(uploadsBase, mangaId, findCoverFileName(data.relationships)),
      externalId: mangaId,
    };
  },

  /** Every chapter in the feed, deduped by number (see `mangadex.mjs`). */
  async listChapters(series, ctx) {
    const mangaId = series.externalId ?? series.slug;
    const apiBase = apiBaseFrom(ctx.settings);
    const languages = languagesFrom(ctx.settings);

    const raw = await fetchAllChapters(ctx.http, apiBase, mangaId, languages);
    if (raw.length === 0) {
      throw parseError(
        `No chapters found for ${series.normalizedUrl} in language(s) ${languages.join(", ")}`,
      );
    }
    return dedupeChapters(raw).map(toChapterStub);
  },

  /** MangaDex@Home: `/at-home/server/{chapterId}` -> `baseUrl/data(-saver)/{hash}/{file}`. */
  async listPages(chapter, ctx) {
    const chapterId = chapter.externalId;
    if (!chapterId) {
      throw parseError(`Chapter "${chapter.slug}" has no MangaDex chapter id`);
    }

    const apiBase = apiBaseFrom(ctx.settings);
    const dataSaver = getSetting(ctx.settings, "dataSaver", false);
    const payload = await ctx.http.fetchJson(`${apiBase}/at-home/server/${chapterId}`);
    const { baseUrl, hash, files, mode } = pickPageFiles(payload, dataSaver);

    return files.map((file, index) => ({
      index: index + 1,
      url: buildPageUrl(baseUrl, mode, hash, file),
    }));
  },

  /** The series cover, written once as `cover.<ext>`. */
  async fetchCover(series, ctx) {
    if (!series.coverUrl) return null;
    const { buffer } = await ctx.http.fetchBuffer(series.coverUrl);
    return buffer;
  },
});
