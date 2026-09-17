/**
 * Reader preferences: layout mode, fit, reading direction, background and the
 * page-number overlay.
 *
 * Resolution is three layers deep, most specific last:
 *
 *   defaults for the series' media type
 *     -> the user's per-media-type override
 *     -> the user's per-series override
 *
 * Keying the user layer by media type (rather than one global blob) is what
 * lets a manga default to right-to-left single page and a manhwa to the
 * vertical strip *after* the user has customised either of them. The per-series
 * layer is the escape hatch for the one webtoon that ships as double spreads.
 *
 * Everything here is pure except `loadStoredPrefs`/`saveStoredPrefs`, which
 * wrap `localStorage` in try/catch (private mode, disabled storage) and never
 * throw.
 */
import type { MediaType } from "@/lib/contracts/series";

export const READER_PREFS_STORAGE_KEY = "kiri.reader.prefs";
export const READER_PREFS_VERSION = 1;

export const READER_MODES = ["strip", "single", "double"] as const;
export type ReaderMode = (typeof READER_MODES)[number];

export const READER_FITS = ["width", "height", "original"] as const;
export type ReaderFit = (typeof READER_FITS)[number];

export const READER_DIRECTIONS = ["ltr", "rtl"] as const;
export type ReaderDirection = (typeof READER_DIRECTIONS)[number];

export const READER_BACKGROUNDS = ["black", "dark", "white"] as const;
export type ReaderBackground = (typeof READER_BACKGROUNDS)[number];

export const READER_MODE_LABELS: Record<ReaderMode, string> = {
  strip: "Vertical strip",
  single: "Single page",
  double: "Double page",
};

export const READER_FIT_LABELS: Record<ReaderFit, string> = {
  width: "Fit width",
  height: "Fit height",
  original: "Original size",
};

export const READER_DIRECTION_LABELS: Record<ReaderDirection, string> = {
  ltr: "Left to right",
  rtl: "Right to left",
};

export const READER_BACKGROUND_LABELS: Record<ReaderBackground, string> = {
  black: "Black",
  dark: "Dark grey",
  white: "White",
};

/** CSS colours for the reader surface, independent of the app theme. */
export const READER_BACKGROUND_COLORS: Record<ReaderBackground, string> = {
  black: "#000000",
  dark: "#111827",
  white: "#ffffff",
};

/** Foreground colour that stays legible on each background. */
export const READER_FOREGROUND_COLORS: Record<ReaderBackground, string> = {
  black: "#f8fafc",
  dark: "#f8fafc",
  white: "#0f172a",
};

export interface ReaderPrefs {
  mode: ReaderMode;
  fit: ReaderFit;
  direction: ReaderDirection;
  background: ReaderBackground;
  /** "Read-along" page numbers drawn over each page. */
  showPageNumbers: boolean;
  /** Double mode: show the first page alone so spreads line up like a book. */
  coverFirst: boolean;
}

/** Media types that read as one continuous vertical strip (webtoons, prose). */
const STRIP_MEDIA_TYPES: ReadonlySet<MediaType> = new Set<MediaType>([
  "MANHWA",
  "MANHUA",
  "LIGHT_NOVEL",
  "NOVEL",
  "BOOK",
  "OTHER",
]);

/** Media types published right-to-left. */
const RTL_MEDIA_TYPES: ReadonlySet<MediaType> = new Set<MediaType>(["MANGA"]);

export function defaultPrefsForMediaType(mediaType: MediaType): ReaderPrefs {
  const strip = STRIP_MEDIA_TYPES.has(mediaType);
  return {
    mode: strip ? "strip" : "single",
    // A strip is read by scrolling, so it should fill the width; a paged mode
    // shows one page at a time and should show all of it.
    fit: strip ? "width" : "height",
    direction: RTL_MEDIA_TYPES.has(mediaType) ? "rtl" : "ltr",
    background: "black",
    showPageNumbers: true,
    coverFirst: true,
  };
}

export interface StoredReaderPrefs {
  version: number;
  byMediaType: Partial<Record<MediaType, Partial<ReaderPrefs>>>;
  bySeries: Record<string, Partial<ReaderPrefs>>;
}

export const EMPTY_STORED_PREFS: StoredReaderPrefs = {
  version: READER_PREFS_VERSION,
  byMediaType: {},
  bySeries: {},
};

