/**
 * Kiri content-source plugin — WeebCentral.
 *
 * Ported from the Kiri 1.x standalone ripper at
 * `tools/weebcentral-ripper/ripper.mjs` (v1 Kiri repo). The site-specific
 * scraping (series metadata, chapter-list markup, the chapter images
 * endpoint, chapter numbering from titles) is carried over as-is or adapted
 * to the current live markup; everything else — argv, retries, the manifest,
 * checkpointing, concurrency — is now the SDK's job. See `docs/PLUGINS.md`
 * §11 for the general porting guide.
 *
 * Site shape (unchanged from V1, verified live 2026-09-10):
 *  - Series page: `/series/<id>/<slug>` (the slug is cosmetic; the server
 *    routes on `<id>` alone). `<meta property="og:url">` carries the
 *    canonical slug, `og:title`/`<title>` the series title (suffixed with
 *    " | Weeb Central"), `og:image` the cover, and a `Type:`/`Status:` pair
 *    of `<li>` fields the series' media type and publication status.
 *  - Chapter list: both the series page's `#chapter-list` div *and*
 *    `/series/<id>/full-chapter-list` (an htmx fragment,
 *    `X-Requested-With: XMLHttpRequest`) list `<a href="/chapters/<id>">`
 *    anchors with a `<span>Chapter N</span>` title and a `<time datetime=…>`
 *    release date. The series page only shows a handful of recent chapters;
 *    the full list is the complete one. V1 fetched and merged both — ported
 *    verbatim, because for a long-running series the full-chapter-list
 *    response is the only complete source.
 *  - Chapter images: V1 discovered the endpoint by reading an `hx-get`
 *    attribute off the chapter page. **That attribute is gone** on the live
 *    site today — the chapter page now fires the same request from inline
 *    Alpine/htmx JS (`htmx.ajax('GET', ".../chapters/<id>/images?is_prev=False", …)`)
 *    instead of a static attribute. Since the endpoint shape itself is
 *    unchanged (`/chapters/<id>/images` with `is_prev`, `current_page`,
 *    `reading_style=long_strip` query params) and `<id>` is already known
 *    from the chapter URL, this port builds the endpoint directly instead of
 *    scraping the chapter page for it — one fewer request, and immune to
 *    that particular markup churn. The `<img src="…">` extraction on the
 *    response fragment is unchanged.
 *  - No cookies or a browser are required (capabilities: ["network"]).
 */
import { definePlugin, parseError } from "@kiri/source-sdk";

/* -------------------------------------------------------------------------- */
/* Hosts                                                                      */
/* -------------------------------------------------------------------------- */

const LIVE_HOSTS = ["weebcentral.com", "www.weebcentral.com"];

/**
 * `WEEBCENTRAL_BASE` lets tests point every request at a local fixture
 * server instead of the live site. Every URL this plugin builds derives its
 * origin from whatever URL it was given (never a hardcoded
 * `https://weebcentral.com`), so the only thing an override needs to do is
 * widen the host allowlist `resolve` checks against.
 */
function testHost() {
  const override = process.env.WEEBCENTRAL_BASE;
  if (!override) return undefined;
  try {
    return new URL(override).hostname;
  } catch {
    return undefined;
  }
}

const HOSTS = new Set([...LIVE_HOSTS, ...(testHost() ? [testHost()] : [])]);

