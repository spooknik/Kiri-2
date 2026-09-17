/**
 * `@displayName` mentions inside a note body.
 *
 * Display names are free text and can contain spaces ("Reading Club"), so a
 * `@\w+` regex is not enough: the body is scanned for `@` and the *longest*
 * candidate display name that follows it wins. Matching is case-insensitive,
 * and an `@` preceded by a word character is skipped so e-mail addresses in a
 * note never notify anybody.
 *
 * Candidates come from the caller (`src/lib/notes/service.ts` asks for the
 * users who can view the series), which keeps this module pure and testable.
 */

export interface MentionCandidate {
  id: string;
  displayName: string;
}

/** Characters that stop an `@` from starting a mention when they precede it. */
const MENTION_BOUNDARY = /[\w@.]/;

/**
 * Ids of every candidate mentioned in `body`, in first-appearance order and
 * deduplicated. Nothing is matched for an empty display name.
 */
export function findMentions(body: string, candidates: readonly MentionCandidate[]): string[] {
  if (body === "" || candidates.length === 0) return [];

  // Longest first, so "@Ann Marie" beats "@Ann" when both exist.
  const byLength = candidates
    .filter((candidate) => candidate.displayName.trim() !== "")
    .map((candidate) => ({ id: candidate.id, needle: candidate.displayName.toLowerCase() }))
    .sort((a, b) => b.needle.length - a.needle.length);
  if (byLength.length === 0) return [];

  const haystack = body.toLowerCase();
  const found: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "@") continue;
    const previous = index > 0 ? body[index - 1] : undefined;
    if (previous !== undefined && MENTION_BOUNDARY.test(previous)) continue;

    for (const candidate of byLength) {
      if (!haystack.startsWith(candidate.needle, index + 1)) continue;
      if (!seen.has(candidate.id)) {
        seen.add(candidate.id);
        found.push(candidate.id);
      }
      // Skip past the matched name so "@Ann" inside "@Ann Marie" is not re-read.
      index += candidate.needle.length;
      break;
    }
  }

  return found;
}
