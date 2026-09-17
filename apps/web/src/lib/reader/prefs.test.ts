// @vitest-environment jsdom
//
// jsdom for the `localStorage` round trip; everything else here is pure.
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPrefPatch,
  clearSeriesPrefs,
  cycleValue,
  defaultPrefsForMediaType,
  EMPTY_STORED_PREFS,
  loadStoredPrefs,
  parseStoredPrefs,
  READER_MODES,
  READER_PREFS_STORAGE_KEY,
  resolvePrefs,
  sanitizePrefsPatch,
  saveStoredPrefs,
  type StoredReaderPrefs,
} from "./prefs";

afterEach(() => {
  window.localStorage.clear();
});

describe("defaultPrefsForMediaType", () => {
  it("reads manga right-to-left, one page at a time", () => {
    const prefs = defaultPrefsForMediaType("MANGA");
    expect(prefs.mode).toBe("single");
    expect(prefs.direction).toBe("rtl");
  });

  it("reads webtoons as a left-to-right vertical strip", () => {
    for (const mediaType of ["MANHWA", "MANHUA"] as const) {
      const prefs = defaultPrefsForMediaType(mediaType);
      expect(prefs.mode).toBe("strip");
      expect(prefs.direction).toBe("ltr");
    }
  });

  it("reads comics as single pages, left to right", () => {
    const prefs = defaultPrefsForMediaType("COMIC");
    expect(prefs.mode).toBe("single");
    expect(prefs.direction).toBe("ltr");
  });

  it("reads prose as a strip", () => {
    expect(defaultPrefsForMediaType("LIGHT_NOVEL").mode).toBe("strip");
    expect(defaultPrefsForMediaType("NOVEL").mode).toBe("strip");
    expect(defaultPrefsForMediaType("BOOK").mode).toBe("strip");
    expect(defaultPrefsForMediaType("OTHER").mode).toBe("strip");
  });

  it("fits the width of a strip and the height of a page", () => {
    expect(defaultPrefsForMediaType("MANHWA").fit).toBe("width");
    expect(defaultPrefsForMediaType("MANGA").fit).toBe("height");
    expect(defaultPrefsForMediaType("COMIC").fit).toBe("height");
  });

  it("shares the remaining defaults across media types", () => {
    const prefs = defaultPrefsForMediaType("MANGA");
    expect(prefs.background).toBe("black");
    expect(prefs.showPageNumbers).toBe(true);
    expect(prefs.coverFirst).toBe(true);
  });
});

describe("resolvePrefs", () => {
  const stored: StoredReaderPrefs = {
    version: 1,
    byMediaType: { MANGA: { fit: "original" } },
    bySeries: { "series-1": { mode: "double" } },
  };

  it("falls back to the media-type defaults", () => {
    const prefs = resolvePrefs(EMPTY_STORED_PREFS, "MANHWA", "series-1");
    expect(prefs).toEqual(defaultPrefsForMediaType("MANHWA"));
  });

  it("layers the media-type override over the defaults", () => {
    const prefs = resolvePrefs(stored, "MANGA", "series-2");
    expect(prefs.fit).toBe("original");
    expect(prefs.mode).toBe("single");
    expect(prefs.direction).toBe("rtl");
  });

  it("layers the per-series override over the media-type one", () => {
    const prefs = resolvePrefs(stored, "MANGA", "series-1");
    expect(prefs.mode).toBe("double");
    expect(prefs.fit).toBe("original");
  });

  it("ignores the series layer when no series is known", () => {
    expect(resolvePrefs(stored, "MANGA", null).mode).toBe("single");
  });
});

