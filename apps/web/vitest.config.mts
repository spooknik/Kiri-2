import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    // Integration tests share one embedded database; run files one at a time.
    fileParallelism: false,
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,mts}"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    // Integration tests (tagged *.int.test.ts) get a database from the global
    // setup; unit tests never touch one.
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/lib/**"],
      exclude: ["src/generated/**"],
    },
  },
});
