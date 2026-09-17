import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { TestDatabase } from "../test/embedded-db";

const STATE_FILE = path.resolve(__dirname, ".e2e-state.json");

export default async function globalTeardown(): Promise<void> {
  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { serverPid?: number };
    if (state.serverPid) {
      try {
        if (process.platform === "win32") {
          const { execFileSync } = await import("node:child_process");
          execFileSync("taskkill", ["/pid", String(state.serverPid), "/T", "/F"], {
            stdio: "ignore",
          });
        } else {
          process.kill(-state.serverPid, "SIGTERM");
        }
      } catch {
        // already gone
      }
    }
    rmSync(STATE_FILE, { force: true });
  }

  const db = (globalThis as unknown as { __e2eDb?: TestDatabase }).__e2eDb;
  await db?.stop();
}
