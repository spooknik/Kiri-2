/**
 * Unit test for POST /api/sync's per-op failure reporting. The reading and
 * notes modules are mocked, so no database is involved: what is under test is
 * which error text reaches the client.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { badRequest } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/types";
import { setChapterRead } from "@/lib/content/reading";
import { POST } from "./route";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

vi.mock("@/lib/content/reading", () => ({
  setChapterRead: vi.fn(),
  updatePosition: vi.fn(),
}));

vi.mock("@/lib/notes/sync", () => ({
  applyNoteSyncOp: vi.fn(async () => ({ ok: true })),
}));

const user: SessionUser = {
  id: "user-1",
  email: "member@example.com",
  displayName: "Member",
  role: "member",
  showAdult: false,
  showSpoilers: false,
  mustSetPassword: false,
};

const CHAPTER_ID = "11111111-1111-4111-8111-111111111111";

let opCounter = 0;

/** A fresh op id per call: the route de-duplicates ids it has already seen. */
function opId(): string {
  opCounter += 1;
  return `22222222-2222-4222-8222-${String(opCounter).padStart(12, "0")}`;
}

async function postChapterRead() {
  const response = await POST(
    new NextRequest("http://localhost:3000/api/sync", {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            type: "chapterRead",
            id: opId(),
            chapterId: CHAPTER_ID,
            read: true,
            at: new Date().toISOString(),
          },
        ],
      }),
    }),
    { params: Promise.resolve({}) },
  );
  const json = (await response.json()) as { results: { ok: boolean; error?: string }[] };
  return { status: response.status, result: json.results[0] };
}

beforeEach(() => {
  vi.mocked(getCurrentUser).mockResolvedValue(user);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/sync error reporting", () => {
  it("masks an unexpected op failure in production and logs the original", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(setChapterRead).mockRejectedValueOnce(
      new Error("connection string postgres://user:pw@db leaked"),
    );

    const { status, result } = await postChapterRead();

    expect(status).toBe(200);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("Operation failed");
    expect(result?.error).not.toContain("postgres://");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("failed"), expect.any(Error));
  });

  it("keeps the raw message outside production", async () => {
    vi.mocked(setChapterRead).mockRejectedValueOnce(new Error("boom in dev"));

    const { result } = await postChapterRead();

    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("boom in dev");
  });

  it("forwards an ApiError message even in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(setChapterRead).mockRejectedValueOnce(badRequest("That chapter is no longer yours"));

    const { result } = await postChapterRead();

    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("That chapter is no longer yours");
  });

  it("reports success when the op applies", async () => {
    // The mocked module resolves with undefined, which the route ignores.
    const { status, result } = await postChapterRead();

    expect(status).toBe(200);
    expect(result?.ok).toBe(true);
    expect(result?.error).toBeUndefined();
  });
});
