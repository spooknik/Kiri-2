/**
 * Local development PostgreSQL without Docker.
 *
 * Starts an embedded PostgreSQL server (binaries from the embedded-postgres
 * package) with its data directory in apps/web/.pgdata and keeps it running
 * until Ctrl+C. Matches the default DATABASE_URL in .env.example:
 *   postgresql://kiri:kiri@localhost:5432/kiri
 *
 * Usage: npm run db:dev            (from the repo root or apps/web; runs on Node 24 native TS, no build step)
 *        PGPORT=5433 npm run db:dev
 */
import { existsSync } from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const port = Number(process.env.PGPORT ?? 5432);
const user = process.env.PGUSER ?? "kiri";
const password = process.env.PGPASSWORD ?? "kiri";
const database = process.env.PGDATABASE ?? "kiri";
const databaseDir = path.resolve(process.cwd(), ".pgdata");

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir,
    user,
    password,
    port,
    persistent: true,
    // Match production PostgreSQL: UTF-8 everywhere. Without this, initdb on
    // Windows inherits the system code page (WIN1252) and non-Latin titles fail.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });

  if (!existsSync(path.join(databaseDir, "PG_VERSION"))) {
    console.log(`Initialising PostgreSQL data directory at ${databaseDir} ...`);
    await pg.initialise();
  }

  await pg.start();
  console.log(`PostgreSQL listening on localhost:${port}`);

  const client = pg.getPgClient();
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  if (exists.rowCount === 0) {
    await pg.createDatabase(database);
    console.log(`Created database "${database}"`);
  }
  await client.end();

  console.log(`DATABASE_URL=postgresql://${user}:${password}@localhost:${port}/${database}`);
  console.log("Press Ctrl+C to stop.");

  const shutdown = async () => {
    console.log("\nStopping PostgreSQL ...");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
