# Architecture overview

Kiri is a single Next.js app (App Router) plus PostgreSQL. There is no
separate backend service and no message queue — background work (syncing,
plugin installs, imports, image optimization) runs inside the same Node
process as the web server, as Postgres-backed jobs.

## Repo layout

```
apps/web/                 Next.js app, package "kiri" (standalone output,
                           outputFileTracingRoot = repo root)
  prisma/                 schema.prisma + migrations
  src/app/                (app)/, (auth)/, admin/, api/, read/, offline/, setup/
  src/lib/                api.ts, authz.ts, auth/, content/, jobs/, plugins/,
                          import-v1/, offline/, crypto.ts, env.ts, prisma.ts …
  src/components/         library/, series/, reader/, notes/, admin/, ui/
packages/source-sdk/      @kiri/source-sdk — the plugin SDK (built to dist/,
                           packed into the image at /app/sdk/<version>/)
packages/source-template/ example plugin on the SDK; also the e2e fixture site
extension/                Kiri Cookie Bridge (MV3 browser extension)
docker/                   Dockerfile, compose files, entrypoint
docs/                     this file, DEPLOY.md, PLUGINS.md, MIGRATING_FROM_V1.md
```

## Request flow

`src/proxy.ts` (Next 16's `proxy` convention — the replacement for
`middleware.ts`) runs on every request except static assets. It only checks
that a signed better-auth session **cookie is present** (no DB round trip),
so it stays cheap on the hot path:

- a public path (`/login`, `/register`, `/setup`, `/offline`, `/api/health`,
  `/api/version`, `/api/auth/*`, `/_next/*`, …) always passes;
- a request with a session cookie passes through;
- otherwise: an API path (`/api/*`) gets a `401` JSON body; a navigation
  (`Accept: text/html` or an `RSC` header) gets redirected to `/login` (or
  `/api/auth/cf` when `AUTH_CF_ACCESS=1`); anything else — including a
  service-worker precache fetch — gets a `401` JSON body too.

The cookie check is a fast gate, not authorization. Every route handler
re-resolves identity with `getCurrentUser()` (which upserts nothing — accounts
are created explicitly, not on first request the way Kiri 1.x's proxy-trusted
header worked) and every JSON API route is built from `withAuth`/`withPublic`
(`src/lib/api.ts`): zod-validated body/query, a consistent
`{ error: { code, message, details? } }` shape, and status codes
400/401/403/404/409/500 decided in one place instead of per route.

## Auth

- **better-auth** (Prisma adapter, `admin` plugin) owns `User`, `Session`,
  `Account` (password hashes) and `Verification`. Sessions are 30-day
  DB-backed cookies with a 60-second client-side cache so role/profile edits
  show up quickly. `trustedOrigins` is exactly `[PUBLIC_URL]` — a mismatched
  `PUBLIC_URL` is the most common cause of a rejected sign-in.
- **Registration**: `AppSetting.registrationMode` is `INVITE` (default),
  `OPEN`, or `CLOSED`. `/setup` creates the first account and makes it admin
  while the `User` table is empty. Invites (`Invite`) are single-use,
  SHA-256-hashed tokens, optionally pinned to one email, with a role and an
  expiry — the raw token only ever appears in the URL handed to the invitee.
  Gating lives in a better-auth `databaseHooks.user.create.before` hook, so
  every user-creating path shares it except the ones that intentionally
  bypass it (Cloudflare Access linking, the V1 importer).
- **Cloudflare Access mode** (`AUTH_CF_ACCESS=1`): an unauthenticated
  navigation goes to `/api/auth/cf`, which verifies the
  `Cf-Access-Jwt-Assertion` header against `CF_ACCESS_TEAM_DOMAIN`/
  `CF_ACCESS_AUD` (via `jose`) and links the verified identity to an
  existing user by email, or creates one when registration allows it.
  `AUTH_CF_TRUST_HEADER=1` skips JWT verification and trusts the header
  outright — only for deployments unreachable except through Cloudflare.

## Authorization model

`src/lib/authz.ts` is pure predicates over a session user and three `Series`
columns, plus a matching Prisma `where` fragment so list queries filter in
the database, not the browser (Kiri 1.x filtered adult content client-side):

