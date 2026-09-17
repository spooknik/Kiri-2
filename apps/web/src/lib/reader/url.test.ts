import { describe, expect, it } from "vitest";
import { buildReaderSearch, pageIndexFromParam, parseReaderParams, readerHref } from "./url";

describe("parseReaderParams", () => {
  it("reads all three parameters", () => {
    expect(parseReaderParams("?series=s1&chapter=c1&page=4")).toEqual({
      seriesId: "s1",
      chapterId: "c1",
      page: 4,
    });
  });

  it("accepts URLSearchParams, a bare query string, and a full path", () => {
    const expected = { seriesId: "s1", chapterId: "c1", page: 4 };
    expect(parseReaderParams(new URLSearchParams("series=s1&chapter=c1&page=4"))).toEqual(expected);
    expect(parseReaderParams("series=s1&chapter=c1&page=4")).toEqual(expected);
    expect(parseReaderParams("/read?series=s1&chapter=c1&page=4")).toEqual(expected);
  });

  it("treats missing, blank and nonsense values as absent", () => {
    expect(parseReaderParams("")).toEqual({ seriesId: null, chapterId: null, page: null });
    expect(parseReaderParams(null)).toEqual({ seriesId: null, chapterId: null, page: null });
    expect(parseReaderParams(undefined)).toEqual({ seriesId: null, chapterId: null, page: null });
    expect(parseReaderParams("?series=%20&chapter=&page=abc").seriesId).toBeNull();
    expect(parseReaderParams("?series=s1&page=abc").page).toBeNull();
  });

  it("rejects page numbers below 1 (the URL is 1-based)", () => {
    expect(parseReaderParams("?series=s1&page=0").page).toBeNull();
    expect(parseReaderParams("?series=s1&page=-3").page).toBeNull();
    expect(parseReaderParams("?series=s1&page=1").page).toBe(1);
  });

  it("trims surrounding whitespace from ids", () => {
    expect(parseReaderParams("?series=%20s1%20").seriesId).toBe("s1");
  });
});

describe("buildReaderSearch", () => {
  it("omits the chapter and page when there is nothing to say", () => {
    expect(buildReaderSearch({ seriesId: "s1" })).toBe("?series=s1");
    expect(buildReaderSearch({ seriesId: "s1", chapterId: null, pageIndex: 0 })).toBe("?series=s1");
  });

  it("serialises the 0-based index as a 1-based page", () => {
    expect(buildReaderSearch({ seriesId: "s1", chapterId: "c1", pageIndex: 3 })).toBe(
      "?series=s1&chapter=c1&page=4",
    );
  });

  it("round-trips through parseReaderParams", () => {
    const search = buildReaderSearch({ seriesId: "s1", chapterId: "c1", pageIndex: 11 });
    const parsed = parseReaderParams(search);
    expect(parsed.seriesId).toBe("s1");
    expect(parsed.chapterId).toBe("c1");
    expect(pageIndexFromParam(parsed.page)).toBe(11);
  });

  it("ignores a non-finite index", () => {
    expect(buildReaderSearch({ seriesId: "s1", pageIndex: Number.NaN })).toBe("?series=s1");
  });
});

describe("readerHref", () => {
  it("points at the reader route", () => {
    expect(readerHref({ seriesId: "s1", chapterId: "c1", pageIndex: 0 })).toBe(
      "/read?series=s1&chapter=c1",
    );
  });
});

describe("pageIndexFromParam", () => {
  it("shifts the 1-based URL page down to a 0-based index", () => {
    expect(pageIndexFromParam(1)).toBe(0);
    expect(pageIndexFromParam(9)).toBe(8);
    expect(pageIndexFromParam(null)).toBeNull();
  });
});
