# Writing a Kiri content source plugin

Kiri ships with **no** content sources. Every site is a plugin: a small Node
program that Kiri installs into `DATA_ROOT/plugins/<id>/` and runs as a
subprocess. This document is the contract and the authoring guide.

Start from [`packages/source-template`](../packages/source-template) — it is a
complete, tested plugin against a local fixture site. Copy it, change four
hooks, done.

- [1. How a plugin runs](#1-how-a-plugin-runs)
- [2. The descriptor: `kiri-plugin.json`](#2-the-descriptor-kiri-pluginjson)
- [3. The subprocess ABI](#3-the-subprocess-abi)
- [4. Manifest v2](#4-manifest-v2)
- [5. `definePlugin` walkthrough](#5-defineplugin-walkthrough)
- [6. The toolbox: `ctx`](#6-the-toolbox-ctx)
- [7. Errors](#7-errors)
- [8. Testing](#8-testing)
- [9. Packaging and installing](#9-packaging-and-installing)
- [10. The neutral-SDK policy](#10-the-neutral-sdk-policy)
- [11. Porting a Kiri V1 ripper](#11-porting-a-kiri-v1-ripper)
- [12. Checklist](#12-checklist)

---

## 1. How a plugin runs

1. A user pastes a series URL. Kiri matches the URL's host against the `hosts`
   of every enabled plugin and runs `node <entry> resolve <url>` on the
   candidates in parallel. The first `handled` answer wins and becomes the
   series' source.
2. A `SOURCE_SYNC` job runs `node <entry> sync <url> --output <seriesDir>`. The
   plugin downloads images into that directory and maintains `manifest.json`.
3. Kiri **ingests** the manifest into the database (chapters, pages,
   dimensions, notifications) and serves the reader from the database. Kiri
   never reads the manifest at request time.

Three properties follow from this and matter more than anything else in this
document:

- **stdout is a protocol, not a log.** One JSON object per line. Use
  `ctx.log.*` (or plain `console.log`, which the SDK reroutes) for messages.
- **The series directory is yours, and it is checkpointed.** The SDK rewrites
  `manifest.json` after every chapter, so a job that is killed mid-sync leaves a
  consistent directory that the next run resumes from.
- **Nothing secret is on `argv`.** Cookies and settings arrive through the
  environment, because `argv` is visible in `ps`.

---

## 2. The descriptor: `kiri-plugin.json`

Sits at the root of the plugin directory (and at the root of the zip). Kiri
validates it at install time and at every boot.

```jsonc
{
  "id": "mangadex", // ^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$; MUST equal the directory name
  "name": "MangaDex", // shown in the admin UI
  "version": "1.2.0", // semver; bump it when you publish
  "sdk": "^2.0.0", // @kiri/source-sdk range this plugin needs
  "entry": "./src/index.mjs", // relative to the plugin directory
  "hosts": ["mangadex.org", "*.mangadex.org"], // one '*' label allowed, leftmost only
  "capabilities": ["network"], // subset of: network | cookie | browser | subprocess
  "mediaTypes": ["MANGA"], // MANGA MANHWA MANHUA COMIC LIGHT_NOVEL NOVEL BOOK OTHER
  "adult": false,
  "homepage": "https://github.com/…",
  "license": "MIT",
  "minKiriVersion": "2.0.0",
  "settings": [
    { "key": "language", "type": "string", "default": "en", "label": "Translated language" },
  ],
}
```

| Field          | Notes                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | Identity of the plugin everywhere: directory name, `Plugin.id`, `manifest.site`. Changing it is a new plugin.                                                                                  |
| `sdk`          | Checked against the SDK the host actually links. A mismatch exits **7** before any work happens. `^x.y.z`, `~x.y.z`, `>=`, `<`, `=`, `A \|\| B` and `*` are supported.                         |
| `hosts`        | Drives the `resolve` fan-out and the cookie-bridge host list. Keep it tight: a plugin that claims `*.com` is asked about every link.                                                           |
| `capabilities` | Declarative. `cookie` puts the plugin's hosts in the browser extension's list; `browser`/`subprocess` show a warning badge and relax the sandbox flags. They are **not** a security boundary.  |
| `settings`     | Rendered as a form on the series' source panel; the values reach the plugin as `KIRI_SETTINGS` (→ `ctx.settings`). `type`: `string \| number \| boolean \| select` (`select` needs `options`). |

---

## 3. The subprocess ABI

### Verbs

| Verb       | argv                                                                             | Emits                                                                                                                                        | Exit |
| ---------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `hello`    | `node <entry> hello`                                                             | `hello`                                                                                                                                      | 0    |
| `resolve`  | `node <entry> resolve <url>`                                                     | `hello`, `result{handled, normalizedUrl, slug, title?, mediaType?, coverUrl?, externalId?}`                                                  | 0    |
| `discover` | `node <entry> discover <url>`                                                    | `hello`, `chapter`×n, `result{chapterCount, series}`                                                                                         | 0    |
| `sync`     | `node <entry> sync <url> --output <dir> [--limit n] [--force] [--chapter slug]…` | `hello`, `progress`, `chapter`, `result{chaptersTotal, chaptersCompleted, chaptersFailed, pagesDownloaded}` + manifest on disk               | 0    |
| `verify`   | `node <entry> verify --output <dir>`                                             | `hello`, `progress`, `chapter`, `result{chaptersTotal, chaptersCompleted, chaptersFailed, pagesVerified, pagesMissing}` + rewritten statuses | 0    |

- `--output=<dir>` and `--output <dir>` are both accepted; `KIRI_OUTPUT_DIR` is
  the fallback.
- `--limit n` caps how many _pending_ chapters this run downloads.
- `--force` re-downloads completed chapters and existing page files.
- `--chapter slug` (repeatable) syncs exactly those chapters, completed or not.
  An unknown slug is `NOT_FOUND` (exit 4).
- A URL this plugin does not handle is **not** an error for `resolve`: it emits
  `result{handled:false}` and exits 0. For `discover`/`sync` it is
  `UNSUPPORTED_URL` (exit 4).

### Environment

The host passes an allowlist and strips its own secrets (`DATABASE_URL`,
`APP_SECRET`, …).

| Variable                 | Meaning                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| `KIRI_COOKIE`            | Raw `Cookie:` header for the site (per-series cookie, else the plugin credential) |
| `KIRI_USER_AGENT`        | The User-Agent the cookie was captured with — send both or neither                |
| `KIRI_OUTPUT_DIR`        | Series directory (`--output` wins)                                                |
| `KIRI_PLUGIN_DIR`        | Directory holding `kiri-plugin.json`                                              |
| `KIRI_SDK_VERSION`       | SDK version the host linked (checked against `sdk`)                               |
| `KIRI_APP_VERSION`       | Kiri version                                                                      |
| `KIRI_VERBOSE`           | `1` → debug logs, and every event is mirrored to stderr                           |
| `KIRI_CONCURRENCY`       | Page download concurrency (default 4, max 16)                                     |
| `KIRI_SETTINGS`          | JSON object of the source's settings → `ctx.settings`                             |
| `PLAYWRIGHT_*`, `TMPDIR` | For the browser helper and temp files                                             |

### Events (stdout, one JSON object per line)

```jsonc
{"t":"hello","v":1,"plugin":"mangadex","version":"1.2.0","sdk":"2.0.0"}
{"t":"log","level":"info","msg":"…"}                       // debug | info | warn | error
{"t":"progress","phase":"page","current":3,"total":18,"chapterSlug":"chapter-12","bytes":204800}
{"t":"chapter","slug":"chapter-12","title":"Chapter 12","number":12,"pageCount":18,"status":"completed"}
{"t":"result","ok":true,"data":{…}}
{"t":"error","ok":false,"code":"NEEDS_CREDENTIAL","message":"…","retryable":false,"hint":"…"}
```

- `hello` **must** be the first line; the host allows 15 s for it.
- Phases used by the SDK: `resolve`, `cover`, `discover`, `chapter`, `page`,
  `verify`. Anything else you emit is passed through.
- `status` is one of `pending | downloading | completed | failed`.
- Unparseable stdout lines become `warn` logs on the host. stderr is free text
  and is tailed into the job log.

### Error codes and exit codes

| Code               | Meaning                                                             | `retryable` | Exit |
| ------------------ | ------------------------------------------------------------------- | ----------- | ---- |
| `NEEDS_CREDENTIAL` | Cookie/User-Agent missing, expired, or a bot challenge was detected | false       | 3    |
| `NOT_FOUND`        | Series/chapter/page is gone (404)                                   | false       | 4    |
| `UNSUPPORTED_URL`  | This plugin does not handle the URL                                 | false       | 4    |
| `RATE_LIMITED`     | 429 that survived backoff                                           | true        | 5    |
| `BLOCKED`          | WAF, geo-block, ban — not a credential problem                      | false       | 5    |
| `CANCELLED`        | SIGTERM/SIGINT from the host                                        | false       | 6    |
| `NETWORK`          | DNS/TLS/reset/timeout/5xx after retries                             | true        | 1    |
| `PARSE`            | The site's markup or JSON was not what the plugin expects           | false       | 1    |
| `IO`               | Local filesystem failure                                            | true        | 1    |
| `INTERNAL`         | Bug in the plugin or SDK                                            | false       | 1    |

Other exit codes: **0** success, **2** usage (bad verb or missing option — the
accompanying `error` event carries code `INTERNAL`, since the code set has no
`USAGE` member), **7** SDK incompatible.

**The `error` event wins over the exit code.** Emit one and the host uses its
code, message and hint verbatim.

### Cancellation

The host sends `SIGTERM` to the process group, waits 10 s, then `SIGKILL`. The
SDK turns both `SIGTERM` and `SIGINT` into `ctx.signal.abort()`, which:

- makes every in-flight `ctx.http` call reject with `CANCELLED`;
- stops the download pool;
- resets the in-flight chapter to `pending`, writes the manifest, emits
  `error{code:"CANCELLED"}` and exits 6.

Pass `ctx.signal` into anything of your own that can block.

---

## 4. Manifest v2

`<seriesDir>/manifest.json`, written by the SDK, read by Kiri's ingest. It is a
superset of the Kiri V1 ripper manifest, so a V1 directory imports unchanged.

```jsonc
{
  "version": 2,
  "site": "mangadex", // = plugin id
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:10:00.000Z",
  "series": {
    "url": "https://mangadex.org/title/…", // normalised
    "slug": "starlight-express",
    "title": "Starlight Express",
    "id": "uuid-at-the-source", // optional
    "mediaType": "MANGA", // optional
    "coverFile": "cover.jpg", // optional, relative to seriesDir
  },
  "chapters": [
    {
      "slug": "chapter-12", // required; names the directory
      "externalId": "abc-123", // optional; ingest merges on this first
      "url": "https://…/chapter/abc-123",
      "title": "Chapter 12: Terminal",
      "chapterOrder": 12,
      "number": 12,
      "volume": "3",
      "releaseDate": "2024-05-03T00:00:00.000Z",
      "releaseDateText": "2024-05-03",
      "status": "completed", // pending | downloading | completed | failed
      "imageCount": 18,
      "downloadedAt": "2026-01-01T00:09:00.000Z",
      "images": [
        {
          "index": 1,
          "url": "https://…/1.jpg",
          "file": "001.jpg",
          "bytes": 284512,
          "sha256": "…",
          "width": 1200,
          "height": 1800,
          "mime": "image/jpeg",
        },
      ],
      "lastError": null,
      "missingFromSource": false,
      "source": "plugin",
    },
  ],
}
```

Rules the SDK enforces for you:

- Layout: `<seriesDir>/manifest.json`, `<seriesDir>/cover.<ext>`,
  `<seriesDir>/<chapterDirName(slug)>/<padded index>.<ext>`.
  `chapterDirName` replaces `< > : " / \ | ? *` and control characters with `_`,
  trims trailing dots/spaces and avoids Windows device names.
- Page files are named from the **bytes** (magic numbers first, `Content-Type`
  second), zero-padded to at least three digits.
- `mergeDiscoveredChapters` keeps completed chapters and their images, adds new
  ones as `pending`, resets a stale `downloading` to `pending`, flags chapters
  that vanished from the source with `missingFromSource: true` (Kiri never
  deletes what a user downloaded) and orders by `chapterOrder ?? number`.
- Writes are atomic (temp file + `rename`) and happen after **every** chapter.

Do not hand-write the manifest; use the SDK. If you must, `readManifest` is
tolerant enough to adopt anything close.

---

## 5. `definePlugin` walkthrough

The whole of `packages/source-template/src/index.mjs`, in pieces.

```js
import { definePlugin, parseError } from "@kiri/source-sdk";

export default definePlugin({
  id: "template",              // must equal the descriptor id
  name: "Template Source",
  version: "0.1.0",
  hosts: ["localhost", "127.0.0.1"],

  // Optional: defaults for the shared HttpClient (see §6).
  http: { requestsPerSecond: 50, retries: 2, backoffMs: 100 },
  concurrency: 4,              // page downloads; KIRI_CONCURRENCY overrides
```

### `resolve(url, ctx) → ResolvedSeries | null`

Recognise the URL and produce the canonical identity of the series. Return
`null` (or `handled: false`) for "not my site" — that is not an error.

```js
  async resolve(url, ctx) {
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (!HOSTS.has(parsed.hostname)) return null;

    const match = /^\/series\/([^/]+)/.exec(parsed.pathname);
    if (!match) return null;
    const slug = match[1];
    const normalizedUrl = `${parsed.origin}/series/${slug}/`;

    const meta = await ctx.http.fetchJson(`${normalizedUrl}series.json`);
    return {
      handled: true,
      normalizedUrl,                 // stored on Source; must be stable
      slug,                          // stable, human-readable
      title: meta.title,
      mediaType: "MANGA",
      coverUrl: new URL(meta.cover, normalizedUrl).href,
      externalId: meta.id,           // optional source-side id
    };
  },
```

`normalizedUrl` and `slug` are identity: strip tracking parameters, locale
prefixes and trailing junk so the same series always resolves the same way.

### `listChapters(series, ctx) → ChapterStub[]`

```js
  async listChapters(series, ctx) {
    const html = await ctx.http.fetchText(series.normalizedUrl);
    const chapters = [];
    for (const m of html.matchAll(/<a\b[^>]*class="chapter"[^>]*>([\s\S]*?)<\/a>/gi)) {
      chapters.push({
        slug: `chapter-${number}`,   // stable! it names the directory on disk
        externalId: id,              // optional but preferred for merging
        url: new URL(href, series.normalizedUrl).href,
        title, number, chapterOrder: number, volume,
        releaseDate,                 // ISO 8601
        releaseDateText,             // verbatim from the site
      });
    }
    if (chapters.length === 0) throw parseError("No chapters found — did the site change?");
    return chapters;
  },
```

Return **all** chapters, in any order, on every call: the SDK diffs them against
the manifest. Never filter to "new" ones yourself — that is how chapters go
missing. A slug must never change for the same chapter (it is the directory
name); if the site's slugs are unstable, set `externalId` and the merge follows
it across a rename.

### `listPages(chapter, ctx) → PageStub[]`

```js
  async listPages(chapter, ctx) {
    const html = await ctx.http.fetchText(chapter.url);
    const pages = [];
    for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
      pages.push({
        index: pages.length + 1,             // 1-based, in reading order
        url: new URL(m[1], chapter.url).href,
        referer: chapter.url,                // many CDNs require it
        headers: { /* per-page extras */ },
      });
    }
    if (pages.length === 0) throw parseError(`No pages found in ${chapter.url}`);
    return pages;
  },
```

`chapter` is the merged manifest entry (`slug`, `url`, `title`, `number`,
`images`, …), so a re-sync sees what already exists.

### Optional hooks

```js
  // Cover bytes; written once as cover.<ext> and never re-fetched while present.
  async fetchCover(series, ctx) {
    const { buffer } = await ctx.http.fetchBuffer(series.coverUrl);
    return buffer;                       // or null
  },

  // Custom page fetching: signed URLs, XOR-descrambling, a browser fetch.
  // Return the decoded bytes; the SDK still hashes, sniffs and renames them.
  async downloadPage(page, ctx) {
    const { buffer } = await ctx.http.fetchBuffer(page.url, { referer: page.referer });
    return deobfuscate(buffer);
  },

  settings: [{ key: "language", type: "string", default: "en", label: "Language" }],
});
```

### What `definePlugin` does for you

Parses `argv`; emits `hello` and checks the SDK range (exit 7); wires
`SIGTERM`/`SIGINT` to `ctx.signal`; reroutes `console.*` into `log` events so a
stray `console.log` cannot corrupt stdout; reads/merges/writes the manifest;
writes the cover; downloads pages with bounded concurrency, sha256, dimensions
and skip-if-present; emits `progress`/`chapter` events; checkpoints after every
chapter; converts thrown `PluginError`s into `error` events and exit codes, and
anything else into `INTERNAL`.

It **auto-runs on import** — a plugin entry file is a program, not a library.
Set `KIRI_PLUGIN_NO_AUTORUN=1` to import the module without running it (handy
for unit-testing your own hooks).

A failing chapter does not abort the run: it is marked `failed` with
`lastError`, the manifest is checkpointed and the next chapter starts. Only
`NEEDS_CREDENTIAL`, `RATE_LIMITED`, `BLOCKED` and `CANCELLED` stop the whole
sync, because continuing would only make things worse.

---

## 6. The toolbox: `ctx`

```ts
interface Ctx {
  http: HttpClient; // retries, rate limit, cookie + User-Agent applied
  browser: BrowserApi; // withBrowser / withPage / pageHtml
  log: Logger; // debug (verbose only) | info | warn | error
  progress(p): void; // { phase, current, total, chapterSlug?, bytes? }
  cookie?: string; // raw Cookie header, if the host has one
  userAgent?: string;
  settings: Record<string, unknown>; // from KIRI_SETTINGS
  signal: AbortSignal; // aborted on SIGTERM/SIGINT
  outputDir: string; // series directory ("" for resolve/discover)
  verbose: boolean;
  env: PluginEnv; // the whole typed KIRI_* environment
  descriptor?: PluginDescriptor;
}
```

### `ctx.http`

```ts
await ctx.http.fetchText(url, { referer, headers, timeoutMs, retries, accept });
await ctx.http.fetchJson<T>(url, options); // PARSE on bad JSON
await ctx.http.fetchBuffer(url, options); // { buffer, contentType, finalUrl }
await ctx.http.fetchWithRetry(url, options); // the raw Response
ctx.http.withOptions({ requestsPerSecond: 1 }); // a stricter copy for one host
```

Defaults: 3 retries, 30 s timeout, 5 requests/second (token bucket), 0–250 ms
jitter, exponential backoff from 500 ms capped at 30 s, `Retry-After` honoured
up to 60 s. `Accept`, `Accept-Language`, `User-Agent` and `Cookie` are set for
you. Override per plugin with `spec.http`.

Status mapping: 404/410 → `NOT_FOUND` (no retry) · 401 → `NEEDS_CREDENTIAL` ·
403/503 with a Cloudflare interstitial → `NEEDS_CREDENTIAL` · other 403 →
`BLOCKED` · 429 → retried, then `RATE_LIMITED` · 408/425/5xx → retried, then
`NETWORK` · other 4xx → `NETWORK` (not retryable).

### `ctx.browser`

For sites that build the page list in JavaScript. `playwright` is an **optional
peer dependency**: add it to your plugin's `dependencies` and declare the
`browser` capability. Missing → a clear `INTERNAL` error.

```js
const html = await ctx.browser.pageHtml(chapter.url, { waitForSelector: "img.page" });

const urls = await ctx.browser.withPage(
  async (page) => {
    return page.evaluate(() => [...document.querySelectorAll("img.page")].map((img) => img.src));
  },
  { url: chapter.url, waitUntil: "networkidle" },
);
```

Cookies from `KIRI_COOKIE` and the User-Agent are applied to the context;
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is honoured (Kiri's `kiri:browser` image
sets it). Chromium is launched **plain** — see §10.

### `ctx.settings`

```js
import { getSetting } from "@kiri/source-sdk";
const language = getSetting(ctx.settings, "language", "en");
```

---

## 7. Errors

```js
import {
  PluginError,
  needsCredential,
  rateLimited,
  notFound,
  unsupportedUrl,
  blocked,
  networkError,
  parseError,
  ioError,
  cancelled,
  internalError,
} from "@kiri/source-sdk";

throw parseError("The chapter list markup changed");
throw needsCredential("Login wall", { hint: "Sign in and use the Kiri Cookie Bridge extension." });
throw new PluginError("BLOCKED", "Region locked", { retryable: false, hint: "…" });
```

`message` and `hint` are shown to the user; write them for a person who owns a
server, not for a stack trace. `retryable` defaults per code and tells the
scheduler whether to try again on its own.

Anything else you throw becomes `INTERNAL` with the original message. Node
errno codes (`ENOENT`, `ECONNRESET`, …) are mapped to `IO`/`NETWORK`
automatically.

---

## 8. Testing

`@kiri/source-sdk/testing` is a separate entry point with no test-framework
dependency; use it from Vitest, `node:test`, or anything else.

```js
import {
  startFixtureServer,
  runPlugin,
  makeTmpDir,
  readJsonFile,
  eventsOfType,
} from "@kiri/source-sdk/testing";

const server = await startFixtureServer("./fixture-site"); // random port
const out = await makeTmpDir();

const result = await runPlugin(
  "./src/index.mjs",
  ["sync", server.url("series/starlight-express/"), "--output", out],
  { env: { KIRI_VERBOSE: "1" } },
);

expect(result.exitCode).toBe(0);
expect(result.unparsed).toEqual([]); // nothing but protocol on stdout
expect(result.data).toMatchObject({ chaptersCompleted: 3 });
expect(eventsOfType(result.events, "progress").length).toBeGreaterThan(0);

const manifest = await readJsonFile(`${out}/manifest.json`);

// Make one page fail to test resume/checkpointing:
server.fail("/series/starlight-express/chapters/2/p02.png", 500);
server.requests; // every path the server saw, so you can assert what was re-fetched
await server.close();
```

`runPlugin` spawns the plugin with a `KIRI_*`-free copy of the environment, so
tests never inherit your shell. It returns `{ exitCode, signal, events, unparsed,
stdout, stderr, hello, result, data, error, timedOut }`.

Test at least: `resolve` accepts your URL shapes and declines foreign ones;
`discover` finds every chapter; `sync` produces the files and a complete
manifest; a second `sync` re-downloads nothing; a failing page fails only its
chapter; `verify` notices a deleted file.

---

## 9. Packaging and installing

A plugin is a directory or a zip **whose root contains `kiri-plugin.json`**:

```
my-plugin.zip
├── kiri-plugin.json      ← at the root, not inside a wrapper folder
├── package.json          ← optional; only needed if you have dependencies
├── src/index.mjs
└── README.md
```

Admins install from a git URL, an HTTPS zip URL, an uploaded zip, or by dropping
the folder into `DATA_ROOT/plugins/` and restarting.

What the host does on install:

1. validates the descriptor (`id` must equal the directory name);
2. runs `npm install --omit=dev --ignore-scripts --no-audit --no-fund` **only**
   if `package.json` declares dependencies — lifecycle scripts never run, so do
   not rely on `postinstall`;
3. links `node_modules/@kiri/source-sdk` to the SDK it ships. **Do not vendor
   the SDK and do not list it in `dependencies`** — declare the range in the
   descriptor's `sdk` field instead;
4. runs `node <entry> hello` as a compatibility check (exit 7 = refuse);
5. moves the staging directory into place and records the `Plugin` row.

Guidelines: keep dependencies near zero (they are installed on someone else's
server); use ESM (`.mjs` or `"type": "module"`); target Node ≥ 20; never write
outside `--output`; never read anything outside your plugin directory.

---

## 10. The neutral-SDK policy

Kiri's SDK provides what a well-behaved client needs: retries with backoff,
rate limiting, timeouts, cookie and User-Agent pass-through, and a plain
headless browser.

It deliberately does **not** provide, and will not accept contributions of:

- TLS/JA3 fingerprint impersonation (`curl-impersonate` and friends);
- stealth patches (`navigator.webdriver` removal, canvas/WebGL noise, …);
- CAPTCHA or Cloudflare challenge solving, or third-party solver integrations;
- credential harvesting or shared-account pools.

A Cloudflare interstitial is _detected_ (title "Just a moment", the
`cf-mitigated` header, the challenge-platform script) and reported as
`NEEDS_CREDENTIAL` with a hint, so Kiri can ask the user for a `cf_clearance`
cookie and matching User-Agent — captured by hand or by the Kiri Cookie Bridge
extension. That cookie then arrives as `KIRI_COOKIE`/`KIRI_USER_AGENT`.

A plugin that needs more than this must vendor it itself, declare the
`browser`/`subprocess` capabilities, and say so in its README. That is a choice
its users make knowingly; it is not a default of the platform.

---

## 11. Porting a Kiri V1 ripper

A V1 `tools/<site>-ripper/ripper.mjs` is roughly 1 300 lines, of which ~800 are
boilerplate the SDK now owns. The mapping, using `tools/mangadex-ripper` as the
example:

| V1 code                                                                                              | V2                                                     |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `parseArgs`, `main()`, the `update`/`verify` verbs                                                   | delete — `definePlugin` owns argv                      |
| `class HttpClient`, `sleep`, `getRandomInt`, `createTimeoutSignal`, `DEFAULT_HEADERS`                | delete — `ctx.http`                                    |
| `processWithConcurrency`                                                                             | delete — `downloadAll`                                 |
| `downloadSingleImage` (temp+rename, sha256, extension sniffing)                                      | delete — `downloadImage`                               |
| `buildDefaultManifest`, `readManifest`, `writeManifest`, `mergeDiscoveredChapters`, `getSeriesPaths` | delete — `manifest.ts`                                 |
| `sanitizePathSegment`, `padImageIndex`                                                               | delete — `chapterDirName`, `pageFileName`              |
| `console.log(JSON.stringify(…))` progress lines                                                      | delete — `ctx.progress`, `ctx.log`                     |
| `parseSeriesUrl` / slug + id extraction                                                              | → `resolve`                                            |
| `fetchAllChapters` / chapter-list parsing                                                            | → `listChapters` (return **all** chapters, unfiltered) |
| `fetchChapterImages` / at-home server, page URL building                                             | → `listPages`                                          |
| cover fetch                                                                                          | → `fetchCover`                                         |
| per-image decryption or signed-URL logic                                                             | → `downloadPage`                                       |
| `throw new Error("cloudflare challenge")` + host-side regex                                          | → `throw needsCredential(…)`                           |
| `--cookie` on argv                                                                                   | → `ctx.cookie` (host sets `KIRI_COOKIE`)               |
| `impersonate.mjs` / stealth helpers                                                                  | not ported — see §10                                   |

Practical order:

1. `npm init` a directory, copy `kiri-plugin.json` from the template, set `id`,
   `hosts` and `sdk`.
2. Move the site-specific parsing out of the V1 file into the four hooks; the
   regexes and selectors usually port verbatim.
3. Replace `client.fetchText/fetchJson/fetchBuffer` calls with `ctx.http.*` —
   the method names are identical on purpose.
4. Delete everything in the mapping's "delete" rows.
5. Point the SDK's fixture harness (or a saved copy of the site's HTML) at it
   and write the tests from §8 before touching the live site.
6. Sync one series into a scratch directory, then run `verify`.

Expect the plugin to land at ~250–400 lines.

---

## 12. Checklist

- [ ] `kiri-plugin.json` at the root; `id` = directory name; `hosts` are tight.
- [ ] `sdk` range matches the SDK you developed against.
- [ ] `resolve` declines foreign URLs with `null` instead of throwing.
- [ ] `normalizedUrl` and chapter `slug`s are stable across runs.
- [ ] `listChapters` returns **every** chapter, every time.
- [ ] `listPages` sets `index` from 1 in reading order, and a `referer` if needed.
- [ ] Nothing is written outside `ctx.outputDir`.
- [ ] `ctx.signal` is passed to anything that can block.
- [ ] Failures use a `PluginError` with a message a user can act on.
- [ ] Nothing but the SDK writes to stdout.
- [ ] Tests cover `resolve`, `discover`, `sync`, re-sync and `verify`.
- [ ] README states which capabilities the plugin needs and why.
