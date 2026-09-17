/**
 * GET /api/search/mal integration test: auth, the sfw flag derived from the
 * reader's profile, and the `existingSeriesId` annotation that stops the add
 * form creating a duplicate. Jikan itself is mocked.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../../../test/factories";
import type { MalSearchResponse } from "@/lib/contracts";
import { resetJikanCache } from "@/lib/jikan";
import { prisma } from "@/lib/prisma";
import { resetRateLimits } from "@/lib/rate-limit";
import { toSortTitle } from "@/lib/text";
import { GET as malSearchRoute } from "./route";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";

const ITEM = {
  mal_id: 21,
  url: "https://myanimelist.net/manga/21",
  title: "Death Note",
  type: "Manga",
  images: { webp: { large_image_url: "https://cdn/dn.webp" } },
  genres: [{ name: "Mystery" }],
};

function stubJikan(items: unknown[] = [ITEM]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ data: items }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function search(query: string): Promise<Response> {
  return malSearchRoute(new NextRequest(`${ORIGIN}/api/search/mal?${query}`), routeContext({}));
}

beforeEach(async () => {
  await resetDatabase();
  resetJikanCache();
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/search/mal", () => {
  it("returns 401 when signed out", async () => {
    mockCurrentUser(null);
    expect((await search("q=death")).status).toBe(401);
  });

  it("validates the query string", async () => {
    mockCurrentUser(await createTestUser());
    expect((await search("q=a")).status).toBe(400);
  });

  it("maps results and marks the ones already in the library", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    const existing = await prisma.series.create({
      data: {
        title: "Death Note",
        sortTitle: toSortTitle("Death Note"),
        malId: 21,
        createdById: user.id,
      },
      select: { id: true },
    });
    stubJikan();

    const response = await search("q=death%20note&limit=5");
    expect(response.status).toBe(200);
    const body = (await response.json()) as MalSearchResponse;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      malId: 21,
      title: "Death Note",
      mediaType: "MANGA",
      coverUrl: "https://cdn/dn.webp",
      tags: ["Mystery"],
      existingSeriesId: existing.id,
    });
  });

  it("leaves existingSeriesId null when only someone else has it privately", async () => {
    const owner = await createTestUser();
    await prisma.series.create({
      data: {
        title: "Death Note",
        sortTitle: toSortTitle("Death Note"),
        malId: 21,
        visibility: "PRIVATE",
        createdById: owner.id,
      },
    });
    mockCurrentUser(await createTestUser());
    stubJikan();

    const body = (await (await search("q=death%20note")).json()) as MalSearchResponse;
    expect(body.results[0]?.existingSeriesId).toBeNull();
  });

  it("asks Jikan for safe-for-work results unless the reader opted in", async () => {
    mockCurrentUser(await createTestUser({ showAdult: false }));
    const safe = stubJikan();
    await search("q=death%20note");
    expect(new URL(String(safe.mock.calls[0]?.[0])).searchParams.get("sfw")).toBe("true");

    vi.unstubAllGlobals();
    resetJikanCache();
    mockCurrentUser(await createTestUser({ showAdult: true }));
    const unrestricted = stubJikan();
    await search("q=death%20note");
    expect(new URL(String(unrestricted.mock.calls[0]?.[0])).searchParams.has("sfw")).toBe(false);
  });

  it("gives each reader their own bucket before the shared one", async () => {
    mockCurrentUser(await createTestUser());
    stubJikan();

    // One query, so Jikan is called once and every later call is a cache hit:
    // what runs out here is this user's allowance, not the instance's.
    for (let index = 0; index < 5; index += 1) {
      expect((await search("q=death%20note")).status).toBe(200);
    }
    expect((await search("q=death%20note")).status).toBe(429);

    // Someone else can still search.
    mockCurrentUser(await createTestUser());
    expect((await search("q=death%20note")).status).toBe(200);
  });

  it("answers 429 once the outbound bucket is empty", async () => {
    mockCurrentUser(await createTestUser());
    stubJikan();

    for (const term of ["one", "two", "three"]) {
      expect((await search(`q=${term}`)).status).toBe(200);
    }
    const limited = await search("q=four");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });
});
