/**
 * Vitest global setup: start an embedded PostgreSQL once per run and expose
 * it to workers through the environment. Unit tests ignore it; integration
 * tests read TEST_DATABASE_URL.
 */
import path from "node:path";
import { startTestDatabase, type TestDatabase } from "./embedded-db";

let db: TestDatabase | null = null;

export async function setup(): Promise<void> {
  if (process.env.VITEST_SKIP_DB === "1") return;
  const port = Number(process.env.TEST_PGPORT ?? 54329);
  db = await startTestDatabase({
    dataDir: path.resolve(__dirname, "..", `.pgdata-test-${port}`),
    port,
    fresh: true,
  });
  process.env.TEST_DATABASE_URL = db.url;
  process.env.DATABASE_URL = db.url;
  process.env.APP_SECRET ??= "test-secret-test-secret-test-secret-test-secret";
  process.env.PUBLIC_URL ??= "http://localhost:3000";
}

export async function teardown(): Promise<void> {
  await db?.stop();
  db = null;
}
