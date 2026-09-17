# syntax=docker/dockerfile:1
#
# Kiri 2.0 container image.
#
# Build from the REPO ROOT (this is why docker-compose.yml sets `context: ..` /
# `dockerfile: docker/Dockerfile`): the app is an npm workspaces monorepo and
# `npm ci` needs every workspace package.json plus the root lockfile to resolve
# correctly, and Next's `outputFileTracingRoot` (apps/web/next.config.ts) is the
# repo root, so the standalone build's relative paths only make sense with the
# whole monorepo in the build context.
#
# Stages:
#   deps           - installs the full workspace dependency tree from the lockfile
#   prisma-runtime - a SEPARATE, minimal install used only to run `prisma migrate
#                    deploy` at container startup (see the comment on that stage)
#   build           - builds @kiri/source-sdk, generates the Prisma client, builds
#                     the Next.js app, and packs the SDK into an installable tree
#   runner          - the production image: standalone Next server + prisma-runtime
#                     + the packed SDK, running as a non-root user
#   browser         - `runner` plus Playwright's own Chromium + OS deps, for
#                     browser-capable content-source plugins (opt-in, larger image)
#
# Build args:
#   NEXT_PUBLIC_APP_VERSION - stamped into the UI/version endpoints (git tag on
#                              release builds, `dev` otherwise; see next.config.ts)

ARG NODE_IMAGE=node:24-bookworm-slim

#######################################################################
# deps — resolve the full workspace dependency tree from the lockfile.
#
# Only manifests are copied here, not source, so this layer stays cached across
# every source-only change and is only invalidated when a package.json or the
# lockfile changes. `--ignore-scripts` skips apps/web's `postinstall` (`prisma
# generate`), which would fail here anyway: it needs prisma/schema.prisma, which
# doesn't exist in this stage. Prisma generation happens explicitly in `build`,
# once the full source is present.
#######################################################################
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
# Every workspace under packages/ (SDK, template, bundled source plugins). Only
# their manifests matter for `npm ci`; the runner stage never copies plugin code.
COPY packages ./packages
RUN npm ci --ignore-scripts

#######################################################################
# prisma-runtime — an install of ONLY `prisma`, `@prisma/client`,
# `@prisma/adapter-pg`, `pg` and `dotenv`, isolated from the app's own
# node_modules, used exclusively to run `prisma migrate deploy` at container
# startup (see entrypoint.sh).
#
# Why not just run migrations from whatever Next traced into
# `.next/standalone/node_modules`? Next's output file tracing follows the JS
# `require`/`import` graph reachable from the server bundle, not "what the
# `prisma` CLI needs to run a migration" — the migration engine binaries, the
# `prisma.config.ts` loader, etc. aren't guaranteed to survive tracing, and
# relying on undocumented tracing behavior for something as important as "can
# we migrate the database" is fragile. A dedicated, explicit install pinned to
# the exact same versions apps/web depends on is simple, robust, and doesn't
# grow the runtime image much (this is a devDependency-sized install, not the
# whole app).
#
# `docker/prisma-runtime.package.json` is NOT a workspace member (npm workspaces
# would otherwise try to hoist/dedupe it against apps/web and complicate the
# lockfile), so it has no committed lockfile of its own. `npm install
# --package-lock-only` resolves one on the fly, then `npm ci` installs from that
# resolved lockfile — reproducible within a single build, auditable, and exact
# (no floating installs), without hand-maintaining a second lockfile in the repo.
#######################################################################
FROM ${NODE_IMAGE} AS prisma-runtime
WORKDIR /app/prisma-runtime
COPY docker/prisma-runtime.package.json ./package.json
RUN npm install --package-lock-only --omit=dev \
 && npm ci --omit=dev \
 && npm cache clean --force

#######################################################################
# build — build the SDK, generate the Prisma client, build the Next.js app.
#######################################################################
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_APP_VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=${NEXT_PUBLIC_APP_VERSION}

# Build-time env: src/lib/env.ts fills safe placeholders while NEXT_PHASE is
# phase-production-build, so no DATABASE_URL/APP_SECRET is needed here.

# Bring in the resolved node_modules from `deps`, then lay the full source on
# top (this re-copies the manifests already present, which is harmless).
COPY --from=deps /app ./
COPY . .

# @kiri/source-sdk first: nothing in apps/web imports it at runtime (plugins do,
# at install time, against the packed tarball below — not this build), but
# building it here is what lets us pack it a few lines down.
RUN npm run build -w packages/source-sdk

# `apps/web`'s own `build` script is `prisma generate && next build`, which is
# exactly "generate the Prisma client, then build Next" in one workspace-scoped
# command.
RUN npm run build -w apps/web

