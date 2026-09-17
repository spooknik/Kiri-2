# Contributing to Kiri

Kiri is an npm workspaces monorepo (`apps/web`, `packages/source-sdk`,
`packages/source-template`). This document covers the dev environment, test
layers, code conventions, and the PR checklist. For the system design, read
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) first.

## Dev environment

**No Docker needed.** PostgreSQL is provided by an embedded server
(`embedded-postgres`), both for `npm run dev` and for the test suites.

Requirements: Node 24+, npm 11+.

```bash
npm install
cp apps/web/.env.example apps/web/.env   # then set APP_SECRET
npm run db:dev                            # terminal 1: embedded PostgreSQL on :5432
npm run db:migrate                        # apply migrations (or db:migrate:dev to also create one)
npm run dev                               # terminal 2: http://localhost:3000
```

`npm run db:dev` (`apps/web/scripts/db-dev.mts`) initializes its data
directory at `apps/web/.pgdata` on first run and keeps the server up until you
Ctrl+C it. If you'd rather run Postgres in Docker instead, `docker compose -f
docker/docker-compose.dev.yml up -d` starts one that matches the default
`DATABASE_URL` in `.env.example` exactly.

### Windows notes

- **UTF-8 is already handled.** Both the dev database (`db-dev.mts`) and the
  test databases (`test/embedded-db.ts`) pass `initdbFlags:
["--encoding=UTF8", "--locale=C"]` to `embedded-postgres`. Without this,
  `initdb` on Windows inherits the system code page (commonly WIN1252) and
  non-Latin series titles fail to insert. You shouldn't need to do anything
  here — it's called out in case you ever see a `PG_VERSION`/encoding error
  and wonder whether it's your machine.
- **npm workspace optional-dependency quirk.** `npm install` in an npm
  workspaces monorepo sometimes fails to install the platform-specific
  optional dependency a native tool needs on Windows — most visibly,
  `esbuild`'s `@esbuild/win32-x64` binary (a transitive dependency via Vitest
  and other tooling), which `npm ci`/`npm install` can silently omit. If you
  hit an error like `Cannot find module '...esbuild.exe'` or `The "esbuild"
binary...` on Windows after a clean install, work around it with:

  ```bash
  npm install --no-save @esbuild/win32-x64@0.28.2
  ```

  (match the version to whatever `esbuild` your lockfile actually resolved —
  check `package-lock.json` for `node_modules/esbuild`'s `version` field if
  in doubt). This is a known npm workspaces limitation, not a Kiri bug; you
  only need it once per clean `node_modules`.

## Scripts

Run from the repo root unless noted. Most delegate into the relevant
workspace via `npm run <script> -w <workspace>`.

| Script                               | What it does                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                        | Next.js dev server (`apps/web`)                                                                                                                                                                                              |
| `npm run build`                      | Builds `@kiri/source-sdk`, then `apps/web` (`prisma generate && next build && serwist build`)                                                                                                                                |
| `npm run lint`                       | ESLint across every workspace that defines a `lint` script                                                                                                                                                                   |
| `npm run typecheck`                  | `tsc --noEmit` across every workspace                                                                                                                                                                                        |
| `npm run typecheck:sw -w apps/web`   | Type-checks `src/app/sw.ts` against `tsconfig.sw.json` separately — it's excluded from the main `tsconfig.json` because the service worker's `WebWorker` globals clash with the DOM lib the rest of the app compiles against |
| `npm test`                           | Vitest unit + integration tests across every workspace (`apps/web` boots its own embedded Postgres for the duration)                                                                                                         |
| `npm run test:e2e`                   | Playwright e2e (`apps/web`); run `npx playwright install --with-deps chromium` once first                                                                                                                                    |
| `npm run format` / `format:check`    | Prettier, write or check, across the whole repo                                                                                                                                                                              |
| `npm run db:dev -w apps/web`         | Embedded PostgreSQL for local dev                                                                                                                                                                                            |
| `npm run db:migrate -w apps/web`     | `prisma migrate deploy`                                                                                                                                                                                                      |
| `npm run db:migrate:dev -w apps/web` | `prisma migrate dev` (creates a new migration from schema changes)                                                                                                                                                           |
| `npm run db:studio -w apps/web`      | Prisma Studio                                                                                                                                                                                                                |
| `npm run import:v1 -w apps/web`      | The V1 importer CLI — see `docs/MIGRATING_FROM_V1.md`                                                                                                                                                                        |

## Test layers

All under `apps/web` unless noted; Vitest config is `apps/web/vitest.config.mts`.

| Layer       | File pattern                                                         | Environment          | Notes                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `*.test.ts`                                                          | Node, no database    | Pure functions and modules that don't touch Prisma — the majority of the suite.                                                                                                                                                                          |
| Integration | `*.int.test.ts`                                                      | Node, real Postgres  | Exercises route handlers, the job runner, ingest, and the plugin installer against an embedded Postgres instance started once by `test/global-setup.ts`. Runs with `fileParallelism: false` — these files share one database, so they run one at a time. |
| Component   | `*.test.ts(x)` with a leading `// @vitest-environment jsdom` comment | jsdom                | Uses `@testing-library/react`; the pragma opts a single file into jsdom without changing the suite's default `node` environment.                                                                                                                         |
| End-to-end  | `apps/web/e2e/**/*.spec.ts`                                          | Playwright, Chromium | Runs against a **production build** (`next build && next start` on port 3100, `e2e/global-setup.ts`), with its own embedded Postgres, so the service worker and offline behavior are exercised exactly as deployed.                                      |