| Rule         | Applies to                    | Logic                                                                                                                                     |
| ------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `canView`    | any route reading a series    | creator always; `SHARED` series to everyone; `PRIVATE` only to its creator; adult series hidden unless `showAdult` is on (creator exempt) |
| `canEdit`    | mutating a series             | `canView` **and** (creator or admin)                                                                                                      |
| view denial  | private series                | `404`, not `403` — existence isn't leaked                                                                                                 |
| adult denial | adult series, `showAdult` off | `403` — the viewer can flip the setting themselves                                                                                        |

Every byte-serving route (`/api/pages/:id/image`, `/api/series/:id/cover`,
offline manifests) re-checks `canView` on **every request** — a private
series is otherwise guessable by id. `requireAdmin` gates the admin API
surface (users, invites, plugins, settings, audit log, V1 import).

## Data model

Postgres via Prisma 7 (`@prisma/adapter-pg`). One shared library per
instance; per-series `visibility` is the tenancy boundary, not a separate
schema/database per user. See `apps/web/prisma/schema.prisma` for the
authoritative shape (this document doesn't duplicate it field-by-field).

| Group              | Models                                                     |
| ------------------ | ---------------------------------------------------------- |
| Auth (better-auth) | `User`, `Session`, `Account`, `Verification`, `Invite`     |
| Library            | `Series`, `LibraryEntry`, `ChapterRead`, `ReadingPosition` |
| Content            | `Chapter`, `Page`, `Source`                                |
| Plugins            | `Plugin`, `PluginCredential`                               |
| Jobs               | `Job`                                                      |
| Notes              | `Note`                                                     |
| Ops                | `Notification`, `AppSetting`, `AuditLog`, `ImportMapping`  |

## Content store

Everything Kiri writes to disk lives under `DATA_ROOT` (`/data` in the
container image):

| Path                                               | Contents                                                |
| -------------------------------------------------- | ------------------------------------------------------- |
| `DATA_ROOT/library/<seriesId>/manifest.json`       | plugin-owned manifest (superset of the Kiri 1.x format) |
| `DATA_ROOT/library/<seriesId>/<chapterDir>/<file>` | downloaded page images                                  |
| `DATA_ROOT/covers/<seriesId>/cover.webp`           | series cover                                            |
| `DATA_ROOT/plugins/<pluginId>/`                    | an installed plugin's files                             |
| `DATA_ROOT/tmp/<name>/`                            | job scratch space                                       |
| `DATA_ROOT/tmp/uploads/`                           | in-progress chunked upload sessions                     |

`src/lib/content/store.ts` is the only module that turns an id into a
filesystem path, and every path is resolved through a containment check
(`resolveInside`) so a hostile id can never escape `DATA_ROOT`.

## Jobs runner

`src/lib/jobs/` replaces Kiri 1.x's `rip-queue.ts` with one Postgres-backed
`Job` table (kinds: `SOURCE_SYNC`, `SOURCE_VERIFY`, `OPTIMIZE`, `PDF_IMPORT`,
`MANUAL_UPLOAD`, `PLUGIN_INSTALL`, `V1_IMPORT`, `INGEST_MANIFEST`):

- **Claim**: a conditional `updateMany` (`status: QUEUED` in the `WHERE`
  clause _is_ the lock) picks up to `JOB_CONCURRENCY` jobs at once.
- **One active job per subject** — a series, source, plugin, or (for
  `V1_IMPORT`) the whole instance — enforced at enqueue time.
- **Heartbeat**: the runner updates `heartbeatAt` while a job runs. A sweep
  reclaims any `RUNNING` job whose lease has gone stale back to `QUEUED`, so a
  crashed worker no longer blocks its series until someone restarts the
  container (Kiri 1.x only recovered at boot).
- **Cancel is two-sided**: a `QUEUED` job flips straight to `CANCELLED`. A
  `RUNNING` job gets an in-process `AbortController.abort()` _and_ a
  `cancelRequestedAt` marker written into `configJson` — whichever the worker
  notices first wins, and the marker is what makes cancellation work across a
  dev-mode module duplicate or a mid-cancel restart. For a plugin subprocess,
  cancelling means `SIGTERM` to the whole process group, a grace period, then
  `SIGKILL` — so an abandoned Chromium never outlives its job.
- `outputLog` is tail-capped (240,000 characters) rather than growing
  unbounded; the runner buffers lines and flushes periodically instead of
  writing a row per line.
- Started from `instrumentation.ts`, alongside the **auto-sync scheduler**
  (global presets + per-series `INHERIT`/`DISABLED`/`CUSTOM`) that enqueues
  `SOURCE_SYNC` jobs on a timer.

## Uploads

Manual chapter upload (zip/images) and PDF import go through a resumable,
chunked upload session (`src/lib/uploads/`): the client asks for a session,
gets a chunk plan, `PUT`s each chunk (in any order, retryable) to
`/api/uploads/:id/chunks/:index`, then calls `/complete`. Chunks are capped
at **8 MiB** (`UPLOAD_CHUNK_SIZE`) specifically so the request body a reverse
proxy sees per call stays under typical default proxy body-size limits (~10
MiB) — the whole file itself has no such cap.

## Content pipeline (sync → ingest)

1. A user pastes a URL on a series. The host fans a `resolve <url>` call out
   to every enabled plugin whose descriptor `hosts` match; the first
   `handled` result becomes that series' `Source`.
2. A `SOURCE_SYNC` job spawns the plugin, which downloads images and
   maintains `manifest.json` in the series directory, streaming JSON-Lines
   progress on stdout.
3. On success the host **ingests** the manifest (`src/lib/content/ingest.ts`):
   one transaction per series, upserts `Chapter` by `externalId`/`slug`,
   batches `Page` rows, fills in missing image dimensions via `sharp`, and
   recomputes `Series.chapterCount`/`lastChapterAt`. Chapters present in the
   DB but absent from a fresh manifest are marked `MISSING_FROM_SOURCE`,
   never deleted. Manual/PDF uploads and the V1 importer share this same
   ingest path.
4. The reader and dashboard always read from the database, never the on-disk
   manifest — ingestion is the only place manifest parsing happens.

## Plugins

Plugins are **subprocesses**, not in-process modules — descriptor validation,
then install, then a sandboxed run per sync:

1. **Descriptor** (`kiri-plugin.json`): id, version, SDK range, `hosts`,
   declared `capabilities` (`network | cookie | browser | subprocess`),
   media types, settings schema — validated at install time and every boot.
   Boot never executes plugin code, only reads descriptors.
2. **Install**: from a git URL (`git clone --depth 1`, needs `git` in the
   image), an HTTPS zip, an uploaded zip, or a folder dropped into
   `DATA_ROOT/plugins/` and picked up on restart. `npm install` runs only if
   the plugin declares dependencies (`--ignore-scripts`); its
   `node_modules/@kiri/source-sdk` is linked against the SDK tree baked into
   the image, never fetched from a registry.
3. **Sandboxed subprocess**: `node [--permission flags] <entry> <verb> …`.
   `KIRI_PLUGIN_SANDBOX` (`on`/`warn`/`off`, default `warn`) scopes Node's
   `--permission` read/write to the plugin's directory, the linked SDK, the
   series output directory and a tmp dir; `browser`/`subprocess`-capability
   plugins additionally get `--allow-child-process` (a warning badge, not a
   real boundary at that point). `warn` mode retries once with no flags if
   the sandboxed run dies with `ERR_ACCESS_DENIED`. Nothing secret reaches
   `argv`; cookies and settings arrive over an **env-var allowlist**
   (`KIRI_COOKIE`, `KIRI_SETTINGS`, …), never the host's own `process.env`.
4. **JSON Lines protocol**: one JSON object per stdout line — `hello` first,
   then `log`/`progress`/`chapter`/`result`/`error` — read with a real line
   reader; stderr is tailed into the job log. An `error` event's `code` (a
   closed set: `NEEDS_CREDENTIAL`, `RATE_LIMITED`, `NOT_FOUND`,
   `UNSUPPORTED_URL`, `BLOCKED`, `NETWORK`, `PARSE`, `IO`, `CANCELLED`,
   `INTERNAL`) wins over the process exit code.
