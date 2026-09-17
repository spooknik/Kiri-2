import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.mjs"],
    // Several tests spawn the plugin as a subprocess (sometimes more than
    // once); give them room on a cold Windows filesystem.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
