/**
 * Validation for the `next` parameter every sign-in path carries.
 *
 * `next` is attacker-controlled (it arrives on a link) and ends up in
 * `router.replace()`, an `<a href>` and a `NextResponse.redirect()`, so an
 * unvalidated value is an open redirect: `/login?next=https://evil.example`
 * turns Kiri's own login page into a phishing hop.
 *
 * The rules are deliberately narrow — only a same-origin absolute path is
 * accepted, anything else collapses to `/`:
 *
 * - Tab, LF and CR are stripped first. The URL parser ignores them, so
 *   `"/\t/evil.example"` parses as `//evil.example` (a protocol-relative URL)
 *   even though it does not *look* protocol-relative to a naive prefix check.
 * - The value must start with a single `/` and must not continue with `/` or
 *   `\` (`//host` and `/\host` are both protocol-relative in browsers).
 * - No backslashes and no whitespace anywhere.
 * - Finally the value is resolved against a throwaway origin; anything that
 *   escapes that origin (a scheme, an authority) is rejected.
 */

/** Characters the URL parser silently drops, which is what makes them useful. */
const STRIPPED = /[\t\n\r]/g;

/** A single leading slash, no protocol-relative continuation, no whitespace. */
const ABSOLUTE_PATH = /^\/(?![/\\])[^\s]*$/;

const PROBE_ORIGIN = "http://safe-next.invalid";

/**
 * Normalize an untrusted `next` value to a same-origin path, or `/`.
 *
 * @param raw The raw parameter, as read from the query string.
 */
export function safeNext(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "/";
  const value = raw.replace(STRIPPED, "");
  if (!ABSOLUTE_PATH.test(value)) return "/";
  if (value.includes("\\")) return "/";
  try {
    if (new URL(value, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return "/";
  } catch {
    return "/";
  }
  return value;
}
