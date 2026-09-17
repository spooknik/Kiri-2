import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The end-to-end tests spawn the template plugin against a fixture server;
    // give them room on a cold Windows filesystem.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
