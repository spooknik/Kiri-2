/**
 * Per-worker setup for Vitest. Provides stable defaults so unit tests that
 * touch getEnv() never depend on the developer's .env.
 */
(process.env as Record<string, string | undefined>)["NODE_ENV"] ??= "test";
process.env.APP_SECRET ??= "test-secret-test-secret-test-secret-test-secret";
process.env.PUBLIC_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= "postgresql://kiri_test:kiri_test@localhost:54329/kiri_test";

// Server-side fetches of user-supplied URLs go through src/lib/net/safe-fetch,
// which refuses private, unroutable and unresolvable hosts. Test fixtures are
// exactly that (`https://example.test/cover.png`, a stubbed fetch, a local
// server), so the suite turns on the escape hatch that module documents. It is
// ignored when NODE_ENV=production, and src/lib/net/safe-fetch.test.ts deletes
// it so the real rules are still exercised.
process.env["KIRI_ALLOW_PRIVATE_FETCH"] ??= "1";

// The job runner keeps its state on globalThis (src/lib/jobs/runner.ts) so it
// survives Next's per-route module duplication. Vitest resets modules per
// test file but not globalThis, so a previous file's background drain could
// overlap with this file's jobs. Start every file with a fresh runner state;
// the handler registry is left alone because handler modules re-register on
// import anyway.
delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("kiri.jobs.runner.state")];

// And drain it cleanly at the end of the file: stop the sweep, let an in-flight
// drain finish, then drop the state so a later file never inherits it.
import { afterAll } from "vitest";

afterAll(async () => {
  const key = Symbol.for("kiri.jobs.runner.state");
  const globals = globalThis as unknown as Record<
    symbol,
    | { draining?: boolean; wanted?: boolean; sweep?: NodeJS.Timeout | null; started?: boolean }
    | undefined
  >;
  const state = globals[key];
  if (!state) return;
  if (state.sweep) clearInterval(state.sweep);
  state.sweep = null;
  state.started = false;
  state.wanted = false;
  const deadline = Date.now() + 10_000;
  while (state.draining && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  delete globals[key];
});