/* -------------------------------------------------------------------------- */
/* HTML helpers (regex/indexOf only — no DOM library)                        */
/* -------------------------------------------------------------------------- */

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", raquo: ">" };

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1]?.toLowerCase() === "x";
      const numeric = isHex
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(numeric) ? full : String.fromCodePoint(numeric);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? full;
  });
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return normalizeWhitespace(decodeEntities(value.replace(/<[^>]*>/g, " ")));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Read one attribute out of a raw tag string (double, single or bare value). */
function attr(tag, name) {
  const regex = new RegExp(`${escapeRegex(name)}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`, "i");
  const match = tag.match(regex);
  if (!match) return undefined;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

function toAbsoluteUrl(value, baseUrl) {
  return new URL(decodeEntities(value), baseUrl).href;
}

/** `<meta property="og:title" content="…">`-style single-value extraction. */
function extractMetaContent(html, metaSelector) {
  const regex = new RegExp(`<meta\\s+${metaSelector}\\s+content=["']([^"']+)["']`, "i");
  const match = html.match(regex);
  return match ? decodeEntities(match[1]) : undefined;
}

/**
 * The content of `<div id="…">…</div>`, tracking nested `<div>` depth so an
 * inner div's close tag does not end the match early. `undefined` if the id
 * is not present — callers fall back to scanning the whole document.
 */
function extractDivById(html, id) {
  const openTagRegex = new RegExp(`<div\\b[^>]*id=["']${escapeRegex(id)}["'][^>]*>`, "i");
  const startMatch = openTagRegex.exec(html);
  if (!startMatch || startMatch.index === undefined) return undefined;

  const startIndex = startMatch.index;
  const divTagRegex = /<\/?div\b[^>]*>/gi;
  divTagRegex.lastIndex = startIndex + startMatch[0].length;
  let depth = 1;
  let tagMatch;
  while ((tagMatch = divTagRegex.exec(html)) !== null) {
    depth += tagMatch[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(startIndex, divTagRegex.lastIndex);
  }
  return html.slice(startIndex);
}

/* -------------------------------------------------------------------------- */
/* Series metadata                                                            */
/* -------------------------------------------------------------------------- */

function normalizeSeriesTitle(raw) {
  if (!raw) return undefined;
  const cleaned = normalizeWhitespace(decodeEntities(raw))
    .replace(/\s*\|\s*Weeb Central$/i, "")
    .trim();
  return cleaned || undefined;
}

/** `og:title` (stripped of the site suffix), else `<title>`, else `<h1>`. */
function extractSeriesTitle(html, fallback) {
  const fromOg = normalizeSeriesTitle(extractMetaContent(html, `property=["']og:title["']`));
  if (fromOg) return fromOg;

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const fromTitleTag = titleMatch ? normalizeSeriesTitle(titleMatch[1]) : undefined;
  if (fromTitleTag) return fromTitleTag;

  const headingMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const heading = headingMatch ? stripTags(headingMatch[1]) : "";
  return heading || fallback;
}

/** `og:image`, resolved against `baseUrl` (WeebCentral serves it absolute). */
function extractCoverUrl(html, baseUrl) {
  const raw = extractMetaContent(html, `property=["']og:image["']`);
  if (!raw) return undefined;
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return undefined;
  }
}

/** `og:url`'s path carries the canonical `/series/<id>/<slug>` slug. */
function extractCanonicalSlug(html) {
  const ogUrl = extractMetaContent(html, `property=["']og:url["']`);
  if (!ogUrl) return undefined;
  try {
    return new URL(ogUrl).pathname.split("/").filter(Boolean)[2];
  } catch {
    return undefined;
  }
}

/** `<strong>Type: </strong><a …>Manga</a>` (also matches an unlinked value). */
function extractLabeledField(html, label) {
  const regex = new RegExp(
    `<strong>\\s*${escapeRegex(label)}:\\s*</strong>\\s*(?:<a\\b[^>]*>([^<]*)</a>|([^<]*))`,
    "i",
  );
  const match = html.match(regex);
  if (!match) return undefined;
  const value = decodeEntities((match[1] ?? match[2] ?? "").trim());
  return value || undefined;
}

/** The descriptor only declares MANGA/MANHWA/MANHUA; anything else falls back to MANGA. */
function mapMediaType(typeText) {
  const normalized = (typeText ?? "").trim().toLowerCase();
  if (normalized === "manhwa") return "MANHWA";
  if (normalized === "manhua") return "MANHUA";
  return "MANGA";
}

/* -------------------------------------------------------------------------- */
/* Series/chapter URL shape                                                   */
/* -------------------------------------------------------------------------- */

/** `/series/<id>[/<slug>]` → `<id>`, or `undefined` for anything else. */
function extractSeriesId(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "series") return undefined;
  return parts[1] || undefined;
}

/** `/chapters/<id>` → `<id>`. */
function extractChapterId(chapterUrl) {
  const parts = new URL(chapterUrl).pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "chapters") return undefined;
  return parts[1] || undefined;
}

function buildFullChapterListUrl(seriesUrl) {
  const url = new URL(seriesUrl);
  const seriesId = extractSeriesId(url.pathname);
  if (!seriesId) return undefined;
  return `${url.origin}/series/${seriesId}/full-chapter-list`;
}

/* -------------------------------------------------------------------------- */
/* Chapter list parsing                                                       */
/* -------------------------------------------------------------------------- */

/** "Chapter 12.5" → 12.5; also accepts "Episode N" (WeebCentral uses both). */
function parseChapterOrder(title) {
  if (!title) return undefined;
  const match = title.match(/(?:chapter|episode)\s*(\d+)(?:\.(\d+))?/i);
  if (!match) return undefined;
  const major = Number.parseInt(match[1], 10);
  if (Number.isNaN(major)) return undefined;
  const minorText = match[2];
  if (!minorText) return major;
  const minor = Number.parseInt(minorText, 10);
  return Number.isNaN(minor) ? major : major + minor / 10 ** minorText.length;
}

