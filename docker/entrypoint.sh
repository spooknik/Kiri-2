#!/bin/sh
# Kiri container entrypoint: migrate the database, then start the server.
set -e

echo "Kiri: running database migrations..."

# `prisma` lives in its own install at /app/prisma-runtime/node_modules (see the
# long comment on the `prisma-runtime` stage in docker/Dockerfile), separate from
# the app's own node_modules. NODE_PATH lets prisma.config.ts's
# `import "dotenv/config"` / `import { defineConfig } from "prisma/config"` resolve
# against that install even though it isn't an ancestor of apps/web on disk
# (verified locally: without NODE_PATH set, Node's module resolution walks up from
# prisma.config.ts's own directory and never finds it; with NODE_PATH set to this
# path, it resolves and the migration runs normally).
#
# Run from /app/apps/web: prisma.config.ts resolves its `schema`/`migrations`
# paths ("prisma/schema.prisma", "prisma/migrations") relative to the CLI's
# current working directory, not the config file's location.
export NODE_PATH="/app/prisma-runtime/node_modules"
(cd /app/apps/web && node /app/prisma-runtime/node_modules/prisma/build/index.js migrate deploy)

echo "Kiri: migrations complete."

# Only present in the `browser` image variant (docker/Dockerfile's `browser`
# stage) — resolved at build time since the exact revisioned Chromium path under
# PLAYWRIGHT_BROWSERS_PATH isn't known until after the install runs there. Silently
# absent (and silently skipped) in the base image, which ships no Chromium.
if [ -f /app/.playwright-chromium-path ]; then
  export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(cat /app/.playwright-chromium-path)"
  echo "Kiri: browser plugin support enabled (Chromium at ${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH})"
fi

echo "Kiri: starting server on ${HOSTNAME:-0.0.0.0}:${PORT:-3000} (DATA_ROOT=${DATA_ROOT:-/data})..."
exec node apps/web/server.js
