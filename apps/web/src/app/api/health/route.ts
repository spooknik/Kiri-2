import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Liveness + readiness. Returns 503 when the database is unreachable so a
 * container healthcheck can flag the instance as unhealthy.
 */
export async function GET() {
  const startedAt = Date.now();
  let database: "ok" | "error" = "ok";
  let error: string | undefined;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    database = "error";
    error = err instanceof Error ? err.message : String(err);
  }

  const body = {
    status: database === "ok" ? "ok" : "degraded",
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
    database,
    latencyMs: Date.now() - startedAt,
    ...(error ? { error } : {}),
  };

  return NextResponse.json(body, {
    status: database === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
