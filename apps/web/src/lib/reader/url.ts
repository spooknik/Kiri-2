/**
 * `/read` query-parameter contract.
 *
 * The reader is a single static route driven entirely by its query string:
 * `/read?series=<id>&chapter=<id>&page=<n>`. `page` is **1-based** in the URL
 * (what a reader would say out loud) while everything inside the app — and the
 * `ReadingPosition` API — uses a 0-based `pageIndex`.
 */
export interface ReaderRouteParams {
  seriesId: string | null;
  chapterId: string | null;
  /** 1-based page number from the URL, or null when absent/invalid. */
  page: number | null;
}

function readParam(source: URLSearchParams, key: string): string | null {
  const value = source.get(key);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Accepts a `URLSearchParams`, a raw query string, or a full/relative URL. */
export function parseReaderParams(
  source: URLSearchParams | string | null | undefined,
): ReaderRouteParams {
  let params: URLSearchParams;
  if (source instanceof URLSearchParams) {
    params = source;
  } else if (typeof source === "string") {
    const queryStart = source.indexOf("?");
    params = new URLSearchParams(queryStart >= 0 ? source.slice(queryStart + 1) : source);
  } else {
    params = new URLSearchParams();
  }

  const rawPage = readParam(params, "page");
  const parsedPage = rawPage === null ? Number.NaN : Number.parseInt(rawPage, 10);
  const page = Number.isInteger(parsedPage) && parsedPage >= 1 ? parsedPage : null;

  return {
    seriesId: readParam(params, "series"),
    chapterId: readParam(params, "chapter"),
    page,
  };
}

export interface ReaderLinkParams {
  seriesId: string;
  chapterId?: string | null;
  /** 0-based; serialised as the 1-based `page` parameter. Index 0 is omitted. */
  pageIndex?: number | null;
}

/** Serialises reader params to a query string including the leading `?`. */
export function buildReaderSearch({ seriesId, chapterId, pageIndex }: ReaderLinkParams): string {
  const params = new URLSearchParams();
  params.set("series", seriesId);
  if (chapterId) params.set("chapter", chapterId);
  if (typeof pageIndex === "number" && Number.isFinite(pageIndex) && pageIndex > 0) {
    params.set("page", String(Math.floor(pageIndex) + 1));
  }
  return `?${params.toString()}`;
}

/** `/read?...` href for the given position. */
export function readerHref(params: ReaderLinkParams): string {
  return `/read${buildReaderSearch(params)}`;
}

/** URL `page` (1-based, possibly null) → internal 0-based index. */
export function pageIndexFromParam(page: number | null): number | null {
  if (page === null) return null;
  return Math.max(0, page - 1);
}
