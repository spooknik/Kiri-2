/**
 * Filename helpers for chapter page images, ported from V1
 * (`src/lib/pdf-import.ts` `padIndex`). Page files are named so plain
 * lexicographic directory listings stay in reading order regardless of the
 * OS or file browser used to inspect `DATA_ROOT` directly.
 */

/**
 * Zero-pad `index` to the width of `total` (minimum 3 digits), e.g.
 * `padIndex(7, 120)` → `"007"`, `padIndex(7, 12000)` → `"00007"`.
 */
export function padIndex(index: number, total: number): string {
  const width = Math.max(3, String(total).length);
  return String(index).padStart(width, "0");
}

/** `pageFileName(7, 120, "webp")` → `"007.webp"`. Accepts `ext` with or without a leading dot. */
export function pageFileName(index: number, total: number, ext: string): string {
  const cleanExt = ext.startsWith(".") ? ext.slice(1) : ext;
  return `${padIndex(index, total)}.${cleanExt}`;
}
