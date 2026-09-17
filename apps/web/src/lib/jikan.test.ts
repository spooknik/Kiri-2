import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  JikanRateLimitError,
  mapMediaType,
  resetJikanCache,
  searchMal,
  toMalSearchResult,
} from "./jikan";
import { resetRateLimits } from "@/lib/rate-limit";

const SAMPLE = {
  mal_id: 21,
  url: "https://myanimelist.net/manga/21/Death_Note",
  title: "Death Note",
  titles: [
    { type: "Default", title: "Death Note" },
    { type: "English", title: "Death Note (English)" },
    { type: "Japanese", title: "デスノート" },
  ],
  images: {
    jpg: { image_url: "https://cdn/jpg.jpg", large_image_url: "https://cdn/jpg-l.jpg" },
    webp: { image_url: "https://cdn/webp.webp", large_image_url: "https://cdn/webp-l.webp" },
  },
  synopsis: "A notebook.",
  type: "Manga",
  chapters: 108,
  volumes: 12,
  published: { from: "2003-12-01T00:00:00+00:00" },
  genres: [{ name: "Supernatural" }],
  themes: [{ name: "Psychological" }, { name: "supernatural" }],
  demographics: [{ name: "Shounen" }],
};

function jikanResponse(items: unknown[], init?: ResponseInit): Response {
  return new Response(JSON.stringify({ data: items }), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  resetJikanCache();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mapMediaType", () => {
  it("maps every Jikan type Kiri knows", () => {
    expect(mapMediaType("Manga")).toBe("MANGA");
    expect(mapMediaType("Manhwa")).toBe("MANHWA");
    expect(mapMediaType("Manhua")).toBe("MANHUA");
    expect(mapMediaType("Light Novel")).toBe("LIGHT_NOVEL");
    expect(mapMediaType("Novel")).toBe("NOVEL");
    expect(mapMediaType("One-shot")).toBe("OTHER");
    expect(mapMediaType("Doujinshi")).toBe("OTHER");
    expect(mapMediaType("Something New")).toBe("OTHER");
  });

  it("falls back to MANGA when the type is missing", () => {
    expect(mapMediaType(null)).toBe("MANGA");
    expect(mapMediaType(undefined)).toBe("MANGA");
  });
});

describe("toMalSearchResult", () => {
  it("maps a full item onto the contract shape", () => {
    expect(toMalSearchResult(SAMPLE)).toEqual({
      malId: 21,
      title: "Death Note (English)",
      originalTitle: "デスノート",
      mediaType: "MANGA",
      synopsis: "A notebook.",
      coverUrl: "https://cdn/webp-l.webp",
      publicationYear: 2003,
      totalChapters: 108,
      totalVolumes: 12,
      // genres + themes + demographics, de-duplicated case-insensitively.
      tags: ["Supernatural", "Psychological", "Shounen"],
      url: "https://myanimelist.net/manga/21/Death_Note",
      existingSeriesId: null,
    });
  });

  it("falls back to the primary title and the jpg cover", () => {
    const result = toMalSearchResult({
      mal_id: 5,
      title: "Berserk",
      images: { jpg: { image_url: "https://cdn/only.jpg" } },
      type: "Manga",
    });
    expect(result).toMatchObject({
      title: "Berserk",
      originalTitle: null,
      coverUrl: "https://cdn/only.jpg",
      publicationYear: null,
      totalChapters: null,
      totalVolumes: null,
      tags: [],
      url: "https://myanimelist.net/manga/5",
    });
  });

  it("drops items without a usable id or title", () => {
    expect(toMalSearchResult({ mal_id: 0, title: "x" })).toBeNull();
    expect(toMalSearchResult({ mal_id: 7, title: "   " })).toBeNull();
  });
});

describe("searchMal", () => {
  it("calls Jikan with q, limit and sfw and maps the results", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jikanResponse([SAMPLE]));
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchMal("death note", 5, { sfw: true });

    expect(results).toHaveLength(1);
    expect(results[0]?.malId).toBe(21);
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.origin + requested.pathname).toBe("https://api.jikan.moe/v4/manga");
    expect(requested.searchParams.get("q")).toBe("death note");
    expect(requested.searchParams.get("limit")).toBe("5");
    expect(requested.searchParams.get("sfw")).toBe("true");
  });

  it("omits sfw for users who opted into adult content", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jikanResponse([SAMPLE]));
    vi.stubGlobal("fetch", fetchMock);
    await searchMal("death note", 5, { sfw: false });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.has("sfw")).toBe(false);
  });

  it("serves an identical search from the cache", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jikanResponse([SAMPLE]));
    vi.stubGlobal("fetch", fetchMock);

    await searchMal("Death Note", 5, { sfw: true });
    const second = await searchMal("death note", 5, { sfw: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second[0]?.title).toBe("Death Note (English)");
  });

  it("keys the cache on limit and sfw", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jikanResponse([SAMPLE]));
    vi.stubGlobal("fetch", fetchMock);

    await searchMal("q", 5, { sfw: true });
    await searchMal("q", 10, { sfw: true });
    await searchMal("q", 5, { sfw: false });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("protects the upstream with a token bucket", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jikanResponse([SAMPLE]));
    vi.stubGlobal("fetch", fetchMock);

    await searchMal("a", 5, { sfw: true });
    await searchMal("b", 5, { sfw: true });
    await searchMal("c", 5, { sfw: true });
    await expect(searchMal("d", 5, { sfw: true })).rejects.toBeInstanceOf(JikanRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports an upstream 429 as a rate limit, not a 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("", { status: 429 })),
    );
    await expect(searchMal("x", 5, { sfw: true })).rejects.toBeInstanceOf(JikanRateLimitError);
  });

  it("turns an upstream failure into a 502 ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("boom", { status: 500 })),
    );
    const error = await searchMal("x", 5, { sfw: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it("turns a network error or timeout into a 502 ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("TimeoutError");
      }),
    );
    const error = await searchMal("x", 5, { sfw: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it("ignores unusable entries and duplicate mal ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jikanResponse([SAMPLE, SAMPLE, { mal_id: null }, null])),
    );
    const results = await searchMal("x", 5, { sfw: true });
    expect(results).toHaveLength(1);
  });
});
