/**
 * Shared helper: boot an embedded PostgreSQL for tests (Vitest integration
 * tests and Playwright e2e) and apply migrations. No Docker required.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

export interface TestDatabase {
  url: string;
  stop: () => Promise<void>;
}

export interface TestDatabaseOptions {
  /** Directory for the data files (created if missing). */
  dataDir: string;
  port: number;
  /** Drop and recreate the database each time (default true). */
  fresh?: boolean;
}

export async function startTestDatabase(options: TestDatabaseOptions): Promise<TestDatabase> {
  const { dataDir, port, fresh = true } = options;
  const user = "kiri_test";
  const password = "kiri_test";
  const database = "kiri_test";

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: true,
    // Match production PostgreSQL: UTF-8 everywhere. Without this, initdb on
    // Windows inherits the system code page (WIN1252) and non-Latin titles fail.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    // Keep test output quiet unless something goes wrong.
    onLog: () => {},
    onError: (msg: unknown) => console.error(String(msg)),
  });

  if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
    await pg.initialise();
  }
  await pg.start();

  const client = pg.getPgClient();
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  if (exists.rowCount && fresh) {
    await client.query(`DROP DATABASE ${database} WITH (FORCE)`);
  }
  if (!exists.rowCount || fresh) {
    await pg.createDatabase(database);
  }
  await client.end();

  const url = `postgresql://${user}:${password}@localhost:${port}/${database}`;

  // Apply migrations with the Prisma CLI so tests run against the same SQL as
  // production. cwd = apps/web so prisma.config.ts is found. The CLI entry is
  // invoked directly with node (no shell), which works the same on Windows.
  const appDir = path.resolve(__dirname, "..");
  const prismaCli = [
    path.resolve(appDir, "../../node_modules/prisma/build/index.js"),
    path.resolve(appDir, "node_modules/prisma/build/index.js"),
  ].find((candidate) => existsSync(candidate));
  if (!prismaCli) {
    throw new Error("Could not locate the prisma CLI (node_modules/prisma/build/index.js)");
  }
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: appDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  return {
    url,
    stop: async () => {
      await pg.stop();
    },
  };
}

/** Remove a test data directory (used by teardown when it is throwaway). */
export function removeDataDir(dataDir: string): void {
  rmSync(dataDir, { recursive: true, force: true });
}
