/**
 * Opaque library cursors.
 *
 * Keyset pagination, not offsets: a cursor carries the sort value of the last
 * row on the page plus its series id as the tie-break, so inserting or
 * deleting a series while the user scrolls can never duplicate or skip a row.
 * The encoding is base64url JSON — opaque to clients on purpose, so the sort
 * key can change without breaking them.
 */

/** ISO date string, sort title, ts_rank score, or null (nulls sort last). */
export type CursorValue = string | number | null;

export interface LibraryCursor {
  /** Sort value of the last row of the previous page. */
  v: CursorValue;
  /** Series id of that row; the stable tie-break. */
  id: string;
}

export function encodeCursor(cursor: LibraryCursor): string {
  const payload = JSON.stringify({ v: cursor.v, id: cursor.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/** Returns null for anything that is not a cursor this module produced. */
export function decodeCursor(raw: string): LibraryCursor | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { v, id } = parsed as { v?: unknown; id?: unknown };
  if (typeof id !== "string" || id === "") return null;
  if (v !== null && v !== undefined && typeof v !== "string" && typeof v !== "number") return null;
  return { v: v ?? null, id };
}
