/**
 * Playwright global setup: embedded PostgreSQL + a production `next start` on
 * port 3100. The server process id is stored so global-teardown can stop it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { startTestDatabase } from "../test/embedded-db";

const STATE_FILE = path.resolve(__dirname, ".e2e-state.json");
const PORT = 3100;

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

export default async function globalSetup(): Promise<void> {
  const appDir = path.resolve(__dirname, "..");
  const db = await startTestDatabase({
    dataDir: path.resolve(appDir, ".pgdata-e2e"),
    port: Number(process.env.E2E_PGPORT ?? 54330),
    fresh: true,
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: db.url,
    APP_SECRET: process.env.APP_SECRET ?? "e2e-secret-e2e-secret-e2e-secret-e2e-secret",
    PUBLIC_URL: `http://localhost:${PORT}`,
    DATA_ROOT: path.resolve(appDir, ".data-e2e"),
    PORT: String(PORT),
  };

  const server: ChildProcess = spawn("npx", ["next", "start", "-p", String(PORT)], {
    cwd: appDir,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });

  writeFileSync(STATE_FILE, JSON.stringify({ serverPid: server.pid, databaseUrl: db.url }));
  // Keep the database handle alive for teardown via a global.
  (globalThis as unknown as { __e2eDb?: typeof db }).__e2eDb = db;

  await waitForServer(`http://localhost:${PORT}/api/health`, 60_000);
}
