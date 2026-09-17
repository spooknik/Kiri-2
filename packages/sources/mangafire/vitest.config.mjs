import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.mjs"],
    // The tests spawn the plugin as a subprocess against a local fixture
    // server, and the plugin deliberately rate-limits itself to ~2 req/s
    // (matching the real site's politeness budget), so a full sync can take
    // several seconds even against localhost.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
