/**
 * Kiri content-source plugin — MangaFire.
 *
 * Ported from the Kiri 1.x standalone ripper
 * (`tools/mangafire-ripper/ripper.mjs`, ~1834 lines). The site-specific parsing
 * below is carried over as closely as practical; everything else — argv,
 * retries, rate limiting, the manifest, checkpointing, downloads, exit codes —
 * is `@kiri/source-sdk`'s job. See `docs/PLUGINS.md` §11 for the porting guide.
 *
 * mangafire.to sits behind Cloudflare. This plugin never tries to solve or
 * bypass that (see the "neutral SDK" policy in `docs/PLUGINS.md` §10): it
 * passes through whatever `ctx.cookie`/`ctx.userAgent` the host supplies (the
 * `cookie` capability), and raises `NEEDS_CREDENTIAL` — via the SDK's own
 * 403/503 challenge detection, and via this plugin's *own* check for a
 * challenge page served with a 200 status — whenever the site is unhappy.
 *
 * Known simplifications vs. V1 (see the plugin's README for the long version):
 *  - the chapter AJAX payload pairs each image URL with a scramble offset,
 *    `[url, offset]`; V1 never descrambled images and only read `entry[0]` —
 *    this port does exactly the same and discards the offset;
 *  - V1 never classified series as manga/manhwa/manhua; `mediaType` is always
 *    reported as `"MANGA"`;
 *  - V1 computed the page's active reader language but never used it to filter
 *    anything (MangaFire renders one language per request). This port adds an
 *    opt-in filter keyed off a `data-lang` attribute on a chapter's `<li>`,
 *    which is a no-op (matches V1) unless the markup actually carries one.
 */
import {
  definePlugin,
  getSetting,
  needsCredential,
  parseError,
  PluginError,
} from "@kiri/source-sdk";

/* -------------------------------------------------------------------------- */
/* Site identity                                                              */
/* -------------------------------------------------------------------------- */

const PROD_HOSTS = new Set(["mangafire.to", "www.mangafire.to"]);
const THUMBNAIL_MAX_DIMENSION = 220;

/** Errors from a hook that must stop the whole sync, not just one chapter. */
const FATAL_HOOK_CODES = new Set(["NEEDS_CREDENTIAL", "RATE_LIMITED", "BLOCKED", "CANCELLED"]);

