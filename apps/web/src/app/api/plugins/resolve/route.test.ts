/**
 * POST /api/plugins/resolve — the per-user bucket in front of the resolver.
 *
 * Resolution itself is mocked (it is covered in src/lib/plugins/resolve.test.ts
 * and the install integration suite); what matters here is that a member cannot
 * turn a form field into an unbounded stream of plugin subprocesses.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));
vi.mock("@/lib/plugins/resolve", () => ({ resolveSourceUrl: vi.fn() }));

// The route (and with it @/lib/api) must be imported before the mocked
// session module, or api.ts binds the real getCurrentUser.
import { POST as resolveRoute } from "./route";
import type { SessionUser } from "@/lib/auth/types";
import type { ResolveUrlResponse } from "@/lib/contracts/plugins";
import { resolveSourceUrl } from "@/lib/plugins/resolve";
import { resetRateLimits } from "@/lib/rate-limit";
import * as session from "@/lib/auth/session";

const ORIGIN = "http://localhost:3000";

const UNHANDLED: ResolveUrlResponse = {
  handled: false,
  pluginId: null,
  pluginName: null,
  normalizedUrl: null,
  slug: null,
  title: null,
  mediaType: null,
  coverUrl: null,
  needsCookie: false,
  existingSeriesId: null,
};

function member(id: string): SessionUser {
  return {
    id,
    email: `${id}@example.com`,
    displayName: id,
    role: "member",
    showAdult: false,
    showSpoilers: false,
    mustSetPassword: false,
  };
}

function post(url: string): Promise<Response> {
  return resolveRoute(
    new NextRequest(`${ORIGIN}/api/plugins/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
    { params: Promise.resolve({}) },
  );
}

beforeEach(() => {
  resetRateLimits();
  vi.mocked(resolveSourceUrl).mockReset();
  vi.mocked(resolveSourceUrl).mockResolvedValue(UNHANDLED);
});

describe("POST /api/plugins/resolve", () => {
  it("answers 429 once one user has spent their bucket", async () => {
    vi.mocked(session.getCurrentUser).mockResolvedValue(member("user-a"));

    for (let index = 0; index < 10; index += 1) {
      expect((await post(`https://site.test/manga/${index}`)).status).toBe(200);
    }

    const limited = await post("https://site.test/manga/11");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    // The eleventh call never reached the resolver.
    expect(resolveSourceUrl).toHaveBeenCalledTimes(10);
  });

  it("buckets per user, not per instance", async () => {
    vi.mocked(session.getCurrentUser).mockResolvedValue(member("user-a"));
    for (let index = 0; index < 10; index += 1) await post(`https://site.test/${index}`);
    expect((await post("https://site.test/x")).status).toBe(429);

    vi.mocked(session.getCurrentUser).mockResolvedValue(member("user-b"));
    expect((await post("https://site.test/x")).status).toBe(200);
  });

  it("refuses a non-http URL before any of that", async () => {
    vi.mocked(session.getCurrentUser).mockResolvedValue(member("user-c"));
    const response = await post("file:///etc/passwd");
    expect(response.status).toBe(400);
    expect(resolveSourceUrl).not.toHaveBeenCalled();
  });
});