function pickEnum<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Keeps only recognised keys with valid values; anything else is dropped. */
export function sanitizePrefsPatch(input: unknown): Partial<ReaderPrefs> {
  if (typeof input !== "object" || input === null) return {};
  const raw = input as Record<string, unknown>;
  const out: Partial<ReaderPrefs> = {};
  const mode = pickEnum(READER_MODES, raw["mode"]);
  if (mode) out.mode = mode;
  const fit = pickEnum(READER_FITS, raw["fit"]);
  if (fit) out.fit = fit;
  const direction = pickEnum(READER_DIRECTIONS, raw["direction"]);
  if (direction) out.direction = direction;
  const background = pickEnum(READER_BACKGROUNDS, raw["background"]);
  if (background) out.background = background;
  if (typeof raw["showPageNumbers"] === "boolean") out.showPageNumbers = raw["showPageNumbers"];
  if (typeof raw["coverFirst"] === "boolean") out.coverFirst = raw["coverFirst"];
  return out;
}

/** Parses the JSON blob from storage, tolerating anything malformed. */
export function parseStoredPrefs(raw: string | null | undefined): StoredReaderPrefs {
  if (!raw) return EMPTY_STORED_PREFS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_STORED_PREFS;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY_STORED_PREFS;
  const record = parsed as Record<string, unknown>;

  const byMediaType: Partial<Record<MediaType, Partial<ReaderPrefs>>> = {};
  const rawByMediaType = record["byMediaType"];
  if (typeof rawByMediaType === "object" && rawByMediaType !== null) {
    for (const [key, value] of Object.entries(rawByMediaType)) {
      const patch = sanitizePrefsPatch(value);
      if (Object.keys(patch).length > 0) byMediaType[key as MediaType] = patch;
    }
  }

  const bySeries: Record<string, Partial<ReaderPrefs>> = {};
  const rawBySeries = record["bySeries"];
  if (typeof rawBySeries === "object" && rawBySeries !== null) {
    for (const [key, value] of Object.entries(rawBySeries)) {
      const patch = sanitizePrefsPatch(value);
      if (Object.keys(patch).length > 0) bySeries[key] = patch;
    }
  }

  return { version: READER_PREFS_VERSION, byMediaType, bySeries };
}

/** defaults(mediaType), then the media-type layer, then the series layer. */
export function resolvePrefs(
  stored: StoredReaderPrefs,
  mediaType: MediaType,
  seriesId: string | null | undefined,
): ReaderPrefs {
  const base = defaultPrefsForMediaType(mediaType);
  const media = stored.byMediaType[mediaType] ?? {};
  const series = seriesId ? (stored.bySeries[seriesId] ?? {}) : {};
  return { ...base, ...media, ...series };
}

/** Which layer a settings change is written to. */
export type PrefScope = "media" | "series";

export interface PrefTarget {
  mediaType: MediaType;
  seriesId: string | null | undefined;
  scope: PrefScope;
}

/**
 * Returns a new stored blob with `patch` applied to the requested layer.
 * `scope: "series"` silently falls back to the media layer when there is no
 * series id (the reader can briefly render before the list resolves).
 */
export function applyPrefPatch(
  stored: StoredReaderPrefs,
  target: PrefTarget,
  patch: Partial<ReaderPrefs>,
): StoredReaderPrefs {
  const clean = sanitizePrefsPatch(patch);
  if (Object.keys(clean).length === 0) return stored;

  const seriesId = target.seriesId;
  if (target.scope === "series" && seriesId) {
    return {
      ...stored,
      bySeries: {
        ...stored.bySeries,
        [seriesId]: { ...(stored.bySeries[seriesId] ?? {}), ...clean },
      },
    };
  }

  return {
    ...stored,
    byMediaType: {
      ...stored.byMediaType,
      [target.mediaType]: { ...(stored.byMediaType[target.mediaType] ?? {}), ...clean },
    },
  };
}

/** Drops the per-series layer so the series follows the media-type defaults again. */
export function clearSeriesPrefs(stored: StoredReaderPrefs, seriesId: string): StoredReaderPrefs {
  if (!(seriesId in stored.bySeries)) return stored;
  const bySeries = { ...stored.bySeries };
  delete bySeries[seriesId];
  return { ...stored, bySeries };
}

export function loadStoredPrefs(): StoredReaderPrefs {
  if (typeof window === "undefined") return EMPTY_STORED_PREFS;
  try {
    return parseStoredPrefs(window.localStorage.getItem(READER_PREFS_STORAGE_KEY));
  } catch {
    return EMPTY_STORED_PREFS;
  }
}

export function saveStoredPrefs(stored: StoredReaderPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(READER_PREFS_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage full or blocked - preferences stay in memory for this session.
  }
}

/** Next value in a fixed list, wrapping around. Used by the `m`/`f` shortcuts. */
export function cycleValue<T>(values: readonly T[], current: T): T {
  if (values.length === 0) return current;
  const index = values.indexOf(current);
  return values[(index + 1) % values.length] ?? current;
}