5. **Manifest → ingest**: the plugin checkpoints `manifest.json` after every
   chapter; the host ingests it as above. Full contract:
   [`docs/PLUGINS.md`](PLUGINS.md).
6. **Credentials**: cookies are encrypted at rest (AES-256-GCM, keyed from
   `APP_SECRET` via HKDF; a decrypt failure surfaces as `NEEDS_CREDENTIAL`,
   never throws). The Kiri Cookie Bridge browser extension (`extension/`)
   captures cookies for a plugin's `cookie`-capability hosts and posts them
   to `/api/plugins/credentials`, guarded by a token shown at Admin → Plugins.

## Offline / PWA

Serwist "configurator mode" (`serwist build` runs _after_ `next build`, so
`next build` itself stays on Turbopack). `src/app/sw.ts` implements:

| Match                                                                                  | Strategy                           | Cache            |
| -------------------------------------------------------------------------------------- | ---------------------------------- | ---------------- |
| build assets, `/manifest.json`, icons, the **public** `/offline` shell                 | precache                           | —                |
| navigations (`/read?…` keyed to bare `/read` so one warmed shell serves every chapter) | NetworkFirst (3 s)                 | `pages`          |
| `/api/pages/:id/image`, `/api/series/:id/cover`                                        | CacheFirst                         | `reader-images`  |
| `/api/chapters/:id`                                                                    | NetworkFirst (3 s)                 | `reader-content` |
| `/api/library*`, `/api/series/*`, `/api/chapters/*`, `/api/notifications`              | NetworkFirst (3 s)                 | `api`            |
| everything else                                                                        | `@serwist/next` default            | —                |
| failure: navigation                                                                    | fall back to precached `/offline`  | —                |
| failure: everything else                                                               | `503 {"error":{"code":"OFFLINE"}}` | —                |

