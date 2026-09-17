# Kiri

Kiri is a self-hosted, collaborative reading tracker and offline-first web
reader for manga, manhwa, manhua, comics and light novels. Version 2 is a
ground-up rewrite of Kiri 1.x: real accounts instead of a trusted header,
installable content-source plugins instead of baked-in site scrapers,
first-class chapters and pages instead of a manifest file re-read on every
request, frame-anchored notes, and an offline mode that actually works when
the network doesn't.

**Collaborative by design.** Kiri runs one shared library per instance —
everyone who signs in sees the same series by default. A series can be marked
`PRIVATE` (visible only to its creator) or left `SHARED`, and adult content is
hidden per-viewer unless a profile setting turns it on. There's no per-user
tenancy to configure: invite the people you read with and the library is
already shared.

**Offline reader.** The web reader is a PWA. Download a chapter, and it (and
the app shell around it) keeps working with no connection — reading position,
chapter-read state and notes queue locally and sync back the moment you're
online again.

**Plugins, not built-in scrapers.** Kiri 2.0 ships with **no content-source
plugins**. Every site is a small Node program an admin installs — from a git
URL, an HTTPS zip, an uploaded zip, or a folder dropped into a mounted volume
— and Kiri runs it as a subprocess with a narrow, allowlisted environment and
an optional OS-level sandbox. See [`docs/PLUGINS.md`](docs/PLUGINS.md) to
write one; [`packages/source-template`](packages/source-template) is a
working example to start from.

## Screenshots

Coming soon — Kiri 2.0 is in alpha and the UI is still settling.

## Features

- **Real accounts** — email + password via better-auth, invite-only
  registration by default (open/closed modes available), admin roles, and an
  optional Cloudflare Access mode for teams that already sit behind Zero
  Trust.
- **Shared library, private series** — one library per instance;
  `visibility = SHARED | PRIVATE` per series, adult content gated per viewer.
- **Content-source plugins** — descriptor + subprocess ABI over stdio, JSON
  Lines events, a closed error-code set, and a Node permission-model sandbox
  (`KIRI_PLUGIN_SANDBOX`). Install from a git URL, a zip, or a drop-in folder.
- **First-class chapters and pages** — ingested into Postgres (not re-parsed
  from disk on every page view), with real image dimensions so the reader
  never reflows.
- **Frame-anchored notes** — pin a note to a page, optionally to a normalized
  x/y point on the image; thread replies; spoiler-safe (hidden past your
  reading position, or when flagged, until you choose to reveal).
- **Offline-first reader** — a service worker precaches the app shell and
  reader route; downloaded chapters, covers and library data are available
  with no connection; an `/offline` hub lists what's downloaded and how much
  space it uses.
- **Background jobs** — syncing, plugin installs, PDF import, manual uploads
  and image optimization run as Postgres-backed jobs with heartbeats, retries,
  and clean cancellation (including killing a plugin's whole process tree).
- **One-shot V1 importer** — reads a running Kiri 1.x database and data
  directory directly (read-only, idempotent, dry-run first) and reproduces it
  in Kiri 2. See [`docs/MIGRATING_FROM_V1.md`](docs/MIGRATING_FROM_V1.md).

## Quick start (Docker)

You need Docker and Docker Compose v2. From the repo root:

```bash
cp docker/.env.example docker/.env
```

Edit `docker/.env` and set the two required values:

| Variable            | What it is                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | Password for the `kiri` Postgres user/database the `db` service creates.                                 |
| `APP_SECRET`        | 32+ random bytes, e.g. `openssl rand -base64 48`. Derives session and plugin-credential encryption keys. |

Then start it:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

`--build` builds the image locally; once a tagged image is published, drop it
(or set `KIRI_IMAGE`) to pull `ghcr.io/spooknik/kiri` instead. The full guide
— every environment variable, reverse proxy notes, Cloudflare Access,
plugins, backups — is in **[docs/DEPLOY.md](docs/DEPLOY.md)**.

### First run

Visit `http://localhost:3000/setup` (or your `PUBLIC_URL`). While the user
table is empty, this wizard creates the first account and makes it an admin.
After that, registration follows the instance's registration mode
(`INVITE` by default — issue invite links from Admin → Invites).

## Development

No Docker required — PostgreSQL is provided by an embedded server.

Requirements: **Node 24+**, npm 11+.

```bash
npm install
cp apps/web/.env.example apps/web/.env   # then set APP_SECRET
npm run db:dev                            # terminal 1: embedded PostgreSQL
npm run db:migrate                        # apply migrations
npm run dev                               # terminal 2: http://localhost:3000
```

Other scripts, run from the repo root:

```bash
npm run lint          # ESLint across every workspace
npm run typecheck      # tsc --noEmit across every workspace
npm test               # Vitest unit + integration tests (boots its own embedded Postgres)
npm run test:e2e       # Playwright, against a production build (npx playwright install --with-deps chromium first)
npm run build           # @kiri/source-sdk, then apps/web (Next build + serwist build)
```

See **[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)** for test layers, code
conventions, and Windows-specific setup notes (embedded Postgres encoding, an
npm workspace optional-dependency quirk with esbuild).

## Repo layout

```
apps/web/                 Next.js app, package "kiri"
  prisma/                 schema.prisma + migrations
  src/app/                (app)/, (auth)/, admin/, api/, read/, offline/, setup/
  src/lib/                api.ts, authz.ts, auth/, content/, jobs/, plugins/,
                          import-v1/, offline/, crypto.ts, env.ts, prisma.ts …
  src/components/         library/, series/, reader/, notes/, admin/, ui/
packages/source-sdk/      @kiri/source-sdk — the plugin SDK
packages/source-template/ example plugin on the SDK; also the e2e fixture site
extension/                Kiri Cookie Bridge (MV3 browser extension)
docker/                   Dockerfile, compose files, entrypoint
docs/                     architecture, deployment, plugins, migrating from 1.x
```

## Documentation

- [docs/DEPLOY.md](docs/DEPLOY.md) — deploying with Docker Compose, the full
  environment reference, reverse proxy notes, Cloudflare Access, plugins,
  backups, updating, troubleshooting.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together:
  auth, authorization, jobs, plugins, offline, notes, the importer.
- [docs/PLUGINS.md](docs/PLUGINS.md) — writing a content-source plugin.
- [docs/MIGRATING_FROM_V1.md](docs/MIGRATING_FROM_V1.md) — importing a Kiri
  1.x instance.
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) — dev environment, test
  layers, conventions, PR checklist.
- [extension/README.md](extension/README.md) — the Kiri Cookie Bridge browser
  extension.

## Status

**Alpha.** Kiri 2.0 is a from-scratch rewrite of a previously
household-only project; the core tracker, plugin system, offline reader,
notes and V1 importer are built and covered by unit, integration and
end-to-end tests, but it has not yet had a tagged release or wide real-world
use. Expect rough edges, and expect the plugin ABI and data model to still
move before `2.0.0`. No content-source plugins ship in this repo — every
site is installed separately.

## License

Kiri is licensed under the [GNU AGPL v3](LICENSE). The plugin SDK (`packages/source-sdk`) and the template plugin are [MIT](packages/source-sdk/LICENSE) so third-party plugins can use any license they like.
