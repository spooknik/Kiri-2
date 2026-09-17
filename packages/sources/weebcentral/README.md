# @kiri/source-weebcentral

Kiri content-source plugin for [WeebCentral](https://weebcentral.com), converted
from the Kiri 1.x standalone ripper (`tools/weebcentral-ripper/ripper.mjs` in the
v1 Kiri repo).

## Capabilities

- `network` only — no cookies, no browser. WeebCentral serves chapter images
  from an open CDN with no login wall or bot challenge (as of 2026-09-10).
- Media types: `MANGA`, `MANHWA`, `MANHUA` (taken from the series page's
  `Type:` field; anything else falls back to `MANGA`).

## How it works

- **`resolve`** accepts `https://weebcentral.com/series/<id>[/<slug>]` (the
  slug is cosmetic — the site routes on `<id>` alone). It fetches the series
  page once and reads `og:title`/`<title>` for the title, `og:image` for the
  cover, `og:url`'s path for the canonical slug, and the `Type:`/`Status:`
  fields for the media type.
- **`listChapters`** fetches both the series page's `#chapter-list` and
  `/series/<id>/full-chapter-list` (an htmx fragment) and merges them by
  chapter id. The series page only shows a handful of recent chapters; the
  full list is authoritative for a long-running series. Chapter number comes
  from parsing "Chapter N" / "Episode N" out of the chapter title.
- **`listPages`** builds `/chapters/<id>/images?is_prev=False&current_page=1&reading_style=long_strip`
  directly from the chapter id and reads the `<img src>` tags in the
  response. `reading_style=long_strip` returns every page of the chapter in
  one response, regardless of the site's paginated reader UI.
- **`fetchCover`** downloads `og:image` once.

### A markup change since the V1 ripper

V1 discovered the images endpoint by reading an `hx-get` attribute off the
chapter page. As of 2026-09-10 that attribute is gone from the live markup —
the chapter page now fires the same request from an inline
`htmx.ajax('GET', ".../chapters/<id>/images?is_prev=False", …)` call instead
of a static attribute. The endpoint's shape is unchanged and `<id>` is
already known from the chapter URL, so this port builds the URL directly
instead of scraping the chapter page for it. That is also one fewer request
per chapter than V1 made.

## Testing

```bash
npm test -w packages/sources/weebcentral
```

Runs against a local fixture server (`test/fixtures/site/`) built from HTML
recorded once from the live site with `curl`, trimmed of scripts/styles/nav
chrome, with the cover and page images repointed at tiny generated PNGs
served locally. Set `WEEBCENTRAL_BASE` to point `resolve`'s host allowlist at
that fixture server instead of `weebcentral.com`; the plugin also runs
noticeably faster (no politeness throttling) in this mode, since every URL it
builds derives its origin from the URL it was given rather than a hardcoded
`https://weebcentral.com`.

## Politeness

`requestsPerSecond: 2`, 3 retries with exponential backoff — matches V1's
`--concurrency 3 --delay-ms 400` defaults.