Only `/offline` can be precached as a full shell — it's the one prerendered
route on the public-path list; every other route is session-gated, and
precaching a gated URL (which the proxy answers with `401`, not a redirect)
would abort the service worker's install entirely. `/read` still works
offline: the app warms it into the `pages` cache with a plain navigation
fetch once loaded online. There is deliberately no `purgeOnQuotaError` on
`reader-images` — the app owns eviction per series so a quota-triggered wipe
can't desynchronize the IndexedDB catalog from the bytes actually cached.

**Downloads and catalog** (`src/lib/offline/`): downloaded chapters are Cache
API bytes plus an IndexedDB catalog (`db.ts`, `catalog.ts`, `downloads.ts`)
with startup reconciliation against what's actually cached, per-series
delete, and a queue with pause/resume. **Sync queue**
(`sync-queue.ts`): reading position, chapter-read state and notes authored
offline queue as ops with a client-generated id (idempotent server upsert on
reconnect) and flush on `pagehide` as well as on a debounce timer.

## Notes

`Note` anchors to `(series, chapter?, pageIndex?)` plus an optional
normalized `pinX`/`pinY` on the page image; `chapterId: null` is a
series-level note, `pageIndex: null` is a chapter-level note. Threaded via
`parentId`. **Spoiler gate** (`src/lib/notes/spoilers.ts`, pure functions):
a note is hidden from a viewer (not the author, and never when the viewer's
`showSpoilers` is on) when it's flagged `isSpoiler`, or when its anchor sits
past the viewer's furthest reading point — the max of every chapter with a
`ChapterRead` marker (counts to its end) and the single `ReadingPosition`
row, compared as a `(chapter sortIndex, page)` pair.

## Importer

`src/lib/import-v1/` reads a Kiri 1.x database with raw, read-only SQL
(every connection is set `default_transaction_read_only`) plus its data
directory, and reproduces it in Kiri 2: users become invited/`mustSetPassword`
accounts, series dedupe by `mal_id`, chapters/pages reuse the same ingest
path as a plugin sync, and every write is recorded in `ImportMapping` so
re-running the import is idempotent. Runs as a `V1_IMPORT` job (admin page)
or the `import:v1` CLI. Full guide: [`docs/MIGRATING_FROM_V1.md`](MIGRATING_FROM_V1.md).

## Deployment shape

One container image (`docker/Dockerfile`) plus one PostgreSQL instance;
`DATA_ROOT` is the only stateful directory on the app side. The image runs
`prisma migrate deploy` on every start before serving traffic. See
`docs/DEPLOY.md` for the operational side (env vars, reverse proxy, backups)
and `docs/PLUGINS.md` for how a plugin's capabilities map to what the
container lets it do.
