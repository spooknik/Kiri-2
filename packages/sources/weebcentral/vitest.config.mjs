import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.mjs"],
    // Spawns the plugin as a real subprocess against a local fixture server;
    // give it room on a cold Windows filesystem (mirrors packages/source-sdk).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