/** ISO 8601 timestamp from a `<time>` tag's `datetime` attribute or inner text. */
function normalizeReleaseDate(rawDateText) {
  if (!rawDateText) return undefined;
  const parsed = Date.parse(rawDateText);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function isFallbackChapterTitle(title, slug) {
  if (!title || !slug) return true;
  return normalizeWhitespace(title).toLowerCase() === normalizeWhitespace(slug).toLowerCase();
}

/**
 * The chapter title lives in a `<span>` matching "Chapter …"/"Episode …";
 * that span is nested inside an icon wrapper span, so every `<span>` in the
 * anchor is checked in document order.
 */
function extractChapterTitle(anchorHtml, fallback) {
  for (const match of anchorHtml.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)) {
    const text = stripTags(match[1]);
    if (/^(chapter|episode)\b/i.test(text)) return text;
  }
  const stripped = stripTags(anchorHtml);
  const fallbackMatch = stripped.match(/(chapter\s*\d+(?:\.\d+)?(?:\s*[-:]\s*[^|]+)?)/i);
  return fallbackMatch ? normalizeWhitespace(fallbackMatch[1]) : fallback;
}

/**
 * Parse chapter anchors out of either the series page's `#chapter-list` div
 * or the `/full-chapter-list` fragment (which has no wrapping div — the
 * fragment *is* the list, so `extractDivById` misses and the whole string is
 * scanned instead).
 */
function extractChaptersFromHtml(html, baseUrl) {
  const chapterListHtml = extractDivById(html, "chapter-list") ?? html;
  const chapters = [];
  const seen = new Set();

  for (const match of chapterListHtml.matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
  )) {
    const chapterUrl = toAbsoluteUrl(match[1], baseUrl);
    const chapterId = extractChapterId(chapterUrl);
    if (!chapterId || seen.has(chapterId)) continue;
    seen.add(chapterId);

    const inner = match[2];
    const title = extractChapterTitle(inner, chapterId);
    const timeMatch = inner.match(
      /<time\b[^>]*\bdatetime=["']([^"']+)["'][^>]*>([\s\S]*?)<\/time>/i,
    );
    const dateSource = timeMatch
      ? stripTags(timeMatch[2]) || decodeEntities(timeMatch[1])
      : undefined;
    const order = parseChapterOrder(title);
    const releaseDate = normalizeReleaseDate(dateSource);

    chapters.push({
      slug: chapterId,
      externalId: chapterId,
      url: chapterUrl,
      title,
      ...(order === undefined ? {} : { chapterOrder: order, number: order }),
      ...(releaseDate === undefined ? {} : { releaseDate }),
      ...(dateSource === undefined ? {} : { releaseDateText: dateSource }),
    });
  }

  if (chapters.length > 0) return chapters;

  // The markup changed enough that no anchor matched: grab anything that
  // links to a chapter, same last resort the V1 ripper used.
  for (const match of html.matchAll(/href=["']([^"']*\/chapters\/[^"']+)["']/gi)) {
    const chapterUrl = toAbsoluteUrl(match[1], baseUrl);
    const chapterId = extractChapterId(chapterUrl);
    if (!chapterId || seen.has(chapterId)) continue;
    seen.add(chapterId);
    chapters.push({ slug: chapterId, externalId: chapterId, url: chapterUrl, title: chapterId });
  }
  return chapters;
}

/**
 * The series page only shows recent chapters; `/full-chapter-list` is
 * complete. Merge both by chapter id, series-page fields winning ties (they
 * come first) — a chapter present in only one source still makes it in.
 */
function mergeChapterSources(groups) {
  const bySlug = new Map();
  for (const chapters of groups) {
    for (const chapter of chapters) {
      const existing = bySlug.get(chapter.slug);
      if (!existing) {
        bySlug.set(chapter.slug, { ...chapter });
        continue;
      }
      const merged = { ...existing };
      if (merged.chapterOrder === undefined && chapter.chapterOrder !== undefined) {
        merged.chapterOrder = chapter.chapterOrder;
        merged.number = chapter.number;
      }
      if ((!merged.title || isFallbackChapterTitle(merged.title, merged.slug)) && chapter.title) {
        merged.title = chapter.title;
      }
      if (!merged.url && chapter.url) merged.url = chapter.url;
      if (!merged.releaseDate && chapter.releaseDate) merged.releaseDate = chapter.releaseDate;
      if (!merged.releaseDateText && chapter.releaseDateText) {
        merged.releaseDateText = chapter.releaseDateText;
      }
      bySlug.set(chapter.slug, merged);
    }
  }
  return [...bySlug.values()];
}

