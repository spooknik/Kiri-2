# Deploying Kiri

Kiri ships as a Docker image plus a `docker compose` file for PostgreSQL. This
guide covers the common case: one Kiri instance behind a reverse proxy (or
Cloudflare Tunnel), one Postgres database, one `/data` volume.

## Quick start

You need Docker and Docker Compose v2 (`docker compose version`). From the
repo root:

```bash
cp docker/.env.example docker/.env
```

Edit `docker/.env` and set the two required values — everything else has a
sane default:

| Variable            | What it is                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | Password for the `kiri` Postgres user/database the `db` service creates on first start.                  |
| `APP_SECRET`        | 32+ random bytes, e.g. `openssl rand -base64 48`. Derives session and plugin-credential encryption keys. |

Then start it:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

`--build` builds the image locally from the repo root using `docker/Dockerfile`.
Once a tagged image is published, drop `--build` (or set `KIRI_IMAGE` in
`docker/.env`) to pull `ghcr.io/spooknik/kiri` instead. Check status and logs:

```bash
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs -f app
```

The `app` service runs `prisma migrate deploy` automatically on every start
(see `docker/entrypoint.sh`), so there is no separate migration step. Confirm
the app is healthy:

```bash
curl -sf http://localhost:3000/api/health
```

`GET /api/health` returns `200` (`{"status":"ok", ...}`) when the database is
reachable, `503` (`{"status":"degraded", ...}`) otherwise — this is also what
the container's own `HEALTHCHECK` and the compose file's `healthcheck:` probe.

## First run

Visit `http://localhost:3000/setup` (or your `PUBLIC_URL`). While the `User`
table is empty, this wizard creates the first account and makes it an admin.
After that, registration follows `AppSetting.registrationMode` (`INVITE` by
default — the admin issues invite links from Admin → Invites; `OPEN` and
`CLOSED` are also available there).

## Environment reference

Set these on the `app` service (`docker/docker-compose.yml` reads them from
`docker/.env` — see `docker/.env.example` for the same list with defaults and
comments). This table matches `apps/web/src/lib/env.ts`, the single source of
truth for what the app reads and validates at startup.

| Variable                | Required | Default                 | Purpose                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | yes      | —                       | Set by the compose file from `POSTGRES_PASSWORD`; only set by hand outside compose.                                                                                                                                                                                                                                                                                       |
| `APP_SECRET`            | yes      | —                       | ≥32 characters. Derives the session signing key and, via HKDF, the AES-256-GCM key that encrypts plugin cookies at rest. Losing it invalidates stored plugin cookies (by design) — back it up with the rest of your secrets.                                                                                                                                              |
| `APP_SECRET_PREVIOUS`   | no       | —                       | Set this to the _old_ `APP_SECRET` while rotating: `APP_SECRET_PREVIOUS=<old value>`, `APP_SECRET=<new value>`. Credentials encrypted under the old key still decrypt (the envelope embeds a key id) until you re-encrypt and drop this variable.                                                                                                                         |
| `PUBLIC_URL`            | no       | `http://localhost:3000` | Absolute origin users load in a browser, scheme included. Used for auth cookies, better-auth's `trustedOrigins`, invite links and absolute links in notifications. A mismatch here is the single most common deployment problem — see Troubleshooting.                                                                                                                    |
| `DATA_ROOT`             | no       | `/data` (this image)    | Library images, covers, installed plugins, and job/upload temp files: `DATA_ROOT/{library,covers,plugins,tmp}`. The image creates `/data` owned by the `kiri` user; mount a volume there (the compose file does).                                                                                                                                                         |
| `AUTH_CF_ACCESS`        | no       | `0`                     | `1` enables Cloudflare Access mode — see below.                                                                                                                                                                                                                                                                                                                           |
| `AUTH_CF_TRUST_HEADER`  | no       | `0`                     | Fallback for `AUTH_CF_ACCESS=1` without JWT verification configured: trusts the identity header outright. **Only set this behind Cloudflare Access**, where Cloudflare's edge — not the client — sets that header. Startup fails unless `PUBLIC_URL` is an `https://` origin.                                                                                             |
| `AUTH_TRUST_PROXY`      | no       | `0`                     | `1` when this instance is only reachable through a reverse proxy or Cloudflare, so authentication rate limits may read the client IP from `cf-connecting-ip` / the first `x-forwarded-for` entry. Leave at `0` for a directly reachable instance: those headers are client-supplied, and believing them would let an attacker mint a fresh rate-limit bucket per request. |
| `CF_ACCESS_TEAM_DOMAIN` | no       | —                       | e.g. `yourteam.cloudflareaccess.com`. Required to verify the Access JWT when `AUTH_CF_ACCESS=1` (and `AUTH_CF_TRUST_HEADER` is not set).                                                                                                                                                                                                                                  |
| `CF_ACCESS_AUD`         | no       | —                       | Your Access application's Audience (AUD) tag. Required alongside `CF_ACCESS_TEAM_DOMAIN`.                                                                                                                                                                                                                                                                                 |
| `JOB_CONCURRENCY`       | no       | `1`                     | Background sync/import/plugin-install jobs run this many at a time; 1–8.                                                                                                                                                                                                                                                                                                  |
| `JOB_TIMEOUT_MS`        | no       | `7200000` (2h)          | Hard timeout for a single job before it's killed and marked failed.                                                                                                                                                                                                                                                                                                       |
| `KIRI_PLUGIN_SANDBOX`   | no       | `warn`                  | `on` \| `warn` \| `off`. Controls the Node `--permission` sandbox plugin subprocesses run under; `browser`/`subprocess`-capability plugins can't run fully sandboxed (they need child-process/broader FS access) and get a warning badge in the admin UI either way — this is defense in depth, not a substitute for only installing plugins you trust.                   |

