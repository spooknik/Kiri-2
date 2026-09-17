/**
 * Pure helpers for the add/edit series form: turning free-form UI state into
 * a validated `CreateSeriesInput`, parsing the tag-chip input, and reading a
 * MAL search result / a 409 conflict response back into form state.
 *
 * Kept dependency-free (no React) so it's trivially unit-testable — see
 * `series-form-utils.test.ts`.
 */
import { ApiClientError } from "@/lib/api-client";
import type {
  CreateSeriesInput,
  MediaType,
  ReadingStatus,
  SeriesDetail,
  UpdateSeriesInput,
  Visibility,
} from "@/lib/contracts/series";
import type { MalSearchResult } from "@/lib/contracts/search";

export interface SeriesFormValues {
  title: string;
  originalTitle: string;
  mediaType: MediaType;
  publicationYear: string;
  totalChapters: string;
  totalVolumes: string;
  tags: string[];
  synopsis: string;
  sourceUrl: string;
  coverUrl: string;
  visibility: Visibility;
  isAdult: boolean;
  /**
   * Not exposed in the base add-series form (create fields per spec don't
   * include it); `EditSeriesDialog` renders the switch itself and overrides
   * this at submit time. Always `false` for new series created here.
   */
  isBookClub: boolean;
  malId: number | null;
  status: ReadingStatus;
  currentChapter: string;
}

export const EMPTY_SERIES_FORM_VALUES: SeriesFormValues = {
  title: "",
  originalTitle: "",
  mediaType: "MANGA",
  publicationYear: "",
  totalChapters: "",
  totalVolumes: "",
  tags: [],
  synopsis: "",
  sourceUrl: "",
  coverUrl: "",
  visibility: "SHARED",
  isAdult: false,
  isBookClub: false,
  malId: null,
  status: "PLAN_TO_READ",
  currentChapter: "0",
};

/** Trims, dedupes (case-insensitively) and caps a tag list at 30 entries. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    result.push(tag);
  }
  return result.slice(0, 30);
}

/** Parses comma-separated free text (typed or pasted) into tag chips. */
export function parseTagsInput(input: string): string[] {
  return normalizeTags(input.split(","));
}

function toOptionalInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Chapter numbers may be fractional (e.g. "10.5"); never negative. */
export function toChapterNumber(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Converts the string-backed, form-friendly UI state into `CreateSeriesInput`. */
export function formValuesToCreateInput(values: SeriesFormValues): CreateSeriesInput {
  return {
    title: values.title.trim(),
    originalTitle: values.originalTitle.trim() || null,
    synopsis: values.synopsis.trim() || null,
    mediaType: values.mediaType,
    visibility: values.visibility,
    isAdult: values.isAdult,
    isBookClub: values.visibility === "PRIVATE" ? false : values.isBookClub,
    publicationYear: toOptionalInt(values.publicationYear),
    totalChapters: toOptionalInt(values.totalChapters),
    totalVolumes: toOptionalInt(values.totalVolumes),
    tags: normalizeTags(values.tags),
    sourceUrl: values.sourceUrl.trim() || null,
    coverUrl: values.coverUrl.trim() || null,
    malId: values.malId,
    status: values.status,
    currentChapter: toChapterNumber(values.currentChapter),
  };
}

/**
 * Derives an update patch from an already-validated `CreateSeriesInput`
 * (i.e. the value `SeriesForm.onValidSubmit` hands back), stripping the
 * create-only status/currentChapter fields. `coverUrl` is included only
 * when the user actually typed a new one — an empty/untouched field must
 * not be sent as `null`, since `removeCover` is the explicit signal to
 * clear the stored cover.
 */
export function createInputToUpdateInput(
  input: CreateSeriesInput,
  extra: { isBookClub?: boolean; removeCover?: boolean } = {},
): UpdateSeriesInput {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to exclude them from `rest`
  const { status, currentChapter, coverUrl, ...rest } = input;
  return {
    ...rest,
    ...(coverUrl ? { coverUrl } : {}),
    ...extra,
  };
}

/** Prefills the shared form from a MyAnimeList search result. */
export function malResultToFormValues(
  result: MalSearchResult,
  base: SeriesFormValues = EMPTY_SERIES_FORM_VALUES,
): SeriesFormValues {
  return {
    ...base,
    title: result.title,
    originalTitle: result.originalTitle ?? "",
    mediaType: result.mediaType,
    publicationYear: result.publicationYear != null ? String(result.publicationYear) : "",
    totalChapters: result.totalChapters != null ? String(result.totalChapters) : "",
    totalVolumes: result.totalVolumes != null ? String(result.totalVolumes) : "",
    tags: normalizeTags(result.tags),
    synopsis: result.synopsis ?? "",
    sourceUrl: result.url,
    coverUrl: result.coverUrl ?? "",
    malId: result.malId,
  };
}

/**
 * Prefills the edit form from an existing series. `coverUrl` is left blank:
 * `SeriesDetail.coverUrl` is the served `/api/series/:id/cover` URL, not a
 * re-fetchable source URL, so it can't round-trip through the form field.
 */
export function seriesDetailToFormValues(detail: SeriesDetail): SeriesFormValues {
  return {
    title: detail.title,
    originalTitle: detail.originalTitle ?? "",
    mediaType: detail.mediaType,
    publicationYear: detail.publicationYear != null ? String(detail.publicationYear) : "",
    totalChapters: detail.totalChapters != null ? String(detail.totalChapters) : "",
    totalVolumes: detail.totalVolumes != null ? String(detail.totalVolumes) : "",
    tags: detail.tags,
    synopsis: detail.synopsis ?? "",
    sourceUrl: detail.sourceUrl ?? "",
    coverUrl: "",
    visibility: detail.visibility,
    isAdult: detail.isAdult,
    isBookClub: detail.isBookClub,
    malId: detail.malId,
    status: detail.entry?.status ?? "PLAN_TO_READ",
    currentChapter: detail.entry ? String(detail.entry.currentChapter) : "0",
  };
}

/** Reads `details.existingSeriesId` off a 409 CONFLICT from `POST /api/series`. */
export function getExistingSeriesId(error: unknown): string | null {
  if (!(error instanceof ApiClientError) || error.status !== 409) return null;
  const details = error.details as { existingSeriesId?: unknown } | undefined;
  return typeof details?.existingSeriesId === "string" ? details.existingSeriesId : null;
}
