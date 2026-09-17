import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  return { ...actual, getCurrentUser: vi.fn(async () => null) };
});

describe("GET /api/version", () => {
  it("is public and reports the protocol version", async () => {
    const res = await GET(new NextRequest("http://localhost:3000/api/version"), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; protocolVersion: number };
    expect(body.protocolVersion).toBe(1);
    expect(typeof body.version).toBe("string");
  });
});
