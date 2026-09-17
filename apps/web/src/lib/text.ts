/**
 * String helpers shared by the API, the importer and the content store.
 * Pure functions only - no I/O, no env, safe to use from anywhere.
 */

const COMBINING_MARKS = /\p{M}+/gu;
const LEADING_ARTICLE = /^(?:the|a|an)\s+/;
// Characters no filesystem we target accepts, plus the C0 control range.
const ILLEGAL_PATH_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

const MAX_TAGS = 30;
const MAX_TAG_LENGTH = 40;

/**
 * Sort key for series titles: de-accented, lowercased, article-stripped.
 * Stored in `Series.sortTitle` so PostgreSQL can order without a collation
 * dance. Falls back to the de-accented title when stripping leaves nothing.
 */
export function toSortTitle(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const stripped = base.replace(LEADING_ARTICLE, "").trim();
  return stripped.length > 0 ? stripped : base;
}

/**
 * Make one path segment safe to join into the content store. Ported from V1
 * (`src/lib/ripper-sites.ts`), with traversal segments and empty results
 * mapped to "_" so a bad name can never resolve to a parent directory.
 */
export function sanitizePathSegment(value: string): string {
  const cleaned = value.replace(ILLEGAL_PATH_CHARS, "_").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return "_";
  }
  return cleaned;
}

/** True for absolute http(s) URLs only - never file:, data: or javascript:. */
export function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Normalise user- or importer-supplied tags: strings only, trimmed, clipped to
 * 40 characters, de-duplicated case-insensitively (first spelling wins), at
 * most 30 tags. Anything else in the input is dropped rather than rejected.
 */
export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH).trim();
    if (tag === "") continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Clip to `max` characters, appending an ellipsis when anything was cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
