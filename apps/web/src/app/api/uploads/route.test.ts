/**
 * POST /api/uploads — the per-user bucket in front of session creation. The
 * lifecycle itself is covered by src/lib/uploads/uploads.int.test.ts; this only
 * needs a directory, not a database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

// The route (and with it @/lib/api) must be imported before the mocked
// session module, or api.ts binds the real getCurrentUser.
import { POST as createUploadRoute } from "./route";
import type { SessionUser } from "@/lib/auth/types";
import type { UploadSessionView } from "@/lib/contracts/content";
import { resetEnvCache } from "@/lib/env";
import { resetRateLimits } from "@/lib/rate-limit";
import { deleteUploadSession } from "@/lib/uploads/sessions";
import * as session from "@/lib/auth/session";

const ORIGIN = "http://localhost:3000";
const USER: SessionUser = {
  id: "user-uploads",
  email: "uploads@example.com",
  displayName: "Uploader",
  role: "member",
  showAdult: false,
  showSpoilers: false,
  mustSetPassword: false,
};

let dataRoot: string;

beforeAll(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "kiri-upload-route-"));
  process.env.DATA_ROOT = dataRoot;
  resetEnvCache();
});

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

beforeEach(() => {
  resetRateLimits();
  vi.mocked(session.getCurrentUser).mockResolvedValue(USER);
});

function create(): Promise<Response> {
  return createUploadRoute(
    new NextRequest(`${ORIGIN}/api/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "chapter.cbz", size: 64 }),
    }),
    { params: Promise.resolve({}) },
  );
}

describe("POST /api/uploads", () => {
  it("answers 429 after twenty back-to-back sessions", async () => {
    // Each one is cancelled again so the per-user *quota* (a different limit,
    // covered in sessions.test.ts) never fires first.
    for (let index = 0; index < 20; index += 1) {
      const response = await create();
      expect(response.status).toBe(201);
      const view = (await response.json()) as UploadSessionView;
      await deleteUploadSession(USER.id, view.id);
    }

    const limited = await create();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
  });
});
