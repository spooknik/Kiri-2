/**
 * Profile: the stats block on /profile and the PATCH that writes preferences,
 * including the better-auth `name` mirror.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUser, mockCurrentUser, resetDatabase, routeContext } from "../../test/factories";
import { GET as getRoute, PATCH as patchRoute } from "@/app/api/profile/route";
import type { ProfileView } from "@/lib/contracts/profile";
import { getProfile, updateProfile } from "@/lib/profile";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";

async function seedSeries(createdById: string, title: string): Promise<string> {
  const series = await prisma.series.create({
    data: { title, sortTitle: title.toLowerCase(), createdById },
  });
  return series.id;
}

function patchRequest(body: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}/api/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("getProfile", () => {
  it("zero-fills every reading status when the library is empty", async () => {
    const user = await createTestUser();

    const profile = await getProfile(user.id);

    expect(profile.stats).toEqual({
      tracked: 0,
      created: 0,
      byStatus: { READING: 0, COMPLETED: 0, ON_HOLD: 0, DROPPED: 0, PLAN_TO_READ: 0 },
    });
    expect(profile).toMatchObject({
      email: user.email,
      displayName: user.displayName,
      role: "member",
      optimizerFormat: "WEBP",
      optimizerQuality: 80,
      mustSetPassword: false,
    });
    expect(profile.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("counts my entries by status and the series I created", async () => {
    const user = await createTestUser();
    const other = await createTestUser();

    const mine = await seedSeries(user.id, "Mine");
    const alsoMine = await seedSeries(user.id, "Also Mine");
    const theirs = await seedSeries(other.id, "Theirs");

    await prisma.libraryEntry.createMany({
      data: [
        { userId: user.id, seriesId: mine, status: "READING" },
        { userId: user.id, seriesId: alsoMine, status: "READING" },
        { userId: user.id, seriesId: theirs, status: "COMPLETED" },
        // Another user's entry on my series must not count.
        { userId: other.id, seriesId: mine, status: "DROPPED" },
      ],
    });

    const profile = await getProfile(user.id);

    expect(profile.stats.tracked).toBe(3);
    expect(profile.stats.created).toBe(2);
    expect(profile.stats.byStatus).toEqual({
      READING: 2,
      COMPLETED: 1,
      ON_HOLD: 0,
      DROPPED: 0,
      PLAN_TO_READ: 0,
    });
  });

  it("404s for a user that no longer exists", async () => {
    await expect(getProfile("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("updateProfile", () => {
  it("mirrors displayName onto the better-auth name column", async () => {
    const user = await createTestUser({ displayName: "Old Name" });

    const updated = await updateProfile(user.id, { displayName: "New Name" });

    expect(updated.displayName).toBe("New Name");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.displayName).toBe("New Name");
    expect(row.name).toBe("New Name");
  });

  it("writes preference fields and leaves the rest alone", async () => {
    const user = await createTestUser({ displayName: "Keep Me" });

    const updated = await updateProfile(user.id, {
      showAdult: true,
      showSpoilers: true,
      optimizerQuality: 65,
      optimizerFormat: "WEBP",
    });

    expect(updated).toMatchObject({
      displayName: "Keep Me",
      showAdult: true,
      showSpoilers: true,
      optimizerQuality: 65,
    });
  });
});

describe("routes", () => {
  it("GET returns the profile of the signed-in user", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);

    const response = await getRoute(new NextRequest(`${ORIGIN}/api/profile`), routeContext({}));

    expect(response.status).toBe(200);
    const body = (await response.json()) as ProfileView;
    expect(body.id).toBe(user.id);
    expect(body.stats.byStatus.PLAN_TO_READ).toBe(0);
  });

  it("PATCH applies the update and returns the fresh view", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);

    const response = await patchRoute(
      patchRequest({ displayName: "  Renamed  ", showAdult: true }),
      routeContext({}),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ProfileView;
    // The schema trims before it reaches the database.
    expect(body.displayName).toBe("Renamed");
    expect(body.showAdult).toBe(true);
  });

  it("PATCH rejects an empty display name", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);

    const response = await patchRoute(patchRequest({ displayName: "   " }), routeContext({}));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("PATCH is 401 when signed out", async () => {
    mockCurrentUser(null);
    const response = await patchRoute(patchRequest({ showAdult: true }), routeContext({}));
    expect(response.status).toBe(401);
  });
});
