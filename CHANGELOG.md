# Changelog

All notable changes to Kiri are documented here. Kiri 2.0 is a ground-up
rewrite of Kiri 1.x (`readingtracker`) in a new repository — see "Breaking vs
1.x" below before treating this as an upgrade.

## 2.0.0-alpha.0 (unreleased)

Initial alpha of the Kiri 2.0 rewrite: real accounts, a plugin system for
content sources, a reliable offline reader, first-class chapters/pages,
frame-anchored notes, and a one-shot Kiri 1.x importer.

### Auth

- Real accounts via better-auth: email + password, DB-backed sessions, admin
  roles — replaces Kiri 1.x's proxy-trusted-header identity with no sessions
  and no ownership checks.
- Invite-only registration by default (`AppSetting.registrationMode`: `INVITE`
  / `OPEN` / `CLOSED`); single-use, hashed, optionally email-pinned invite
  tokens managed from Admin → Invites.
- `/setup` wizard creates the first account and makes it admin while the user
  table is empty.
- Optional Cloudflare Access mode (`AUTH_CF_ACCESS`): verifies the
  `Cf-Access-Jwt-Assertion` header and links or creates a Kiri user by email.
- `src/proxy.ts` (Next 16's `proxy` convention) gates every non-public route
  on session-cookie presence; every route re-resolves identity and every
  byte-serving route re-checks series visibility on each request.

### Library

- Series `visibility` (`SHARED`/`PRIVATE`) as the tenancy boundary within one
  shared library per instance, plus per-viewer adult-content gating
  (`showAdult`) — enforced server-side (`src/lib/authz.ts`), not just in the
  browser.
- Series CRUD with real ownership checks (creator-or-admin) — Kiri 1.x let
  any signed-in user edit, reassign or delete any series.
- Book-club enrollment fixed to actually enroll members when a series is
  created with `isBookClub` set.
- Server-side filter/sort/search (Postgres `tsvector`) and cursor pagination
  for the library list.

### Content & reader

- Chapters and pages are first-class Postgres rows (`Chapter`, `Page`) —
  ingested from a plugin/import manifest once, then served from the database,
  not re-parsed from `manifest.json` on every dashboard render.
- Real image dimensions stored per page, so the reader never reflows.
- One reader route (`/read?series=&chapter=&page=`), replacing Kiri 1.x's
  separate online/offline reader implementations.
- Manual chapter upload (zip/images) and PDF import via a resumable, chunked
  upload session (8 MiB chunks).
- Image optimization (WebP) updates existing `Page` rows in place, so notes
  anchored to a page never move.

### Jobs & uploads

- Postgres-backed job runner (`src/lib/jobs/`) replacing Kiri 1.x's
  `rip-queue.ts`: conditional-update claiming, configurable concurrency
  (`JOB_CONCURRENCY`), a heartbeat column so a crashed worker's job is
  reclaimed automatically instead of only at boot, and two-sided cancellation
  (DB flag + in-process abort, with `SIGTERM`→`SIGKILL` to a plugin
  subprocess's whole process group so an abandoned Chromium doesn't outlive
  its job).
- Chunked, resumable uploads (`src/lib/uploads/`) for manual/PDF chapter
  import.

### Plugins

- Content sources are no longer baked into the app. Kiri ships with **zero**
  installed plugins; every site is a small Node program, installed from a
  git URL, an HTTPS zip, an uploaded zip, or a drop-in folder.
- `@kiri/source-sdk` (`packages/source-sdk`) absorbs the ~800 lines of
  boilerplate every Kiri 1.x ripper reimplemented (HTTP retry, manifest I/O,
  concurrency, path sanitization) behind `definePlugin`.
- Subprocess protocol v1 over stdio: JSON-Lines events, a closed error-code
  set, and nothing secret on `argv` (Kiri 1.x passed cookies on `argv`,
  visible via `ps`) — credentials arrive through an allowlisted environment
  instead.
- Node `--permission` sandboxing for plugin subprocesses
  (`KIRI_PLUGIN_SANDBOX=on|warn|off`, default `warn`).
- Plugin credentials (cookies) encrypted at rest with AES-256-GCM, keyed from
  `APP_SECRET` via HKDF, with key-rotation support (`APP_SECRET_PREVIOUS`) —
  Kiri 1.x stored them in plaintext.
- The Kiri Cookie Bridge browser extension (`extension/`) now asks the server
  which hosts matter (`GET /api/plugins/hosts`) instead of shipping a
  hardcoded site list.
- `packages/source-template`: a working example plugin against a local
  fixture site, doubling as the plugin end-to-end test fixture.

### Offline

- Rebuilt service worker (Serwist configurator mode) fixing the structural
  causes of Kiri 1.x's offline failures: the reader shell is precached and
  reachable without a session, navigations fall back to a precached
  `/offline` page, and the worker registers immediately in production instead
  of waiting for a full online page load.
- `/offline` hub: downloaded series, cached covers, continue reading, storage
  usage, and per-series removal.
- Sync queue for reading position, chapter-read state, and notes authored
  offline, flushed on reconnect and on `pagehide`.
- Offline behavior is covered by Playwright e2e tests that install the
  service worker, download a chapter, and verify reading, notes, and progress
  work with the network off.

### Notes

- New feature: threaded notes anchored to `(series, chapter, page)`, with an
  optional normalized pin point on the page image.
- Spoiler-safe by default: a note is hidden unless the viewer wrote it, has
  `showSpoilers` on, or has read at least as far as the note's anchor; authors
  can also flag a note `isSpoiler` explicitly.
- Notes authored while offline queue through the same sync queue as reading
  progress.

### Importer

- One-shot, read-only, idempotent importer (`src/lib/import-v1/`) for a
  running Kiri 1.x database and its `rips`/`covers` data directory — admin UI
  and CLI (`import:v1`), dry-run first, safe to re-run to top up.
- Sites with no matching installed plugin import as `NEEDS_PLUGIN`: existing
  chapters stay fully readable, and syncing resumes automatically once a
  matching plugin is installed.
- See [`docs/MIGRATING_FROM_V1.md`](docs/MIGRATING_FROM_V1.md) for the full
  guide.

### Ops / Docker / CI

- New npm workspaces monorepo layout (`apps/web`, `packages/source-sdk`,
  `packages/source-template`, `extension/`, `docker/`, `docs/`).
- Multi-stage, workspace-aware `docker/Dockerfile`: no per-plugin `COPY`s, an
  SDK tarball packed into the image for plugin installs, and a separate
  `browser` variant (`kiri:*-browser`) carrying Playwright's own Chromium for
  browser-capability plugins, instead of the Debian `chromium` package that
  crashed in headless containers.
- `docker compose` quick start needing only two required values
  (`POSTGRES_PASSWORD`, `APP_SECRET`).
- CI (`.github/workflows/ci.yml`): lint, typecheck (including the service
  worker's separate `tsconfig.sw.json`), unit + integration tests against an
  embedded Postgres, Playwright e2e against a production build, and a Docker
  build validation of the `runner` target. `publish-ghcr.yml` publishes both
  image variants on version tags.

## Breaking vs 1.x

Kiri 2.0 is **not** an in-place upgrade — it lives in a new repository
(`Kiri2`, package `kiri`, formerly `readingtracker`) with a new database
schema, and requires a deliberate one-shot migration:

- **New repository and package name.** There is no `git pull` path from Kiri
  1.x; deploy Kiri 2.0 as a fresh instance.
- **Plugins are not bundled.** The ~30 site rippers built into Kiri 1.x do
  not ship here. A freshly deployed Kiri 2.0 instance can track series and
  read already-downloaded content, but syncing new chapters for any given
  site needs that site's plugin installed first (a separate repository,
  `kiri-sources`, converts them over time).
- **New data layout and database schema.** Chapters/pages move from a
  manifest file re-read per request into first-class database rows; the
  Prisma schema, table names and most IDs are new. The importer
  (`docs/MIGRATING_FROM_V1.md`) reads a 1.x install directly and reproduces
  it here — it does not modify the 1.x install, and can be re-run safely.
- **New auth model.** Kiri 1.x's trusted-header identity (no passwords, no
  sessions) is replaced by real accounts. Imported 1.x users get
  `mustSetPassword` and a one-time invite link rather than instant access,
  unless the instance runs in Cloudflare Access mode, in which case a
  verified identity links automatically by email.
