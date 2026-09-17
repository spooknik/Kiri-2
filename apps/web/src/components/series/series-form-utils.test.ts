import { describe, expect, it } from "vitest";
import { ApiClientError } from "@/lib/api-client";
import type { SeriesDetail } from "@/lib/contracts/series";
import type { MalSearchResult } from "@/lib/contracts/search";
import {
  EMPTY_SERIES_FORM_VALUES,
  createInputToUpdateInput,
  formValuesToCreateInput,
  getExistingSeriesId,
  malResultToFormValues,
  normalizeTags,
  parseTagsInput,
  seriesDetailToFormValues,
  toChapterNumber,
  type SeriesFormValues,
} from "./series-form-utils";

describe("normalizeTags", () => {
  it("trims whitespace and drops empty entries", () => {
    expect(normalizeTags([" romance ", "", "  ", "drama"])).toEqual(["romance", "drama"]);
  });

  it("dedupes case-insensitively, keeping the first casing", () => {
    expect(normalizeTags(["Yuri", "yuri", "YURI"])).toEqual(["Yuri"]);
  });

  it("caps at 30 tags", () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    expect(normalizeTags(many)).toHaveLength(30);
  });
});

describe("parseTagsInput", () => {
  it("splits a comma-separated string into normalized tags", () => {
    expect(parseTagsInput("romance, yuri,, drama ")).toEqual(["romance", "yuri", "drama"]);
  });
});

describe("toChapterNumber", () => {
  it("parses fractional chapter numbers", () => {
    expect(toChapterNumber("10.5")).toBe(10.5);
  });

  it("falls back to 0 for blank, negative or non-numeric input", () => {
    expect(toChapterNumber("")).toBe(0);
    expect(toChapterNumber("-3")).toBe(0);
    expect(toChapterNumber("abc")).toBe(0);
  });
});

describe("formValuesToCreateInput", () => {
  const values: SeriesFormValues = {
    ...EMPTY_SERIES_FORM_VALUES,
    title: "  Solo Leveling  ",
    originalTitle: "  나 혼자만 레벨업  ",
    publicationYear: "2018",
    totalChapters: "200",
    totalVolumes: "",
    tags: ["action", "action", " Fantasy "],
    synopsis: "  A hunter story.  ",
    sourceUrl: "https://mangadex.org/title/abc",
    coverUrl: "  ",
    currentChapter: "42.5",
  };

  it("trims strings, blanks-to-null, and normalizes tags", () => {
    const input = formValuesToCreateInput(values);
    expect(input.title).toBe("Solo Leveling");
    expect(input.originalTitle).toBe("나 혼자만 레벨업");
    expect(input.publicationYear).toBe(2018);
    expect(input.totalChapters).toBe(200);
    expect(input.totalVolumes).toBeNull();
    expect(input.tags).toEqual(["action", "Fantasy"]);
    expect(input.sourceUrl).toBe("https://mangadex.org/title/abc");
    expect(input.coverUrl).toBeNull();
    expect(input.currentChapter).toBe(42.5);
  });
});

describe("malResultToFormValues", () => {
  const result: MalSearchResult = {
    malId: 12345,
    title: "Chainsaw Man",
    originalTitle: null,
    mediaType: "MANGA",
    synopsis: "A devil hunter.",
    coverUrl: "https://cdn.myanimelist.net/cover.jpg",
    publicationYear: 2018,
    totalChapters: null,
    totalVolumes: null,
    tags: ["Action", "action"],
    url: "https://myanimelist.net/manga/12345",
    existingSeriesId: null,
  };

  it("prefills the form from a search result, normalizing tags and nulls", () => {
    const values = malResultToFormValues(result);
    expect(values.title).toBe("Chainsaw Man");
    expect(values.originalTitle).toBe("");
    expect(values.publicationYear).toBe("2018");
    expect(values.totalChapters).toBe("");
    expect(values.tags).toEqual(["Action"]);
    expect(values.sourceUrl).toBe("https://myanimelist.net/manga/12345");
    expect(values.coverUrl).toBe("https://cdn.myanimelist.net/cover.jpg");
    expect(values.malId).toBe(12345);
    // Fields not carried by the search result keep the base value's defaults.
    expect(values.visibility).toBe("SHARED");
    expect(values.status).toBe("PLAN_TO_READ");
  });
});

describe("seriesDetailToFormValues", () => {
  const detail: SeriesDetail = {
    id: "series-1",
    title: "One Piece",
    originalTitle: null,
    mediaType: "MANGA",
    visibility: "SHARED",
    isAdult: false,
    isBookClub: true,
    coverUrl: "/api/series/series-1/cover?v=1",
    tags: ["adventure"],
    chapterCount: 0,
    lastChapterAt: null,
    totalChapters: null,
    createdBy: { id: "u1", displayName: "Ada" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    entry: {
      status: "READING",
      currentChapter: 1090,
      rating: 9,
      notes: null,
      favorite: false,
      joinedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
    readerCount: 3,
    canEdit: true,
    synopsis: null,
    publicationYear: null,
    totalVolumes: null,
    sourceUrl: null,
    malId: null,
    externalIds: {},
    members: [],
  };

  it("carries the current user's entry status/chapter into the form", () => {
    const values = seriesDetailToFormValues(detail);
    expect(values.status).toBe("READING");
    expect(values.currentChapter).toBe("1090");
    expect(values.coverUrl).toBe("");
  });

  it("defaults status/chapter when the user has no entry", () => {
    const values = seriesDetailToFormValues({ ...detail, entry: null });
    expect(values.status).toBe("PLAN_TO_READ");
    expect(values.currentChapter).toBe("0");
  });
});

describe("createInputToUpdateInput", () => {
  it("strips status/currentChapter and merges extras", () => {
    const input = formValuesToCreateInput(EMPTY_SERIES_FORM_VALUES);
    const patch = createInputToUpdateInput(input, { isBookClub: true, removeCover: true });
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("currentChapter");
    expect(patch.isBookClub).toBe(true);
    expect(patch.removeCover).toBe(true);
    expect(patch.coverUrl).toBeUndefined();
  });

  it("only includes coverUrl when a new one was provided", () => {
    const input = formValuesToCreateInput({
      ...EMPTY_SERIES_FORM_VALUES,
      coverUrl: "https://x/cover.jpg",
    });
    const patch = createInputToUpdateInput(input);
    expect(patch.coverUrl).toBe("https://x/cover.jpg");
  });
});

describe("getExistingSeriesId", () => {
  it("reads existingSeriesId off a 409 ApiClientError", () => {
    const error = new ApiClientError(409, "CONFLICT", "Already exists", {
      existingSeriesId: "series-42",
    });
    expect(getExistingSeriesId(error)).toBe("series-42");
  });

  it("returns null for non-409 errors, missing details, or non-ApiClientErrors", () => {
    expect(getExistingSeriesId(new ApiClientError(500, "INTERNAL", "Oops"))).toBeNull();
    expect(getExistingSeriesId(new ApiClientError(409, "CONFLICT", "Oops"))).toBeNull();
    expect(getExistingSeriesId(new Error("boom"))).toBeNull();
    expect(getExistingSeriesId(null)).toBeNull();
  });
});