`NODE_ENV` is set by the image/compose file and normally shouldn't be
overridden by hand.

## Reverse proxy and `PUBLIC_URL`

Kiri expects to sit behind a reverse proxy (nginx, Caddy, Traefik, a
Cloudflare Tunnel, …) that terminates TLS and forwards to `app:3000`
(container) or `localhost:3000` (host). A few things matter:

1. **Set `PUBLIC_URL` to the externally visible URL**, including scheme
   (`https://kiri.example.com`). Auth cookies and better-auth's
   `trustedOrigins` check are scoped to this exact origin; getting it wrong
   manifests as sign-in redirect loops or a `403` on the sign-in request
   itself.
2. **Forward the real client IP and scheme** (`X-Forwarded-For`,
   `X-Forwarded-Proto`) so rate limiting and secure-cookie logic see the
   right values. Most proxies do this by default; confirm yours does.
3. **Upload body size**: chapter/PDF uploads go through Kiri's own chunked
   upload endpoint, and each chunk request is capped at 8 MiB — comfortably
   under the ~10 MiB default body-size limit most reverse proxies ship with,
   so you generally don't need to raise anything. If your proxy's default is
   lower than that, raise its client body size limit to at least 8–10 MiB.

The service worker (`/offline`, downloaded chapters) expects to be served
from the same origin as the app — don't proxy `/api/*` to a different host
than the rest of the app.

## Cloudflare Access mode

For deployments that already sit behind Cloudflare Zero Trust and want SSO
instead of Kiri's own login form:

1. Put the app behind a Cloudflare Tunnel or DNS record proxied through
   Cloudflare, and protect it with an Access application.
