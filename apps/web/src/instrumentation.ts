/**
 * Next.js instrumentation hook — the one place the server gets to run code at
 * boot. It runs for BOTH runtimes, so the Node-only work (retention sweeps,
 * the job runner, later the auto-sync scheduler) lives in
 * ./instrumentation-node.ts behind a runtime check. Next inlines
 * `process.env.NEXT_RUNTIME` per bundle, which lets the bundler drop the
 * import from the edge build instead of tracing Prisma and node:fs into it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    registerNode();
  }
}
