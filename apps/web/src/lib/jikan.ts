/**
 * Jikan v4 (unofficial MyAnimeList API) client.
 *
 * No API key, but a public and rate-limited upstream, so:
 *   - identical searches are served from a 5-minute in-memory cache;
 *   - a token bucket (3 burst, 1/s) guards the outbound call, and the route
 *     turns an exhausted bucket into a 429 instead of hammering Jikan;
 *   - results are normalised into `MalSearchResult` so the add-series form can
 *     post one straight into `createSeriesSchema`.
 */
import type { MalSearchResult, MediaType } from "@/lib/contracts";
import { ApiError } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { normalizeTags, truncate } from "@/lib/text";

const JIKAN_SEARCH_URL = "https://api.jikan.moe/v4/manga";
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const MAX_SYNOPSIS = 10_000;

/** Shared bucket: this protects Jikan, not any one user. */
const RATE_LIMIT_KEY = "jikan";
const RATE_LIMIT = { capacity: 3, refillPerSecond: 1 } as const;

/** Thrown when the outbound bucket is empty; the route answers 429. */
export class JikanRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("Too many MyAnimeList searches");
    this.name = "JikanRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface SearchMalOptions {
  /** Ask Jikan to omit adult results (set from the user's showAdult). */
  sfw: boolean;
}

/* -------------------------------------------------------------------------- */
/* Upstream shapes (only the fields we read)                                  */
/* -------------------------------------------------------------------------- */

interface JikanImage {
  image_url?: string | null;
  large_image_url?: string | null;
}

interface JikanTitle {
  type?: string | null;
  title?: string | null;
}

interface JikanNamed {
  name?: string | null;
}

interface JikanManga {
  mal_id?: number | null;
  url?: string | null;
  title?: string | null;
  titles?: JikanTitle[] | null;
  images?: { jpg?: JikanImage | null; webp?: JikanImage | null } | null;
  synopsis?: string | null;
  type?: string | null;
  chapters?: number | null;
  volumes?: number | null;
  published?: { from?: string | null } | null;
  genres?: JikanNamed[] | null;
  themes?: JikanNamed[] | null;
  demographics?: JikanNamed[] | null;
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* -------------------------------------------------------------------------- */

const MEDIA_TYPE_BY_JIKAN_TYPE: Record<string, MediaType> = {
  manga: "MANGA",
  manhwa: "MANHWA",
  manhua: "MANHUA",
  "light novel": "LIGHT_NOVEL",
  novel: "NOVEL",
  "one-shot": "OTHER",
  oneshot: "OTHER",
  doujinshi: "OTHER",
};

/** Jikan `type` -> Kiri MediaType; anything unknown lands on OTHER. */
export function mapMediaType(type: string | null | undefined): MediaType {
  if (!type) return "MANGA";
  return MEDIA_TYPE_BY_JIKAN_TYPE[type.trim().toLowerCase()] ?? "OTHER";
}

function pickTitle(titles: JikanTitle[] | null | undefined, type: string): string | null {
  if (!Array.isArray(titles)) return null;
  for (const entry of titles) {
    if (entry?.type?.toLowerCase() === type.toLowerCase()) {
      const title = entry.title?.trim();
      if (title) return title;
    }
  }
  return null;
}

function pickCover(item: JikanManga): string | null {
  const candidates = [
    item.images?.webp?.large_image_url,
    item.images?.webp?.image_url,
    item.images?.jpg?.large_image_url,
    item.images?.jpg?.image_url,
  ];
  for (const candidate of candidates) {
    const url = candidate?.trim();
    if (url) return url;
  }
  return null;
}

function pickYear(item: JikanManga): number | null {
  const from = item.published?.from?.trim();
  if (!from) return null;
  const at = new Date(from);
  if (Number.isNaN(at.getTime())) return null;
  const year = at.getUTCFullYear();
  return year >= 1800 && year <= 2100 ? year : null;
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

/** One Jikan item -> one contract result. `existingSeriesId` is filled by the route. */
export function toMalSearchResult(item: JikanManga | null | undefined): MalSearchResult | null {
  if (item === null || typeof item !== "object") return null;
  const malId = positiveOrNull(item.mal_id);
  const fallbackTitle = item.title?.trim() ?? "";
  const english = pickTitle(item.titles, "English");
  const japanese = pickTitle(item.titles, "Japanese");
  const title = english ?? fallbackTitle;
  if (malId === null || title === "") return null;

  const originalTitle = japanese && japanese !== title ? japanese : null;
  const synopsis = item.synopsis?.trim();

  return {
    malId,
    title: truncate(title, 300),
    originalTitle: originalTitle ? truncate(originalTitle, 300) : null,
    mediaType: mapMediaType(item.type),
    synopsis: synopsis ? truncate(synopsis, MAX_SYNOPSIS) : null,
    coverUrl: pickCover(item),
    publicationYear: pickYear(item),
    totalChapters: positiveOrNull(item.chapters),
    totalVolumes: positiveOrNull(item.volumes),
    tags: normalizeTags(
      [...(item.genres ?? []), ...(item.themes ?? []), ...(item.demographics ?? [])].map(
        (entry) => entry?.name ?? "",
      ),
    ),
    url: item.url?.trim() || `https://myanimelist.net/manga/${malId}`,
    existingSeriesId: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

interface CacheEntry {
  at: number;
  results: MalSearchResult[];
}

const cache = new Map<string, CacheEntry>();

function cacheKey(q: string, limit: number, sfw: boolean): string {
  return `${sfw ? "sfw" : "all"}|${limit}|${q.trim().toLowerCase()}`;
}

function readCache(key: string, now: number): MalSearchResult[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (now - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.results;
}

function writeCache(key: string, results: MalSearchResult[], now: number): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the oldest write.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { at: now, results });
}

/** Test helper: forget every cached search. */
export function resetJikanCache(): void {
  cache.clear();
}

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Search MyAnimeList. Results carry `existingSeriesId: null`; the route fills
 * it in from the local library so the cache stays user-independent.
 */
export async function searchMal(
  q: string,
  limit: number,
  options: SearchMalOptions,
): Promise<MalSearchResult[]> {
  const key = cacheKey(q, limit, options.sfw);
  const now = Date.now();
  const cached = readCache(key, now);
  if (cached) return cached.map((result) => ({ ...result }));

  const gate = checkRateLimit(RATE_LIMIT_KEY, RATE_LIMIT);
  if (!gate.allowed) throw new JikanRateLimitError(gate.retryAfterMs);

  const url = new URL(JIKAN_SEARCH_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));
  if (options.sfw) url.searchParams.set("sfw", "true");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new ApiError(502, "UPSTREAM_UNAVAILABLE", "MyAnimeList search is unavailable right now", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  if (response.status === 429) {
    throw new JikanRateLimitError(5_000);
  }
  if (!response.ok) {
    throw new ApiError(
      502,
      "UPSTREAM_UNAVAILABLE",
      `MyAnimeList search failed (${response.status})`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(502, "UPSTREAM_UNAVAILABLE", "MyAnimeList returned an unreadable response");
  }

  const data = (payload as { data?: unknown } | null)?.data;
  const items = Array.isArray(data) ? (data as JikanManga[]) : [];
  const results: MalSearchResult[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    const result = toMalSearchResult(item);
    if (!result || seen.has(result.malId)) continue;
    seen.add(result.malId);
    results.push(result);
    if (results.length >= limit) break;
  }

  writeCache(key, results, now);
  return results.map((result) => ({ ...result }));
}