/** `MANGAFIRE_BASE` swaps the real site for a local fixture server in tests. */
function overrideOrigin() {
  const raw = process.env.MANGAFIRE_BASE;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function originBase() {
  return overrideOrigin()?.origin ?? "https://mangafire.to";
}

function isAllowedHost(parsed) {
  if (PROD_HOSTS.has(parsed.hostname)) return true;
  const override = overrideOrigin();
  return override !== null && parsed.host === override.host;
}

/* -------------------------------------------------------------------------- */
/* Small text helpers (ported ~verbatim from the V1 ripper)                   */
/* -------------------------------------------------------------------------- */

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlEntities(value) {
  const namedMap = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
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

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return normalizeWhitespace(decodeHtmlEntities(value.replace(/<[^>]*>/g, " ")));
}

function toAbsoluteUrl(value, baseUrl) {
  return new URL(decodeHtmlEntities(value), baseUrl).href;
}

function extractAttribute(tag, name) {
  const regex = new RegExp(`${escapeRegex(name)}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`, "i");
  const match = tag.match(regex);
  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function extractMetaContent(html, metaSelector) {
  const regex = new RegExp(`<meta\\s+${metaSelector}\\s+content=["']([^"']+)["']`, "i");
  const match = html.match(regex);
  return match ? decodeHtmlEntities(match[1]) : null;
}

/** Depth-counting `<div>` extractor: regex can't nest, so this walks tags. */
function extractDivByClass(html, className) {
  const openTag = new RegExp(
    `<div\\b[^>]*class=["'][^"']*\\b${escapeRegex(className)}\\b[^"']*["'][^>]*>`,
    "i",
  );
  return extractDivFrom(html, openTag);
}

function extractDivById(html, id) {
  const openTag = new RegExp(`<div\\b[^>]*id=["']${escapeRegex(id)}["'][^>]*>`, "i");
  return extractDivFrom(html, openTag);
}

function extractDivFrom(html, openTagRegex) {
  const startMatch = openTagRegex.exec(html);
  if (!startMatch || startMatch.index === undefined) return null;
  const startIndex = startMatch.index;
  const tagRegex = /<\/?div\b[^>]*>/gi;
  tagRegex.lastIndex = startIndex + startMatch[0].length;
  let depth = 1;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(html)) !== null) {
    depth += tagMatch[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(startIndex, tagRegex.lastIndex);
  }
  return html.slice(startIndex);
}

/* -------------------------------------------------------------------------- */
/* Cloudflare challenge detection                                             */
/* -------------------------------------------------------------------------- */

/**
 * `ctx.http`'s own detection only fires on 403/503 (see `docs/PLUGINS.md`
 * §10). MangaFire has been observed answering the interstitial with a plain
 * 200, so every HTML/JSON-ish body this plugin reads is checked here too —
 * the same markers V1 used, plus the `cf-mitigated` marker the SDK also
 * looks for in headers.
 */
function looksLikeCloudflareChallenge(body) {
  if (!body) return false;
  return (
    /<title>\s*just a moment/i.test(body) ||
    /performing security verification/i.test(body) ||
    /cf-browser-verification/i.test(body) ||
    /_cf_chl_opt/i.test(body) ||
    /cf-mitigated/i.test(body) ||
    /id=["']challenge-(?:running|error|form)["']/i.test(body)
  );
}

function assertNotChallenge(body, url) {
  if (!looksLikeCloudflareChallenge(body)) return;
  throw needsCredential(`MangaFire served a Cloudflare challenge for ${url}`, {
    hint:
      "Paste a fresh cf_clearance cookie and matching User-Agent for mangafire.to on the series " +
      "page (or use the Kiri Cookie Bridge extension), then retry.",
  });
}

async function fetchChallengeCheckedText(ctx, url, options) {
  const body = await ctx.http.fetchText(url, options);
  assertNotChallenge(body, url);
  return body;
}

/* -------------------------------------------------------------------------- */
/* Series URL / identity                                                     */
/* -------------------------------------------------------------------------- */

/** `/manga/<slug>.<id>`; rejects chapter links (`/read/...`, `/manga/<slug>/chapter-N`). */
function normalizeSeriesUrl(parsed) {
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  if (pathParts.length >= 2 && pathParts[0] === "read") return null;
  if (pathParts.length < 2 || pathParts[0] !== "manga") return null;
  const seriesSlug = pathParts[1];
  if (!seriesSlug) return null;
  const thirdPart = pathParts[2]?.toLowerCase() ?? null;
  if (thirdPart && thirdPart.startsWith("chapter")) return null;
  return { normalizedUrl: `${originBase()}/manga/${seriesSlug}`, seriesSlug };
}

/** The manga's short alphanumeric id lives after the last `.` in the slug. */
function mangaIdFromSlug(slug) {
  return slug?.match(/\.([a-z0-9]+)$/i)?.[1] ?? null;
}

function extractSeriesTitle(html) {
  const ogTitle = extractMetaContent(html, "property=[\"']og:title[\"']");
  if (ogTitle) {
    return ogTitle
      .replace(/\s+Manga\s*-\s*Read Manga Online Free$/i, "")
      .replace(/\s+(?:\||-)\s+MangaFire$/i, "")
      .trim();
  }
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    return decodeHtmlEntities(titleMatch[1])
      .replace(/\s+Manga\s*-\s*Read Manga Online Free$/i, "")
      .replace(/\s+(?:\||-)\s+MangaFire$/i, "")
      .trim();
  }
  const headingMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return headingMatch ? stripTags(headingMatch[1]) : null;
}

/**
 * Not present in V1 (it only ever extracted the title). MangaFire's series
 * pages carry a standard OpenGraph image, so this is a small, low-risk
 * addition — same `extractMetaContent` helper V1 already used for the title.
 */
function extractCoverUrl(html, baseUrl) {
  const ogImage = extractMetaContent(html, "property=[\"']og:image[\"']");
  if (!ogImage) return undefined;
  const absolute = toAbsoluteUrl(ogImage, baseUrl);
  return isHttpUrl(absolute) ? absolute : undefined;
}

/* -------------------------------------------------------------------------- */
/* Chapter list                                                              */
/* -------------------------------------------------------------------------- */

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** `"March 3, 2024"` → `"2024-03-03"`. Falls back to `Date.parse`. */
function normalizeDate(rawDateText) {
  if (!rawDateText) return null;
  const named = rawDateText.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    const day = Number.parseInt(named[2], 10);
    const year = Number.parseInt(named[3], 10);
    if (month && day >= 1 && day <= 31 && year >= 1900) {
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  const parsed = Date.parse(rawDateText);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

function toIsoDateTime(dateOnly) {
  return dateOnly ? `${dateOnly}T00:00:00.000Z` : undefined;
}

/** `"chapter-12-5"` → `12.5`; matches V1's `parseChapterNumber`. */
function parseChapterNumberFromSlug(slug) {
  const match = slug?.match(/chapter[-_]?(\d+(?:[._-]\d+)?)/i);
  if (!match) return Number.NaN;
  return Number.parseFloat(match[1].replace(/_/g, ".").replace(/-/g, "."));
}

function chapterSlugFromUrl(chapterUrl, seriesSlug) {
  let parsed;
  try {
    parsed = new URL(chapterUrl);
  } catch {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.length >= 4 && parts[0] === "read" && parts[1] === seriesSlug
    ? (parts[3] ?? null)
    : null;
}

const CHAPTER_LIST_ITEM = /<li\b[^>]*class=["'][^"']*\bitem\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
const LIST_BODY_CONTAINER = /<div\b[^>]*class=["'][^"']*\blist-body\b[^"']*["']/i;

/** Cheap signal that a page is an actual series page, not an empty shell. */
function hasChapterListContainer(html) {
  return LIST_BODY_CONTAINER.test(html);
}

/**
 * Chapters come straight out of the series page's own markup — MangaFire
 * doesn't need a separate list endpoint (V1 fetches the series page exactly
 * once and scrapes both the title and the chapter list from it).
 *
 * V1 scanned the `<li class="item">` blocks twice, once for href/title/date
 * and again for `data-number`; both passes read the same blocks, so this
 * merges them into one pass over the same regex.
 */
function extractChapterItems(html, seriesUrl, seriesSlug) {
  const hrefPattern = new RegExp(
    `<a[^>]*href=["']([^"']*\\/read\\/${escapeRegex(seriesSlug)}\\/[^"']*\\/chapter-[^"']+)["'][^>]*>`,
    "i",
  );
  const chapters = [];
  const seen = new Set();

  for (const liMatch of html.matchAll(CHAPTER_LIST_ITEM)) {
    const block = liMatch[1];
    const hrefMatch = block.match(hrefPattern);
    if (!hrefMatch) continue;

    const chapterUrl = toAbsoluteUrl(hrefMatch[1], seriesUrl);
    const slug = chapterSlugFromUrl(chapterUrl, seriesSlug);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const titleMatch = block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch ? stripTags(titleMatch[1]) : slug;
    const spanMatches = [...block.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)];
    const dateText =
      spanMatches.length > 0 ? stripTags(spanMatches[spanMatches.length - 1][1] || "") : undefined;
    const rawNumber = extractAttribute(block, "data-number");
    const number = rawNumber ? Number.parseFloat(rawNumber) : parseChapterNumberFromSlug(slug);
    const lang = extractAttribute(block, "data-lang");

    chapters.push({
      slug,
      url: chapterUrl,
      title,
      releaseDateText: dateText,
      releaseDate: toIsoDateTime(normalizeDate(dateText)),
      number: Number.isFinite(number) ? number : undefined,
      chapterOrder: Number.isFinite(number) ? number : undefined,
      ...(lang ? { lang } : {}),
    });
  }

  if (chapters.length > 0) return chapters;

  // Fallback: the `list-body` markup changed shape. Scan raw anchors instead
  // (V1's fallback path) — no date/number here, so `listPages` leans on the
  // slug-derived chapter number to still build the AJAX path.
  const anchorPattern = new RegExp(
    `<a[^>]*href=["']([^"']*\\/read\\/${escapeRegex(seriesSlug)}\\/[^"']*\\/chapter-[^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>`,
    "gi",
  );
  for (const match of html.matchAll(anchorPattern)) {
    const chapterUrl = toAbsoluteUrl(match[1], seriesUrl);
    const slug = chapterSlugFromUrl(chapterUrl, seriesSlug);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const number = parseChapterNumberFromSlug(slug);
    chapters.push({
      slug,
      url: chapterUrl,
      title: stripTags(match[2]),
      number: Number.isFinite(number) ? number : undefined,
      chapterOrder: Number.isFinite(number) ? number : undefined,
    });
  }
  return chapters;
}

/* -------------------------------------------------------------------------- */
/* Chapter images                                                             */
/* -------------------------------------------------------------------------- */

function isLikelyImageUrl(url) {
  const lower = url.toLowerCase();
  return (
    /\.(jpg|jpeg|png|webp|gif|avif)$/.test(lower) || /\.(jpg|jpeg|png|webp|gif|avif)\?/.test(lower)
  );
}

function parseImageDimension(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,5})(?:px)?$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Placeholder art and small thumbnail variants MangaFire embeds elsewhere on the page. */
function isLikelyNonChapterImage(imgTag, imageUrl) {
  if (!isHttpUrl(imageUrl)) return false;
  const pathname = new URL(imageUrl).pathname.toLowerCase();
  if (
    pathname.includes("/wp-content/themes/") &&
    /(?:^|\/)(?:dflazy|placeholder|spacer)\.(?:jpg|jpeg|png|webp|gif|avif)$/.test(pathname)
  ) {
    return true;
  }
  const width = parseImageDimension(extractAttribute(imgTag, "width"));
  const height = parseImageDimension(extractAttribute(imgTag, "height"));
  return (
    width !== null &&
    height !== null &&
    width <= THUMBNAIL_MAX_DIMENSION &&
    height <= THUMBNAIL_MAX_DIMENSION
  );
}

function extractImageUrlsFromHtmlBlock(html, baseUrl) {
  const urls = [];
  const seen = new Set();
  for (const imgMatch of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = imgMatch[0];
    const src =
      extractAttribute(tag, "src") ||
      extractAttribute(tag, "data-src") ||
      extractAttribute(tag, "data-lazy-src") ||
      extractAttribute(tag, "data-original");
    if (!src || src.startsWith("data:")) continue;
    const absoluteUrl = toAbsoluteUrl(src, baseUrl);
    if (!isHttpUrl(absoluteUrl) || !isLikelyImageUrl(absoluteUrl)) continue;
    if (isLikelyNonChapterImage(tag, absoluteUrl)) continue;
    if (seen.has(absoluteUrl)) continue;
    urls.push(absoluteUrl);
    seen.add(absoluteUrl);
  }
  return urls;
}

function decodeJsStringLiteral(rawValue) {
  if (!rawValue || rawValue.length < 2) return rawValue;
  if (rawValue.startsWith('"')) {
    try {
      return JSON.parse(rawValue);
    } catch {
      return rawValue.slice(1, -1);
    }
  }
  return rawValue
    .slice(1, -1)
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\\//g, "/");
}

function extractJsStringArray(html, varName) {
  const match = html.match(
    new RegExp(`${escapeRegex(varName)}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`, "i"),
  );
  if (!match) return [];
  const values = [];
  for (const stringMatch of match[1].matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)) {
    const decoded = decodeJsStringLiteral(stringMatch[0]).trim();
    if (decoded.length > 0) values.push(decoded);
  }
  return values;
}

function extractQuotedJsVarValue(html, varName) {
  const match = html.match(new RegExp(`${escapeRegex(varName)}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? match[1] : null;
}

function extractImageUrlsFromDelimitedValue(rawValue, chapterUrl) {
  if (!rawValue) return [];
  const urls = [];
  const seen = new Set();
  for (const candidate of decodeHtmlEntities(rawValue)
    .split(",")
    .map((value) => value.trim())) {
    if (!candidate) continue;
    const absoluteUrl = toAbsoluteUrl(candidate, chapterUrl);
    if (!isHttpUrl(absoluteUrl) || !isLikelyImageUrl(absoluteUrl) || seen.has(absoluteUrl))
      continue;
    urls.push(absoluteUrl);
    seen.add(absoluteUrl);
  }
  return urls;
}

function joinUrlPath(baseUrl, relativePath) {
  return `${baseUrl.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

/** `cdns`/`chapterImages` preloaded JS arrays, or a `chapter_preloaded_*` blob. */
function extractImageUrlsFromPreloadedArrays(html, chapterUrl) {
  const cdnBases = extractJsStringArray(html, "cdns").filter(isHttpUrl);
  const chapterImages = extractJsStringArray(html, "chapterImages");
  if (chapterImages.length > 0) {
    const primaryCdn = cdnBases[0] ?? null;
    const urls = [];
    const seen = new Set();
    for (const candidate of chapterImages) {
      const absoluteUrl = isHttpUrl(candidate)
        ? candidate
        : primaryCdn
          ? joinUrlPath(primaryCdn, candidate)
          : toAbsoluteUrl(candidate, chapterUrl);
      if (!isHttpUrl(absoluteUrl) || !isLikelyImageUrl(absoluteUrl) || seen.has(absoluteUrl))
        continue;
      urls.push(absoluteUrl);
      seen.add(absoluteUrl);
    }
    if (urls.length > 0) return urls;
  }

  const blobMatch = html.match(/chapter_preloaded_(?:images|pages)\s*=\s*(\[[\s\S]*?\])\s*;/i);
  if (blobMatch) {
    const urls = [];
    const seen = new Set();
    for (const candidate of blobMatch[1].match(/https?:\/\/[^"'\\\s)]+|\/[^"'\\\s)]+/g) ?? []) {
      const absoluteUrl = toAbsoluteUrl(candidate, chapterUrl);
      if (!isHttpUrl(absoluteUrl) || !isLikelyImageUrl(absoluteUrl) || seen.has(absoluteUrl))
        continue;
      urls.push(absoluteUrl);
      seen.add(absoluteUrl);
    }
    if (urls.length > 0) return urls;
  }
  return [];
}

/**
 * Fallback when the chapter AJAX endpoint has nothing: scrape the reader
 * page's preloaded arrays, then a `chapImages` var, then a shortlist of
 * reader-container selectors (trimmed from V1's ten to the five most common),
 * then the whole page as a last resort.
 */
function extractImageUrlsFromChapterHtml(html, chapterUrl) {
  const preloaded = extractImageUrlsFromPreloadedArrays(html, chapterUrl);
  if (preloaded.length > 0) return preloaded;

  const fromVariable = extractImageUrlsFromDelimitedValue(
    extractQuotedJsVarValue(html, "chapImages"),
    chapterUrl,
  );
  if (fromVariable.length > 0) return fromVariable;

  const candidateBlocks = [
    extractDivByClass(html, "container-chapter-reader"),
    extractDivByClass(html, "reading-content"),
    extractDivByClass(html, "chapter-content"),
    extractDivByClass(html, "reader-area"),
    extractDivById(html, "readerarea"),
  ].filter((value) => typeof value === "string" && value.length > 0);

  for (const block of candidateBlocks) {
    const urls = extractImageUrlsFromHtmlBlock(block, chapterUrl);
    if (urls.length > 0) return urls;
  }
  return extractImageUrlsFromHtmlBlock(html, chapterUrl);
}

/**
 * `payload.result.images` pairs each URL with a scramble offset —
 * `[url, offset]`. V1 never descrambled images and only ever read `entry[0]`;
 * this does the same and drops the offset on the floor.
 */
function parseChapterAjaxImages(payload, chapterUrl) {
  const result = payload && typeof payload === "object" ? payload.result : null;
  const rawImages = Array.isArray(result?.images) ? result.images : [];
  const urls = [];
  const seen = new Set();
  for (const entry of rawImages) {
    const candidate =
      Array.isArray(entry) && typeof entry[0] === "string"
        ? entry[0]
        : typeof entry === "string"
          ? entry
          : null;
    if (!candidate || candidate.trim() === "") continue;
    const absoluteUrl = toAbsoluteUrl(candidate, chapterUrl);
    if (!isHttpUrl(absoluteUrl) || !isLikelyImageUrl(absoluteUrl) || seen.has(absoluteUrl))
      continue;
    urls.push(absoluteUrl);
    seen.add(absoluteUrl);
  }
  return urls;
}

/** `/ajax/read/<mangaId>/chapter/<number>`, built from the chapter URL alone. */
function buildChapterApiPath(chapterUrl) {
  let parsed;
  try {
    parsed = new URL(chapterUrl);
  } catch {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "read") return null;
  const mangaId = mangaIdFromSlug(parts[1]);
  const number = parseChapterNumberFromSlug(parts[3] ?? "");
  if (!mangaId || !Number.isFinite(number)) return null;
  return `/ajax/read/${mangaId}/chapter/${number}`;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

export default definePlugin({
  id: "mangafire",
  name: "MangaFire",
  version: "0.1.0",
  hosts: [...PROD_HOSTS],

  // V1 defaulted to a 400ms delay + 250ms jitter (~2 req/s) and 3 workers;
  // the SDK's token bucket expresses the same politeness directly.
  http: { requestsPerSecond: 2, jitterMs: 250, retries: 3, backoffMs: 500 },
  concurrency: 3,

  settings: [{ key: "language", type: "string", default: "en", label: "Translated language" }],

  async resolve(url, ctx) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!isAllowedHost(parsed)) return null;

    const normalized = normalizeSeriesUrl(parsed);
    if (!normalized) return null; // a chapter link, or not a series URL shape
    const { normalizedUrl, seriesSlug } = normalized;
    const mangaId = mangaIdFromSlug(seriesSlug);

    const html = await fetchChallengeCheckedText(ctx, normalizedUrl, { referer: normalizedUrl });
    // V1's single `discoverSeries()` call fetched the page once and would
    // throw "No chapters found" if the markup didn't look like a series page
    // (see `listChapters`). The v2 SDK splits that into two hooks, so this
    // restores the same guarantee for `resolve` alone: a 200 response that
    // carries no chapter-list container is *not* a series we can identify,
    // even though the URL has the right shape — e.g. mangafire.to has been
    // observed serving an identical, content-free SPA shell (same generic
    // title, no Cloudflare markers) for every route, including nonexistent
    // ones. Reporting `handled:true` with that shell's generic title would be
    // a silent wrong answer, which is worse than failing loudly here.
    if (!hasChapterListContainer(html)) {
      throw parseError(
        `MangaFire returned a page with no chapter list for ${normalizedUrl} — the series may not ` +
          "exist, or the site's markup has changed.",
      );
    }
    const title = extractSeriesTitle(html) ?? seriesSlug;
    const coverUrl = extractCoverUrl(html, normalizedUrl);

    return {
      handled: true,
      normalizedUrl,
      slug: seriesSlug,
      title,
      // V1 never classified series by type; every series is reported as MANGA.
      mediaType: "MANGA",
      ...(coverUrl ? { coverUrl } : {}),
      ...(mangaId ? { externalId: mangaId } : {}),
    };
  },

  async listChapters(series, ctx) {
    const html = await fetchChallengeCheckedText(ctx, series.normalizedUrl, {
      referer: series.normalizedUrl,
    });
    const chapters = extractChapterItems(html, series.normalizedUrl, series.slug);
    if (chapters.length === 0) {
      throw parseError(`No chapters found at ${series.normalizedUrl} — did the site change?`);
    }

    const language = getSetting(ctx.settings, "language", "en");
    const filtered = chapters.filter((chapter) => !chapter.lang || chapter.lang === language);
    if (filtered.length === 0) {
      // Every chapter is tagged with some other language — better to hand back
      // everything than to report a series with zero chapters.
      ctx.log.warn(
        `No chapters tagged "${language}"; returning all ${chapters.length} chapter(s) unfiltered.`,
      );
    }
    const selected = filtered.length > 0 ? filtered : chapters;
    return selected.map(({ lang: _lang, ...chapter }) => chapter);
  },

  async listPages(chapter, ctx) {
    const chapterUrl = chapter.url;
    let imageUrls = [];

    const apiPath = buildChapterApiPath(chapterUrl);
    if (apiPath) {
      try {
        const raw = await ctx.http.fetchText(`${originBase()}${apiPath}`, {
          referer: chapterUrl,
          accept: "application/json, text/plain, */*",
          headers: { "X-Requested-With": "XMLHttpRequest" },
        });
        assertNotChallenge(raw, apiPath);
        const payload = safeJsonParse(raw);
        if (payload) imageUrls = parseChapterAjaxImages(payload, chapterUrl);
      } catch (error) {
        if (error instanceof PluginError && FATAL_HOOK_CODES.has(error.code)) throw error;
        ctx.log.debug(
          `Chapter AJAX image list failed for ${chapterUrl}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (imageUrls.length === 0) {
      const html = await fetchChallengeCheckedText(ctx, chapterUrl, { referer: chapterUrl });
      imageUrls = extractImageUrlsFromChapterHtml(html, chapterUrl);
    }

    if (imageUrls.length === 0) {
      throw parseError(`No pages found in ${chapterUrl}`);
    }

    return imageUrls.map((url, index) => ({ index: index + 1, url, referer: chapterUrl }));
  },

  /** Not present in V1 (see `extractCoverUrl`). Cover bytes, written once. */
  async fetchCover(series, ctx) {
    if (!series.coverUrl) return null;
    const { buffer } = await ctx.http.fetchBuffer(series.coverUrl, {
      referer: series.normalizedUrl,
    });
    return buffer;
  },
});