`packages/source-sdk` has its own Vitest suite (`packages/source-sdk/test/`,
run via `npm run test -w packages/source-sdk`), including a `template.e2e`
test that runs the SDK against `packages/source-template`'s fixture site —
covered by the root `npm test` (`--workspaces --if-present`).

## Conventions

- **Contracts live in `src/lib/contracts/`.** Every API route's request/
  response shape is a zod schema (and inferred TS type) in this directory,
  re-exported from `src/lib/contracts/index.ts`. A route imports its schema
  from here; nothing hand-rolls validation inline.
- **Routes are built from `withAuth`/`withPublic`** (`src/lib/api.ts`), never
  a bare Next.js route handler with manual session checks. Pass `{ query,
body, role }` schemas/requirements; the handler receives typed, already-
  validated `user`/`query`/`body`. Errors are thrown as `ApiError`
  (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, …) and
  the toolkit turns them into the standard `{ error: { code, message,
details? } }` response with the right status code.
- **Authorization goes through `src/lib/authz.ts`**, not ad hoc checks in a
  route. `canViewSeries`/`assertCanViewSeries`, `canEditSeries`/
  `assertCanEditSeries`, `requireAdmin`, and `visibleSeriesWhere` for list
  queries. See `docs/ARCHITECTURE.md`'s authorization table for the rules
  themselves.
- **Job handlers register themselves.** A new `JobKind` needs a Prisma enum
  value, a handler module under `src/lib/jobs/handlers/` that calls
  `registerJobHandler(kind, handler, options)` at module scope, and an
  `import "./your-handler"` line added to `src/lib/jobs/handlers/index.ts` (the
  single place every handler is imported, so `instrumentation.ts` can await it
  once before starting the runner). A kind with no registered handler fails
  its jobs with `NO_HANDLER` instead of leaving them `QUEUED` forever.
- **No direct `fetch` in components.** Client components call the API
  through `src/lib/api-client.ts` (`apiFetch`, throws `ApiClientError` with a
  `status`/`code`), normally wrapped in a feature-specific TanStack Query
  hook (`src/hooks/`, or a feature's own `use-*.ts`). This is what lets the
  offline sync queue and query cache stay consistent — a component bypassing
  it with a raw `fetch` won't participate in either.
- **Serialization is centralized per feature** (e.g. `src/lib/jobs/
serialize.ts`, `src/lib/notes/serialize.ts`): Prisma rows convert to their
  wire shape (dates → ISO strings, etc.) in exactly one module per feature, so
  the contract type in `src/lib/contracts/` is the only description of the
  wire format a client needs.

### Adding an API route

1. Add (or extend) a zod schema in `src/lib/contracts/<area>.ts` for the
   request/response shape; re-export it from `src/lib/contracts/index.ts` if
   it's new.
2. Add `route.ts` under `src/app/api/<path>/`, exporting `GET`/`POST`/etc.
   built with `withAuth`/`withPublic` and your schema(s) — see
   `src/app/api/notifications/route.ts` for a short, representative example.
3. Put the actual logic in a `src/lib/` module the route calls into, not
   inline in the route handler, so it's unit/integration-testable without an
   HTTP layer.
4. If the route can be reached from the client, add a thin wrapper in the
   relevant `src/lib/api-client.ts`-based module and, if it's used from a
   component, a TanStack Query hook.

### Adding a job kind

1. Add the value to the `JobKind` enum in `apps/web/prisma/schema.prisma` and
   run `npm run db:migrate:dev -w apps/web` to generate the migration.
2. Create `src/lib/jobs/handlers/<kind>.ts` exporting a handler and calling
   `registerJobHandler("<KIND>", handler, options)` at module scope.
3. Add `import "./<kind>"` to `src/lib/jobs/handlers/index.ts`.
4. Wherever the job should be enqueued, call `enqueueJob` (`src/lib/jobs/
queue.ts`) with the new kind and its `configJson`.
5. Write an integration test (`*.int.test.ts`) that enqueues the job and
   drives the runner (`processJobsUntilIdle` in tests — see
   `src/lib/jobs/runner.int.test.ts` for the pattern) rather than asserting
   against the handler function directly.

### Adding a content-source plugin

Not part of this repo's app code — see [`docs/PLUGINS.md`](PLUGINS.md), the
full authoring guide, and start from
[`packages/source-template`](../packages/source-template) as a working
example.

## PR checklist

Before opening a PR, from the repo root:

```bash
npm run typecheck                      # tsc --noEmit, every workspace
npm run typecheck:sw -w apps/web       # service worker, checked separately
npm run lint                            # ESLint, every workspace
npm test                                # Vitest unit + integration
npm run test:e2e                        # Playwright (install browsers first if you haven't)
npx prettier --check .                  # or `npm run format` to fix in place
```

CI (`.github/workflows/ci.yml`) runs the same checks on every push and pull
request, plus a Docker build validation of the `runner` target — treat a red
CI run the same as a failing check locally, not something to work around.