2. Set `AUTH_CF_ACCESS=1`, `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` (from
   the Access application's Overview tab). Kiri verifies the
   `Cf-Access-Jwt-Assertion` header against your team's certs (via `jose`)
   and links the verified identity to an existing Kiri user with the same
   email, or creates one when registration allows it.
3. `AUTH_CF_TRUST_HEADER=1` is a fallback for setups that can't do JWT
   verification (e.g. a private network where you trust Cloudflare's edge
   unconditionally) — **only** enable it when the app is unreachable except
   through Cloudflare Access; it trusts the identity header with no
   signature check.

Normal email+password login keeps working alongside Access mode.

## Plugins

Kiri ships with **no content-source plugins** — every site is installed
separately. Installed plugins live under `DATA_ROOT/plugins/<id>/` (part of
the `/data` volume, so they survive updates and container recreation).

Install one from **Admin → Plugins**: paste a git URL or an HTTPS zip URL,
or upload a zip directly. You can also drop a plugin folder straight into
`DATA_ROOT/plugins/` on the host and restart the container — Kiri scans that
directory on boot. Installing, enabling, disabling and uninstalling all
require an admin account; the install confirmation screen shows the
plugin's declared capabilities, hosts and dependencies before anything runs.
See [`docs/PLUGINS.md`](PLUGINS.md) for what a plugin actually is and how the
subprocess sandbox works, and `KIRI_PLUGIN_SANDBOX` above for the sandbox
mode.

Installing from a git URL needs `git` inside the container, which the image
includes; if it's ever missing, use an HTTPS zip URL or an upload instead.

### The `-browser` image variant

The default image (`ghcr.io/spooknik/kiri:latest`) has no browser in it —
content-source plugins that only need plain HTTP work out of the box.
Plugins that declare the `browser` capability (they drive a headless
Chromium via Playwright, e.g. for JS-heavy or anti-bot sites) need the
`-browser` variant instead:

```bash
# docker/.env
KIRI_IMAGE=ghcr.io/spooknik/kiri:latest-browser
# or pin a release: ghcr.io/spooknik/kiri:v2.0.0-browser
```

```bash
docker compose -f docker/docker-compose.yml up -d
```

This image is meaningfully larger (Playwright's own Chromium build plus its
OS dependencies) — only switch to it if you plan to install a browser-capable
plugin. It's a superset of the base image (same entrypoint, same migrations),
so switching is a plain image swap, not a different deployment.

## The Kiri Cookie Bridge extension

Some sites gate access behind a Cloudflare (or similar) challenge that only a
real browser can solve. Rather than copying `cf_clearance` out of DevTools by
hand, the Kiri Cookie Bridge browser extension (`extension/`) captures a
site's cookies and User-Agent once you grant it access and pushes them to
your instance automatically.

1. Open **Admin → Plugins** and copy the **extension token** — it's derived
   from `APP_SECRET`, so it rotates automatically if you ever change that
   secret.
2. Load the extension (`extension/README.md` has the unpacked-install steps)
   and paste your instance's URL and that token into its options page.
3. Grant it access to the sites your installed plugins need; it asks your
   instance which hosts those are (`GET /api/plugins/hosts`) so there's
   nothing to keep in sync by hand as you install or remove plugins.

## Offline / PWA notes

The reader is a PWA with a service worker (see `docs/ARCHITECTURE.md` for the
caching strategy). Two deployment-relevant facts:

- **HTTPS is required** for a service worker to register in any real
  deployment — browsers only allow them on secure origins, with the single
  exception of `http://localhost`. If you're testing over plain HTTP on a LAN
  IP, the offline features simply won't activate; that's expected, not a bug.
  Put a reverse proxy with TLS (or a Cloudflare Tunnel) in front for offline
  support to work anywhere but `localhost`.
- The service worker and every API/asset it caches must be same-origin — see
  the reverse-proxy note above about not splitting `/api/*` onto a different
  host.

## Updating

```bash
docker compose -f docker/docker-compose.yml pull   # or `up -d --build` if building locally
docker compose -f docker/docker-compose.yml up -d
```

Migrations run automatically on the new container's start
(`prisma migrate deploy` in `docker/entrypoint.sh`); Kiri's migrations are
additive-only, so this is safe to run unattended. Check `docker compose logs
app` after updating if anything looks off, and `/api/health` for a quick
green/red check.

## Backups

Two things make up your data: the Postgres database and the `DATA_ROOT`
volume (library images, covers, installed plugins).

**Database:**

```bash
docker compose -f docker/docker-compose.yml exec db \
  pg_dump -U kiri kiri | gzip > kiri-db-$(date +%F).sql.gz
```

Restore into a fresh `db` volume with `gunzip -c backup.sql.gz | docker
compose -f docker/docker-compose.yml exec -T db psql -U kiri kiri`.

**`/data`:** back up the `kiri_data` volume (or your bind-mounted
`DATA_ROOT` path if you changed the compose file to use one) with your usual
volume-backup tooling, e.g.:

```bash
docker run --rm -v kiri_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/kiri-data-$(date +%F).tar.gz -C / data
```

Back up both together (a DB restore that references chapters/covers not
present on disk — or vice versa — is inconsistent); stopping the `app`
service first avoids the small race of a backup mid-write.

## Migrating from Kiri 1.x

Kiri 2.0 is not an in-place upgrade of a 1.x install — it's a new instance
with a real accounts system, and a one-shot, read-only, idempotent importer
reads a running (or stopped) 1.x database plus its `rips`/`covers` data
directory and reproduces it here. See **[docs/MIGRATING_FROM_V1.md](MIGRATING_FROM_V1.md)**
for the step-by-step guide, including the admin UI and CLI, dry runs, and
what happens to sites that have no installed plugin yet (`NEEDS_PLUGIN`).

## Troubleshooting

| Symptom                                                                                        | Likely cause                                                                                | Fix                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container exits immediately with an `APP_SECRET` validation error                              | `APP_SECRET` is missing or shorter than 32 characters                                       | Set a real secret, e.g. `openssl rand -base64 48`, in `docker/.env`                                                                                                                             |
| Sign-in form submits and comes back `403`, or redirect-loops back to `/login`                  | `PUBLIC_URL` doesn't match the origin the browser is actually using (scheme, host, or port) | Set `PUBLIC_URL` to exactly what's in the browser's address bar, including `https://` if you're behind TLS                                                                                      |
| A series' source shows `NEEDS_CREDENTIAL` and sync fails                                       | The site needs a cookie (e.g. a Cloudflare challenge) that isn't set, or it expired         | Paste a fresh cookie on the series' source panel, or use the Kiri Cookie Bridge extension (above)                                                                                               |
| A series' source shows `NEEDS_PLUGIN`                                                          | No installed plugin's `hosts` match that source (common right after a V1 import)            | Install a plugin for that site under Admin → Plugins; syncing resumes automatically once installed                                                                                              |
| `npm run db:dev` fails during `initdb` on Windows, or non-Latin series titles come out garbled | The embedded dev Postgres inherited the Windows system code page instead of UTF-8           | Already handled in `apps/web/scripts/db-dev.mts` (`initdbFlags: ["--encoding=UTF8", "--locale=C"]`); if you see this anyway, delete `apps/web/.pgdata` and let `npm run db:dev` reinitialize it |
| Offline mode / install-as-app doesn't work                                                     | Serving over plain HTTP on a non-`localhost` host                                           | Service workers require HTTPS except on `localhost` — see Offline / PWA notes above                                                                                                             |

For development environment issues (not deployment), see
[`docs/CONTRIBUTING.md`](CONTRIBUTING.md).
