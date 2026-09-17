/**
 * Kiri content-source plugin — template.
 *
 * A complete, working plugin in ~120 lines. It rips the static fixture site in
 * `../fixture-site` (served by `node serve.mjs`), which is deliberately shaped
 * like a real reader: a series page listing chapters newest-first, one HTML
 * page per chapter with `<img>` tags, and a `series.json` for the metadata.
 *
 * Copy this directory, change the four hooks, and you have a plugin. Everything
 * else — argv, the `hello` handshake, events, retries, downloads, the manifest,
 * checkpointing, cancellation, exit codes — is the SDK's job.
 *
 * See `docs/PLUGINS.md` for the full authoring guide.
 */
import { definePlugin, parseError } from "@kiri/source-sdk";

/** Hosts this plugin claims. `kiri-plugin.json` carries the same list. */
const HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `/series/<slug>` — anything else on the host is not a series link. */
const SERIES_PATH = /^\/series\/([^/]+)/;

/** Read one attribute out of a raw tag string. */
function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return match ? match[1] : undefined;
}

/** The five entities a scraped title can realistically contain. */
function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

export default definePlugin({
  id: "template",
  name: "Template Source",
  version: "0.1.0",
  hosts: [...HOSTS],

  // The fixture site is local, so be quick; a real plugin should stay polite
  // (the SDK defaults to 5 requests/second with exponential backoff).
  http: { requestsPerSecond: 50, jitterMs: 0, retries: 2, backoffMs: 100, timeoutMs: 15_000 },

  /**
   * Recognise a URL. Returning `null` (or `handled: false`) tells the host
   * "not my site" and it asks the next plugin — it is not an error.
   */
  async resolve(url, ctx) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!HOSTS.has(parsed.hostname)) return null;

    const match = SERIES_PATH.exec(parsed.pathname);
    if (!match) return null;
    const slug = match[1];

    const normalizedUrl = `${parsed.origin}/series/${slug}/`;
    // A 404 here throws NOT_FOUND from the SDK's HttpClient (exit code 4).
    const meta = await ctx.http.fetchJson(`${normalizedUrl}series.json`);

    return {
      handled: true,
      normalizedUrl,
      slug,
      title: meta.title ?? slug,
      mediaType: meta.mediaType ?? "MANGA",
      coverUrl: meta.cover ? new URL(meta.cover, normalizedUrl).href : undefined,
      externalId: meta.id,
    };
  },

  /** List every chapter the series page offers. */
  async listChapters(series, ctx) {
    const html = await ctx.http.fetchText(series.normalizedUrl);
    const chapters = [];

    // `</a\s*>`, not `</a>`: real markup wraps long tags over several lines.
    for (const match of html.matchAll(/<a\b[^>]*class="chapter"[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
      const tag = match[0];
      const href = attr(tag, "href");
      if (!href) continue;

      const rawNumber = attr(tag, "data-number");
      const number = rawNumber === undefined ? undefined : Number(rawNumber);
      const date = attr(tag, "data-date");

      chapters.push({
        // Slugs must be stable: they name the directory on disk.
        slug: `chapter-${(rawNumber ?? String(chapters.length + 1)).replace(/\./g, "-")}`,
        externalId: attr(tag, "data-id"),
        url: new URL(href, series.normalizedUrl).href,
        title: stripTags(match[1]),
        number: Number.isFinite(number) ? number : undefined,
        chapterOrder: Number.isFinite(number) ? number : undefined,
        volume: attr(tag, "data-volume"),
        releaseDate: date ? new Date(`${date}T00:00:00Z`).toISOString() : undefined,
        releaseDateText: date,
      });
    }

    if (chapters.length === 0) {
      throw parseError(`No chapters found at ${series.normalizedUrl} — did the site change?`);
    }
    return chapters;
  },

  /** List the pages of one chapter, in reading order. */
  async listPages(chapter, ctx) {
    const html = await ctx.http.fetchText(chapter.url);
    const pages = [];

    for (const match of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
      pages.push({
        index: pages.length + 1,
        url: new URL(match[1], chapter.url).href,
        // Many real CDNs reject an image request without a Referer.
        referer: chapter.url,
      });
    }

    if (pages.length === 0) {
      throw parseError(`No pages found in ${chapter.url}`);
    }
    return pages;
  },

  /** Optional: the series cover, stored once as `cover.<ext>`. */
  async fetchCover(series, ctx) {
    if (!series.coverUrl) return null;
    const { buffer } = await ctx.http.fetchBuffer(series.coverUrl, {
      referer: series.normalizedUrl,
    });
    return buffer;
  },
});
