# @kiri/source-mangadex

Kiri 2.0 content-source plugin for [MangaDex](https://mangadex.org). Ported
from the Kiri 1.x standalone tool at `tools/mangadex-ripper/ripper.mjs`; see
`docs/PLUGINS.md` in the Kiri repo for the plugin contract this implements.

## What it supports

- **Resolve**: `https://mangadex.org/title/<uuid>[/slug]` and the legacy
  `https://mangadex.org/manga/<uuid>[...]` shape. Title picks
  `attributes.title.en` first, then `altTitles` in `en` / `ja-ro` / `ja`
  order. `mediaType` is inferred from `originalLanguage`: `ko` → `MANHWA`,
  `zh`/`zh-hk` → `MANHUA`, everything else → `MANGA`. The cover comes from the
  manga's `cover_art` relationship (512px thumbnail rendition).
- **Discover**: paginates `/manga/{id}/feed` (500/page, `order[chapter]=asc`,
  all four content ratings, `includeExternalUrl=0`). Every scanlation of every
  chapter number is fetched; chapters that share a number (multiple groups
  translating the same chapter) are **deduplicated, keeping the earliest
  `publishAt`**. This is new behaviour, not a straight port: Kiri 1.x slugged
  chapters by MangaDex chapter UUID (`chapter-<uuid>`) and so never had a
  collision; this plugin slugs by chapter number (`chapter-<n>`, e.g.
  `chapter-12`, `chapter-3-5` for chapter 3.5) to give Kiri stable,
  human-readable chapter directories, which makes the dedupe necessary — two
  scanlations of the same number would otherwise race to write the same
  directory. A chapter with no parseable number falls back to
  `chapter-<uuid prefix>` and is never merged with anything.
- **Sync**: downloads pages via MangaDex@Home (`/at-home/server/{chapterId}`
  → `{baseUrl}/data(-saver)/{hash}/{file}`).
- **Cover**: fetched once via `fetchCover`.

## Settings

| Key         | Type      | Default | Meaning                                                                           |
| ----------- | --------- | ------- | --------------------------------------------------------------------------------- |
| `language`  | `string`  | `"en"`  | Translated language code(s), comma separated (e.g. `en,es`).                      |
| `dataSaver` | `boolean` | `false` | Download the compressed MangaDex@Home data-saver images instead of the originals. |

Two more settings are read but intentionally **not** declared in
`kiri-plugin.json` (so they don't show up in the source-settings UI):
`apiBase` and `uploadsBase` override the MangaDex API and cover-upload hosts,
and can also be set via the `MANGADEX_API_BASE` / `MANGADEX_UPLOADS_BASE`
environment variables. They exist so the test suite can point the plugin at a
local fixture server instead of the real API — see `test/mangadex.test.mjs`.
A `groupFilter` setting (filter by scanlation group) was considered and
skipped, per the porting brief.

## Rate limits

MangaDex's API acceptable-use guidance asks integrations to stay at or below
5 requests/second and to send a descriptive User-Agent. This plugin sets
`requestsPerSecond: 4` and `User-Agent: Kiri/2.0
(+https://github.com/spooknik/Kiri2)` on the shared `ctx.http` client (see
`docs/PLUGINS.md` §6 for the retry/backoff defaults layered on top).

## Known limitations

- **No cookie/browser support.** MangaDex's API and MangaDex@Home CDN do not
  require a login for public content, so this plugin only declares the
  `network` capability. A Cloudflare interstitial, if MangaDex ever puts one
  in front of the API, surfaces as `NEEDS_CREDENTIAL` like any other site (see
  the SDK's neutral-SDK policy in `docs/PLUGINS.md` §10) but has not been
  observed in practice.
- **Occasional transient 404s from MangaDex@Home.** An `@Home` node
  sometimes answers a request for an image it hasn't cached yet from its
  upstream with a 404 instead of fetching it lazily; a moment later (or on a
  fresh `/at-home/server` token) the same URL succeeds. The SDK's shared
  `ctx.http` treats 404 as terminal (`NOT_FOUND`, not retried) for every site,
  since that's the correct behaviour for a page that's actually gone. When
  this happens the affected chapter is marked `failed` with the 404 in
  `lastError`; a plain `sync` re-run fetches a fresh at-home token (often a
  different, healthy node) and normally succeeds. Observed live while writing
  this plugin — see the confidence note below.
- **No scanlation-group filter.** Every group's chapters are discovered;
  the numeric dedupe (above) picks one automatically. A `groupFilter` setting
  was in scope for consideration and explicitly skipped.
- **`data-saver` note**: MangaDex@Home always returns both file lists in one
  `/at-home/server` response; the `dataSaver` setting only changes which list
  (and which URL path segment, `data` vs `data-saver`) this plugin requests,
  not the endpoint it calls.

## Testing

`npm test -w packages/sources/mangadex` runs `test/mangadex.test.mjs`
(Vitest). Two layers:

- Pure unit tests against `src/mangadex.mjs` (URL/UUID parsing, title
  selection, media-type inference, chapter-number parsing, dedupe, feed URL
  building, at-home file-list selection). The feed-pagination loop is tested
  with a real `HttpClient` whose `fetchImpl` is mocked to return two distinct
  paginated responses (a first page with a duplicate scanlation, then an
  empty page) — the SDK's `startFixtureServer` is a static file server that
  dispatches on pathname only and cannot vary a response by query string, so
  true multi-page HTTP pagination isn't representable through it; mocking
  `HttpClient` exercises the real production pagination code instead.
- End-to-end subprocess tests (`runPlugin` + `startFixtureServer`) covering
  `hello`/`resolve`/`discover`/`sync`/`verify` against fixtures under
  `test/fixtures/`. `manga.json` and `feed.json` are real recorded responses
  (`curl`, public data) for a small MangaDex one-shot-style series chosen
  because three of its ten chapters have more than one scanlation — live
  proof of the dedupe scenario. `at-home.chapter-*.json` are templated from a
  real recorded `/at-home/server` response with `baseUrl` as a placeholder,
  substituted with the fixture server's own address once it's listening.
  Page and cover images are tiny generated PNGs, not downloaded ones. The
  plugin is pointed at the fixture server via the `apiBase`/`uploadsBase`
  settings (see above), while the URL passed on argv stays a real-looking
  `https://mangadex.org/...` URL, since `resolve` only accepts that host.

## Live verification

`resolve`, `discover` and `sync --limit 1`/`--chapter` were run against the
real MangaDex API against
`https://mangadex.org/title/c77d242d-437c-4a4a-aec3-06bf86a96821/kagakubu-girl`
("Kagakubu Girl" / "Science Department Girl", a small ongoing series). Title
selection, media-type inference, cover URL, feed pagination and the
chapter-number dedupe (10 raw feed entries → 7 chapters) all matched
hand-checked expectations from the raw API responses. A `sync` of one chapter
hit the transient MangaDex@Home 404 described above on the first two
attempts and succeeded on a plain re-run, landing a real page image and a
real cover file; the scratch output directory was deleted afterwards.