describe("applyPrefPatch", () => {
  it("writes to the media-type layer by default", () => {
    const next = applyPrefPatch(
      EMPTY_STORED_PREFS,
      { mediaType: "MANGA", seriesId: "s1", scope: "media" },
      { mode: "strip" },
    );
    expect(next.byMediaType.MANGA).toEqual({ mode: "strip" });
    expect(next.bySeries).toEqual({});
    expect(resolvePrefs(next, "MANGA", "other")).toMatchObject({ mode: "strip" });
  });

  it("writes to the series layer when scoped to the series", () => {
    const next = applyPrefPatch(
      EMPTY_STORED_PREFS,
      { mediaType: "MANGA", seriesId: "s1", scope: "series" },
      { mode: "strip" },
    );
    expect(next.bySeries["s1"]).toEqual({ mode: "strip" });
    expect(next.byMediaType).toEqual({});
  });

  it("falls back to the media layer when there is no series id", () => {
    const next = applyPrefPatch(
      EMPTY_STORED_PREFS,
      { mediaType: "MANGA", seriesId: null, scope: "series" },
      { mode: "strip" },
    );
    expect(next.byMediaType.MANGA).toEqual({ mode: "strip" });
  });

  it("merges rather than replaces, and leaves the input untouched", () => {
    const first = applyPrefPatch(
      EMPTY_STORED_PREFS,
      { mediaType: "MANGA", seriesId: null, scope: "media" },
      { mode: "strip" },
    );
    const second = applyPrefPatch(
      first,
      { mediaType: "MANGA", seriesId: null, scope: "media" },
      { fit: "height" },
    );
    expect(second.byMediaType.MANGA).toEqual({ mode: "strip", fit: "height" });
    expect(EMPTY_STORED_PREFS.byMediaType).toEqual({});
  });

  it("is a no-op for a patch with nothing valid in it", () => {
    const next = applyPrefPatch(
      EMPTY_STORED_PREFS,
      { mediaType: "MANGA", seriesId: null, scope: "media" },
      { mode: "sideways" } as never,
    );
    expect(next).toBe(EMPTY_STORED_PREFS);
  });
});

describe("clearSeriesPrefs", () => {
  it("drops the series layer", () => {
    const stored: StoredReaderPrefs = {
      version: 1,
      byMediaType: {},
      bySeries: { s1: { mode: "double" }, s2: { fit: "height" } },
    };
    const next = clearSeriesPrefs(stored, "s1");
    expect(next.bySeries).toEqual({ s2: { fit: "height" } });
    expect(clearSeriesPrefs(next, "missing")).toBe(next);
  });
});

describe("sanitizePrefsPatch / parseStoredPrefs", () => {
  it("keeps known keys and drops everything else", () => {
    expect(
      sanitizePrefsPatch({ mode: "double", fit: "nope", showPageNumbers: "yes", junk: 1 }),
    ).toEqual({ mode: "double" });
  });

  it("survives malformed storage", () => {
    expect(parseStoredPrefs(null)).toBe(EMPTY_STORED_PREFS);
    expect(parseStoredPrefs("not json")).toBe(EMPTY_STORED_PREFS);
    expect(parseStoredPrefs("[1,2,3]")).toEqual(EMPTY_STORED_PREFS);
    expect(parseStoredPrefs('{"byMediaType":{"MANGA":{"mode":"nope"}}}')).toEqual(
      EMPTY_STORED_PREFS,
    );
  });
});

describe("persistence", () => {
  it("round-trips through localStorage", () => {
    const stored = applyPrefPatch(
      EMPTY_STORED_PREFS,
      { mediaType: "MANHWA", seriesId: "s1", scope: "series" },
      { background: "white", showPageNumbers: false },
    );
    saveStoredPrefs(stored);
    expect(window.localStorage.getItem(READER_PREFS_STORAGE_KEY)).toBeTruthy();
    expect(loadStoredPrefs()).toEqual(stored);
    expect(resolvePrefs(loadStoredPrefs(), "MANHWA", "s1")).toMatchObject({
      background: "white",
      showPageNumbers: false,
      mode: "strip",
    });
  });

  it("returns the empty blob when nothing has been stored", () => {
    expect(loadStoredPrefs()).toEqual(EMPTY_STORED_PREFS);
  });
});

describe("cycleValue", () => {
  it("wraps around the list", () => {
    expect(cycleValue(READER_MODES, "strip")).toBe("single");
    expect(cycleValue(READER_MODES, "single")).toBe("double");
    expect(cycleValue(READER_MODES, "double")).toBe("strip");
  });
});