# Pack @kiri/source-sdk into a plain, installable tree at /app/sdk/<version>/
# (the same shape `npm install <tarball>` would leave behind: package.json,
# dist/, README.md — see the SDK's package.json "files" field). The plugin
# installer (apps/web/src/lib/plugins) symlinks/junctions a plugin's
# `node_modules/@kiri/source-sdk` straight at this directory instead of hitting
# npm's registry, so zip-uploaded plugins install with no network access and
# every installed plugin is guaranteed to get the SDK version that shipped with
# this image.
RUN set -eu; \
    SDK_VERSION="$(node -p "require('./packages/source-sdk/package.json').version")"; \
    mkdir -p /app/sdk/_pack "/app/sdk/${SDK_VERSION}"; \
    npm pack -w packages/source-sdk --pack-destination /app/sdk/_pack; \
    tar -xzf /app/sdk/_pack/*.tgz -C "/app/sdk/${SDK_VERSION}" --strip-components=1; \
    rm -rf /app/sdk/_pack; \
    printf '%s' "${SDK_VERSION}" > /app/sdk/VERSION

#######################################################################
# runner — production image. Non-root user `kiri` (uid/gid 1001).
#######################################################################
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
# KIRI_SDK_ROOT points at the packed SDK tree copied in below. The exact
# directory is /app/sdk/<version>, which is only knowable after the `build`
# stage runs `npm pack` — so that stage writes the version to /app/sdk/VERSION
# and apps/web/src/lib/plugins/sdk-link.ts reads it from there. (A plain
# `ENV KIRI_SDK_DIR=/app/sdk/<version>` cannot work: Dockerfile ENV
# instructions cannot consume a prior RUN's output. KIRI_SDK_DIR still
# overrides this when someone wants to point at a specific tree.)
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATA_ROOT=/data \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    KIRI_SDK_ROOT=/app/sdk

# `git` is here for exactly one reason: an admin may install a content-source
# plugin straight from a git URL, which runs `git clone --depth 1` inside the
# container (apps/web/src/lib/plugins/installer.ts). Without it that path fails
# with GIT_UNAVAILABLE and the admin has to upload a zip instead.
# `ca-certificates` comes along so HTTPS clones — and plugin zip downloads —
# can verify the other end.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 kiri \
 && useradd --system --uid 1001 --gid kiri --home-dir /app --shell /usr/sbin/nologin kiri

# The standalone server and its own pruned node_modules
# (.next/standalone/{apps/web/server.js, apps/web/.next, node_modules, ...} —
# see the "outputFileTracingRoot" comment in apps/web/next.config.ts for why the
# standalone tree is nested under apps/web/ instead of sitting at the repo root).
COPY --from=build --chown=kiri:kiri /app/apps/web/.next/standalone ./

# Next's standalone output deliberately excludes the static asset folder and
# `public/` (see the Next.js standalone docs / the build's own reminder output)
# — they must be copied next to server.js by hand.
COPY --from=build --chown=kiri:kiri /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=kiri:kiri /app/apps/web/public ./apps/web/public

# Prisma schema/migrations/config, read by `prisma migrate deploy` at startup
# (prisma.config.ts's paths are relative to the CLI's cwd, so entrypoint.sh runs
# it from /app/apps/web).
COPY --from=build --chown=kiri:kiri /app/apps/web/prisma ./apps/web/prisma
COPY --from=build --chown=kiri:kiri /app/apps/web/prisma.config.ts ./apps/web/prisma.config.ts

# The dedicated prisma CLI install — see the long comment on the `prisma-runtime`
# stage above.
COPY --from=prisma-runtime --chown=kiri:kiri /app/prisma-runtime /app/prisma-runtime

# The packed SDK tree plugin installs symlink against.
COPY --from=build --chown=kiri:kiri /app/sdk /app/sdk

COPY --chown=kiri:kiri docker/entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh \
 && mkdir -p /data/library /data/covers /data/plugins /data/tmp \
 && chown -R kiri:kiri /data

USER kiri
EXPOSE 3000

# No `curl`/`wget` in the slim base image — probe the health endpoint with Node
# itself instead of adding a package just for the healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["sh", "/app/entrypoint.sh"]

#######################################################################
# browser — `runner` plus Playwright's own Chromium, for content-source plugins
# that declare the `browser` capability. Opt-in: significantly larger image,
# tagged separately (`kiri:<version>-browser`) so the default image stays lean
# for plugins that only need plain HTTP.
#
# Deliberately NOT the Debian `chromium` apt package: its crashpad handler
# SIGTRAPs in headless containers ("chrome_crashpad_handler: --database is
# required"), which `--disable-crashpad`/`--disable-breakpad` does not
# suppress (see Kiri 1.x's Dockerfile history). Playwright's own downloaded
# Chromium build does not have this problem.
#
# Every browser-capable plugin brings and pins its own `playwright` dependency
# (packages/source-sdk's browser.ts peer-depends on `playwright`, it is not
# vendored by the SDK or this image) and installs it at plugin-install time.
# What this stage provides is the shared browser binary cache: Playwright keys
# downloaded browsers by revision under PLAYWRIGHT_BROWSERS_PATH, so whatever
# `playwright` version a given plugin pins finds a matching binary here without
# re-downloading Chromium per plugin (same approach Kiri 1.x used for its
# browser-based rippers).
#######################################################################
FROM runner AS browser
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Installed into a throwaway location, not the app's own node_modules — this
# copy of `playwright` only exists to drive the install and to resolve the
# Chromium binary's path once; it is deleted at the end of this layer.
#
# PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH can't be set with a plain `ENV` because
# its value (a revision-specific path under /ms-playwright) isn't known until
# after the install below runs, and Dockerfile `ENV` instructions can't consume
# a prior RUN's output. Instead the resolved path is written to a file here and
# exported by entrypoint.sh at container start — functionally equivalent (the
# running server process sees the env var either way), just resolved at the
# only point it's actually knowable.
RUN set -eu; \
    mkdir -p /opt/playwright-install && cd /opt/playwright-install; \
    npm init -y >/dev/null; \
    npm install --no-audit --no-fund playwright@1.63.0; \
    node_modules/.bin/playwright install --with-deps chromium; \
    node -e "require('fs').writeFileSync('/app/.playwright-chromium-path', require('playwright-core').chromium.executablePath())"; \
    cd /app && rm -rf /opt/playwright-install /var/lib/apt/lists/*; \
    chown -R kiri:kiri /ms-playwright /app/.playwright-chromium-path

USER kiri
