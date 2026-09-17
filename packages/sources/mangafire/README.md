# @kiri/source-mangafire

A Kiri content-source plugin for [mangafire.to](https://mangafire.to), ported
from the Kiri 1.x standalone ripper (`tools/mangafire-ripper/ripper.mjs`).

```
kiri-plugin.json     the descriptor Kiri validates at install time
src/index.mjs         the plugin: resolve / listChapters / listPages / fetchCover
test/fixtures/        a synthesised local stand-in for mangafire.to
test/mangafire.test.mjs
```

## Cookie requirement — read this before reporting a bug

**mangafire.to is behind Cloudflare**, and Kiri's SDK is deliberately neutral:
it does not fingerprint-spoof TLS, patch around bot detection, or solve
Cloudflare challenges (see `docs/PLUGINS.md` §10, "The neutral-SDK policy").
That is a policy, not a bug — Kiri will never try to bypass a site's own
anti-bot protection.

What the plugin _does_ do:

- pass through whatever cookie/User-Agent the host gives it (`ctx.cookie` /
  `ctx.userAgent`, i.e. `KIRI_COOKIE` / `KIRI_USER_AGENT`) on every request;
- detect a Cloudflare interstitial and raise `NEEDS_CREDENTIAL` — via the
  SDK's own 403/503 detection, **and** via this plugin's own check of the
  response body, because MangaFire has been observed answering a challenge
  with a plain `200` status (the SDK's `HttpClient` only inspects 403/503
  bodies, so a 200-status challenge needs the extra check `assertNotChallenge`
  performs in `src/index.mjs`).

When you see `NEEDS_CREDENTIAL`, do one of:

1. In Kiri's UI, open the series' source panel and paste a fresh `cf_clearance`
   cookie (the whole `Cookie:` header is fine too) captured from a browser
   session that has already solved the challenge, plus the **exact** matching
   User-Agent string. Cookie and User-Agent must be sent together or not at
   all — a mismatched pair looks the same as no credential to Cloudflare.
2. Install the **Kiri Cookie Bridge** browser extension (`extension/` in the
   Kiri repo). It auto-captures the cookie and User-Agent when you visit
   mangafire.to and posts them to Kiri, per-site, with no manual copy/paste.
   This plugin declares the `cookie` capability specifically so its hosts
   (`mangafire.to`, `www.mangafire.to`) show up in the extension's site list.

Cookies expire; `NEEDS_CREDENTIAL` on a series that worked yesterday usually
just means it's time to refresh the cookie, not that anything is broken.

## What the plugin implements

| Hook                        | Job                                                             |
| --------------------------- | --------------------------------------------------------------- |
| `resolve(url, ctx)`         | `/manga/<slug>.<id>` → normalised URL, slug, title, cover, `id` |
| `listChapters(series, ctx)` | scrape the series page's chapter list                           |
| `listPages(chapter, ctx)`   | the chapter's AJAX image list, or an HTML-scrape fallback       |
| `fetchCover(series, ctx)`   | optional: cover bytes from the series page's `og:image`         |

Retries, rate limiting (capped at ~2 req/s, matching V1's default polite
delay), the `hello` handshake, JSON-lines events, downloads with sha256 +
dimensions, the manifest merge, per-chapter checkpointing, cancellation and
exit codes all come from `@kiri/source-sdk`.

### Endpoints and headers this plugin assumes

- Series page: `GET https://mangafire.to/manga/<slug>.<id>` — an HTML page
  whose `<div class="list-body">` lists `<li class="item">` chapter entries
  (href, `data-number`, and a trailing `<span>` release date), and whose
  `<meta property="og:title">` / `<meta property="og:image">` carry the title
  and cover. The manga's short id lives at the end of the slug, after the
  last `.` (`dear-000.0q667` → id `0q667`).
- Chapter images: `GET https://mangafire.to/ajax/read/<mangaId>/chapter/<n>`
  with `Accept: application/json, text/plain, */*` and
  `X-Requested-With: XMLHttpRequest`, `Referer: <chapter URL>`. Response:
  `{"result":{"images":[["<url>", <offset>], ...]}}` — each image is paired
  with a scramble offset. **V1 never descrambled images and only ever read
  the URL** (`entry[0]`); this port does exactly the same and discards the
  offset. If MangaFire's images for a series turn out to need descrambling,
  neither the V1 ripper nor this plugin currently produce a readable result
  for it — that would need a `downloadPage` hook added deliberately, not a
  silent behavior change.
- If the AJAX endpoint is unavailable, the plugin falls back to scraping the
  chapter reader page itself (`GET .../read/<slug>/<lang>/chapter-<n>`) for a
  preloaded `chapterImages`/`cdns` JS array, a `chapImages` variable, or a
  handful of known reader-container selectors — same fallback chain V1 used,
  trimmed from ten candidate containers to the five most common.

### Known simplifications vs. the V1 ripper

- **`mediaType`** is always reported as `"MANGA"`. V1 never classified series
  as manga/manhwa/manhua; the descriptor lists the broader set only so a
  future revision can add real classification without a breaking change.
- **Cover fetching** (`extractCoverUrl`/`fetchCover`) is new in this port —
  V1 never fetched a cover at all. It reads the series page's standard
  OpenGraph image, the same way `extractSeriesTitle` already read `og:title`.
- **`volume`** is left unset. V1 never extracted it either.
- **Chapter list is not "an AJAX endpoint"**: MangaFire's series page already
  renders the full chapter list server-side, and that's what both V1 and this
  port scrape — there is no separate `/ajax/manga/<id>/chapter/<lang>` list
  call to make.
- **Language filtering** is new: V1 computed the page's active reader
  language but never used it (a plain request only ever gets one language).
  This port adds an opt-in filter keyed off a `data-lang` attribute on a
  chapter's `<li>`, driven by the `language` setting (default `"en"`). It is
  a no-op — matching V1's real-world behavior exactly — on any series whose
  markup doesn't carry a `data-lang` tag, which is the common case.

## Testing

```bash
npm test -w packages/sources/mangafire
```

`test/mangafire.test.mjs` spawns the plugin exactly as Kiri does, against a
local fixture server (`test/fixtures/`) that stands in for mangafire.to via
the `MANGAFIRE_BASE` environment variable (the plugin only ever hard-codes
`https://mangafire.to` when `MANGAFIRE_BASE` is unset). Fixture provenance:
mangafire.to is Cloudflare-gated and returned the interstitial to an
unauthenticated request during authoring, so nothing in `test/fixtures/` is a
recording of real traffic — it is synthesised from the response shapes the
ported V1 parser expects. Correctness therefore rests on that V1 parser
having been ported faithfully, not on a recorded fixture matching the live
site byte-for-byte.

## Manual smoke test

```bash
node src/index.mjs hello
MANGAFIRE_BASE=https://mangafire.to node src/index.mjs resolve  "https://mangafire.to/manga/<slug>.<id>"
MANGAFIRE_BASE=https://mangafire.to node src/index.mjs discover "https://mangafire.to/manga/<slug>.<id>"
```

Without a cookie, expect `resolve`/`discover` against the real site to exit
**3** with `error.code = "NEEDS_CREDENTIAL"` — that is success, not failure:
it means the plugin recognised the Cloudflare wall and reported it correctly
instead of hanging or crashing. `MANGAFIRE_BASE` is optional against the real
site (it defaults to `https://mangafire.to`); it exists so the test suite can
point the plugin at a local fixture server instead.
