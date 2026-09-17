# @kiri/source-template

A **working** Kiri content-source plugin, and the fixture site it rips. Copy
this directory to start a new plugin; the SDK's own end-to-end tests run against
it, so it is always known-good.

```
kiri-plugin.json     the descriptor Kiri validates at install time
src/index.mjs        the plugin: four hooks on top of `definePlugin`
fixture-site/        a tiny static "manga site" (1 series, 3 chapters, 3 pages each)
serve.mjs            dev server for fixture-site/
```

## Run it

```bash
# 1. build the SDK once (the plugin imports it through the workspace link)
npm run build -w packages/source-sdk

# 2. serve the fixture site
cd packages/source-template
node serve.mjs            # http://127.0.0.1:8787

# 3. drive the plugin exactly as Kiri would, in another terminal
node src/index.mjs hello
node src/index.mjs resolve  http://127.0.0.1:8787/series/starlight-express/
node src/index.mjs discover http://127.0.0.1:8787/series/starlight-express/
node src/index.mjs sync     http://127.0.0.1:8787/series/starlight-express/ --output ./out
node src/index.mjs verify   --output ./out

# useful flags
node src/index.mjs sync <url> --output ./out --limit 1
node src/index.mjs sync <url> --output ./out --chapter chapter-2 --force
KIRI_VERBOSE=1 node src/index.mjs sync <url> --output ./out    # mirror events to stderr
```

`sync` writes `out/manifest.json`, `out/cover.png` and `out/chapter-N/00X.png`.
Every line on stdout is one JSON event — that is the host protocol, not decoration.

## The fixture site

`fixture-site/series/starlight-express/` mirrors the shape of a real reader:

| File                      | Contents                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `series.json`             | `{ id, slug, title, mediaType, cover }`                                                    |
| `index.html`              | chapter links, **newest first**, with `data-number`, `data-id`, `data-volume`, `data-date` |
| `chapters/<n>/index.html` | three `<img src="pNN.png">` tags with relative URLs                                        |
| `chapters/<n>/pNN.png`    | ~80-byte real PNGs, each a different size                                                  |

Newest-first listing and relative URLs are deliberate: a plugin has to carry
`chapterOrder` through (Kiri sorts on it) and resolve page URLs against the
chapter URL.

## What the plugin actually implements

Only the site-specific parts:

| Hook                        | Job                                                      |
| --------------------------- | -------------------------------------------------------- |
| `resolve(url, ctx)`         | is this my URL? → normalised URL, slug, title, cover URL |
| `listChapters(series, ctx)` | scrape the chapter list                                  |
| `listPages(chapter, ctx)`   | scrape one chapter's image URLs                          |
| `fetchCover(series, ctx)`   | optional: cover bytes                                    |

Retries, rate limiting, the `hello` handshake, JSON-lines events, downloads with
sha256 + dimensions, the manifest merge, per-chapter checkpointing, cancellation
and exit codes all come from `@kiri/source-sdk`.

The authoring guide — descriptor reference, full ABI, packaging, and the recipe
for porting a Kiri V1 ripper — is in [`docs/PLUGINS.md`](../../docs/PLUGINS.md).