function isLikelyImageUrl(url) {
  return /\.(jpg|jpeg|png|webp|gif|avif)(?:\?|$)/i.test(url);
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

// A test run points WEEBCENTRAL_BASE at a local fixture server; there is no
// reason to also throttle it like the live site (source-template does the
// same — its plugin only ever targets its own fixture site, so it always
// runs fast; this one runs politely by default and fast only under test).
const isTestMode = testHost() !== undefined;

export default definePlugin({
  id: "weebcentral",
  name: "WeebCentral",
  version: "0.1.0",
  hosts: [...HOSTS],

  // V1 defaults: concurrency 3, ~400ms between requests (requestsPerSecond:
  // 2 is the polite equivalent). The SDK's token bucket + jitter +
  // exponential backoff replace V1's hand-rolled delay/retry loop.
  http: isTestMode
    ? { requestsPerSecond: 50, jitterMs: 0, retries: 1, backoffMs: 50, timeoutMs: 15_000 }
    : { requestsPerSecond: 2, retries: 3, timeoutMs: 30_000 },
  concurrency: 3,

  async resolve(url, ctx) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!HOSTS.has(parsed.hostname)) return null;

    const seriesId = extractSeriesId(parsed.pathname);
    if (!seriesId) return null;

    const inputSlug = parsed.pathname.split("/").filter(Boolean)[2];
    const probeUrl = `${parsed.origin}/series/${seriesId}${inputSlug ? `/${inputSlug}` : ""}`;
    // A 404 here throws NOT_FOUND from the SDK's HttpClient (exit code 4).
    const html = await ctx.http.fetchText(probeUrl, { referer: probeUrl });

    const slug = extractCanonicalSlug(html) ?? inputSlug ?? seriesId;
    const normalizedUrl = `${parsed.origin}/series/${seriesId}/${slug}`;

    return {
      handled: true,
      normalizedUrl,
      slug,
      title: extractSeriesTitle(html, slug),
      mediaType: mapMediaType(extractLabeledField(html, "Type")),
      coverUrl: extractCoverUrl(html, normalizedUrl),
      externalId: seriesId,
    };
  },

  /**
   * Fetch both the series page and the full chapter list and merge them —
   * see `mergeChapterSources`. A failure fetching the full list only warns
   * (the series page's handful of chapters is still returned); a total
   * failure to find any chapter is a `PARSE` error.
   */
  async listChapters(series, ctx) {
    const seriesHtml = await ctx.http.fetchText(series.normalizedUrl, {
      referer: series.normalizedUrl,
    });
    const fromSeriesPage = extractChaptersFromHtml(seriesHtml, series.normalizedUrl);

    let fromFullList = [];
    const fullListUrl = buildFullChapterListUrl(series.normalizedUrl);
    if (fullListUrl) {
      try {
        const fullListHtml = await ctx.http.fetchText(fullListUrl, {
          referer: series.normalizedUrl,
          headers: { "X-Requested-With": "XMLHttpRequest" },
        });
        fromFullList = extractChaptersFromHtml(fullListHtml, series.normalizedUrl);
      } catch (error) {
        ctx.log.warn(`Could not fetch the full chapter list: ${error.message ?? error}`);
      }
    }

    const chapters = mergeChapterSources([fromSeriesPage, fromFullList]);
    if (chapters.length === 0) {
      throw parseError(`No chapters found at ${series.normalizedUrl} — did the site change?`);
    }
    return chapters;
  },

  /**
   * V1 discovered the images endpoint by reading an `hx-get` attribute off
   * the chapter page. That attribute is gone from the live markup (see the
   * file header) — the endpoint shape is unchanged, so it is built directly
   * from the chapter id instead of fetching the chapter page at all.
   */
  async listPages(chapter, ctx) {
    const chapterId = extractChapterId(chapter.url) ?? chapter.slug;
    const endpoint = new URL(`${new URL(chapter.url).origin}/chapters/${chapterId}/images`);
    endpoint.searchParams.set("is_prev", "False");
    endpoint.searchParams.set("current_page", "1");
    endpoint.searchParams.set("reading_style", "long_strip");

    const html = await ctx.http.fetchText(endpoint.href, {
      referer: chapter.url,
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });

    const pages = [];
    const seen = new Set();
    for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      const src =
        attr(tag, "src") ??
        attr(tag, "data-src") ??
        attr(tag, "data-lazy-src") ??
        attr(tag, "data-original");
      if (!src || src.startsWith("data:")) continue;

      let absolute;
      try {
        absolute = toAbsoluteUrl(src, endpoint.href);
      } catch {
        continue;
      }
      if (!isLikelyImageUrl(absolute) || seen.has(absolute)) continue;
      seen.add(absolute);

      pages.push({
        index: pages.length + 1,
        url: absolute,
        // The real image CDN did not require it in testing, but WeebCentral
        // has fronted chapter images with a referer-checking CDN before.
        referer: chapter.url,
      });
    }

    if (pages.length === 0) {
      throw parseError(`No pages found for chapter "${chapter.slug}" (${endpoint.href})`);
    }
    return pages;
  },

  async fetchCover(series, ctx) {
    if (!series.coverUrl) return null;
    const { buffer } = await ctx.http.fetchBuffer(series.coverUrl, {
      referer: series.normalizedUrl,
    });
    return buffer;
  },
});
