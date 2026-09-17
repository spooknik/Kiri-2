/**
 * Series API integration tests: create, detail, update, delete, entries and
 * book-club enrollment, driven through the real route handlers.
 *
 * One file on purpose — every case truncates the shared test database, and
 * Vitest only runs *files* in parallel (cases inside a file are sequential).
 */
import path from "node:path";
import { rm, stat } from "node:fs/promises";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import { GET as getCoverRoute } from "@/app/api/series/[id]/cover/route";
import {
  DELETE as deleteEntryRoute,
  PUT as putEntryRoute,
} from "@/app/api/series/[id]/entry/route";
import {
  DELETE as deleteSeriesRoute,
  GET as getSeriesRoute,
  PATCH as patchSeriesRoute,
} from "@/app/api/series/[id]/route";
import { POST as createSeriesRoute } from "@/app/api/series/route";
import type { SessionUser } from "@/lib/auth/types";
import { coversDir } from "@/lib/content/store";
import type { LibraryEntryView, SeriesDetail } from "@/lib/contracts";
import { resetEnvCache } from "@/lib/env";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";
const DATA_ROOT = path.resolve(process.cwd(), "data", `test-series-api-${process.pid}`);

interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function request(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}${url}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function postSeries(body: Record<string, unknown>): Promise<Response> {
  return createSeriesRoute(request("/api/series", "POST", body), routeContext({}));
}

/** Create a series and assert it worked, returning the detail. */
async function seedSeries(body: Record<string, unknown>): Promise<SeriesDetail> {
  const response = await postSeries(body);
  expect(response.status).toBe(201);
  return readJson<SeriesDetail>(response);
}

function getSeries(id: string): Promise<Response> {
  return getSeriesRoute(request(`/api/series/${id}`, "GET"), routeContext({ id }));
}

function patchSeries(id: string, body: Record<string, unknown>): Promise<Response> {
  return patchSeriesRoute(request(`/api/series/${id}`, "PATCH", body), routeContext({ id }));
}

function deleteSeries(id: string): Promise<Response> {
  return deleteSeriesRoute(request(`/api/series/${id}`, "DELETE"), routeContext({ id }));
}

function putEntry(id: string, body: Record<string, unknown>): Promise<Response> {
  return putEntryRoute(request(`/api/series/${id}/entry`, "PUT", body), routeContext({ id }));
}

function deleteEntry(id: string): Promise<Response> {
  return deleteEntryRoute(request(`/api/series/${id}/entry`, "DELETE"), routeContext({ id }));
}

function getCover(id: string, headers?: Record<string, string>): Promise<Response> {
  return getCoverRoute(
    new NextRequest(`${ORIGIN}/api/series/${id}/cover`, { method: "GET", headers }),
    routeContext({ id }),
  );
}

/** Point global fetch at a real 40x60 PNG so sharp has something to convert. */
async function stubCoverDownload(): Promise<void> {
  const png = await sharp({
    create: { width: 40, height: 60, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(
      async () => new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } }),
    ),
  );
}

beforeAll(() => {
  process.env.DATA_ROOT = DATA_ROOT;
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(DATA_ROOT, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

describe("POST /api/series", () => {
  it("creates the series with the creator's entry, sort title and clean tags", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);

    const detail = await seedSeries({
      title: "The Apothecary Diaries",
      originalTitle: "  ",
      mediaType: "LIGHT_NOVEL",
      tags: [" Drama ", "drama", "Mystery", ""],
      status: "READING",
      currentChapter: 12.5,
    });

    expect(detail.title).toBe("The Apothecary Diaries");
    expect(detail.mediaType).toBe("LIGHT_NOVEL");
    expect(detail.tags).toEqual(["Drama", "Mystery"]);
    expect(detail.originalTitle).toBeNull();
    expect(detail.createdBy.id).toBe(user.id);
    expect(detail.canEdit).toBe(true);
    expect(detail.readerCount).toBe(1);
    expect(detail.entry).toMatchObject({ status: "READING", currentChapter: 12.5 });
    expect(detail.members).toHaveLength(1);
    expect(detail.members[0]?.user.id).toBe(user.id);

    const row = await prisma.series.findUniqueOrThrow({ where: { id: detail.id } });
    expect(row.sortTitle).toBe("apothecary diaries");
    expect(row.createdById).toBe(user.id);
  });

  it("stores malId in the column and in externalIds", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    const detail = await seedSeries({ title: "Death Note", malId: 21 });

    expect(detail.malId).toBe(21);
    expect(detail.externalIds).toEqual({ malId: 21 });
  });

  it("rejects a duplicate malId with 409 and the existing series id", async () => {
    const owner = await createTestUser();
    mockCurrentUser(owner);
    const first = await seedSeries({ title: "Death Note", malId: 21 });

    const other = await createTestUser();
    mockCurrentUser(other);
    const response = await postSeries({ title: "Death Note (again)", malId: 21 });

    expect(response.status).toBe(409);
    const body = await readJson<ApiErrorBody>(response);
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details).toEqual({ existingSeriesId: first.id });
  });

  it("does not let another user's private series block a create", async () => {
    const owner = await createTestUser();
    mockCurrentUser(owner);
    await seedSeries({ title: "Private copy", malId: 99, visibility: "PRIVATE" });

    const other = await createTestUser();
    mockCurrentUser(other);
    const detail = await seedSeries({ title: "Shared copy", malId: 99 });
    expect(detail.malId).toBe(99);
  });

  it("refuses a private book club pick", async () => {
    mockCurrentUser(await createTestUser({ role: "admin" }));
    const response = await postSeries({
      title: "Impossible",
      visibility: "PRIVATE",
      isBookClub: true,
    });

    expect(response.status).toBe(400);
    const body = await readJson<ApiErrorBody>(response);
    expect(body.error.message).toMatch(/private series cannot be a book club/i);
  });

  it("refuses a non-admin trying to create a book club series", async () => {
    mockCurrentUser(await createTestUser());
    const response = await postSeries({ title: "Not yours to pick", isBookClub: true });

    expect(response.status).toBe(403);
    const body = await readJson<ApiErrorBody>(response);
    expect(body.error.message).toMatch(/only admins/i);
    expect(await prisma.series.count()).toBe(0);
  });

  it("downloads and stores the cover, and serves it back as WebP", async () => {
    await stubCoverDownload();
    const user = await createTestUser();
    mockCurrentUser(user);

    const detail = await seedSeries({
      title: "Covered",
      coverUrl: "https://example.test/cover.png",
    });

    expect(detail.coverUrl).toBe(
      `/api/series/${detail.id}/cover?v=${Date.parse(detail.updatedAt)}`,
    );
    await expect(stat(path.join(coversDir(detail.id), "cover.webp"))).resolves.toBeDefined();

    const response = await getCover(detail.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=86400");
    const etag = response.headers.get("ETag");
    expect(etag).toBeTruthy();

    const notModified = await getCover(detail.id, { "if-none-match": etag ?? "" });
    expect(notModified.status).toBe(304);
  });

  it("keeps the series when the cover download fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("network down");
      }),
    );
    mockCurrentUser(await createTestUser());

    const detail = await seedSeries({ title: "No cover", coverUrl: "https://example.test/x.png" });
    expect(detail.coverUrl).toBeNull();
  });

  it("enrolls everyone when the series is created as a book club pick", async () => {
    const creator = await createTestUser({ role: "admin" });
    await createTestUser();
    await createTestUser();
    mockCurrentUser(creator);

    const detail = await seedSeries({ title: "Opening Pick", isBookClub: true });

    expect(detail.isBookClub).toBe(true);
    expect(await prisma.libraryEntry.count({ where: { seriesId: detail.id } })).toBe(3);
    expect(
      await prisma.notification.count({
        where: { seriesId: detail.id, type: "BOOK_CLUB_ADDED" },
      }),
    ).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Detail + authorization                                                     */
/* -------------------------------------------------------------------------- */

describe("GET /api/series/:id", () => {
  it("hides another user's private series as a 404", async () => {
    const owner = await createTestUser();
    mockCurrentUser(owner);
    const detail = await seedSeries({ title: "Secret", visibility: "PRIVATE" });

    mockCurrentUser(await createTestUser());
    expect((await getSeries(detail.id)).status).toBe(404);

    mockCurrentUser(owner);
    const own = await getSeries(detail.id);
    expect(own.status).toBe(200);
    // Members are only listed for shared series.
    expect((await readJson<SeriesDetail>(own)).members).toEqual([]);
  });

  it("hides an adult series behind the reader's own preference", async () => {
    const owner = await createTestUser();
    mockCurrentUser(owner);
    const detail = await seedSeries({ title: "Adults only", isAdult: true });

    mockCurrentUser(await createTestUser({ showAdult: false }));
    const hidden = await getSeries(detail.id);
    expect(hidden.status).toBe(403);

    mockCurrentUser(await createTestUser({ showAdult: true }));
    expect((await getSeries(detail.id)).status).toBe(200);
  });

  it("lists every member of a shared series, most recently active first", async () => {
    const owner = await createTestUser({ displayName: "Owner" });
    mockCurrentUser(owner);
    const detail = await seedSeries({ title: "Shared" });

    const reader = await createTestUser({ displayName: "Reader" });
    mockCurrentUser(reader);
    await putEntry(detail.id, { status: "READING", currentChapter: 4 });

    const response = await getSeries(detail.id);
    const body = await readJson<SeriesDetail>(response);
    expect(body.readerCount).toBe(2);
    expect(body.members.map((member) => member.user.displayName)).toEqual(["Reader", "Owner"]);
    expect(body.members[0]).toMatchObject({ status: "READING", currentChapter: 4 });
    expect(body.canEdit).toBe(false);
  });

  it("404s for an unknown id", async () => {
    mockCurrentUser(await createTestUser());
    const response = await getSeries("00000000-0000-4000-8000-000000000000");
    expect(response.status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* Update                                                                     */
/* -------------------------------------------------------------------------- */

describe("PATCH /api/series/:id", () => {
  let owner: SessionUser;
  let series: SeriesDetail;

  beforeEach(async () => {
    owner = await createTestUser();
    mockCurrentUser(owner);
    series = await seedSeries({ title: "Original", tags: ["one"] });
  });

  it("rejects a non-creator member with 403", async () => {
    mockCurrentUser(await createTestUser());
    const response = await patchSeries(series.id, { title: "Hijacked" });
    expect(response.status).toBe(403);
  });

  it("allows an admin who did not create the series", async () => {
    mockCurrentUser(await createTestUser({ role: "admin" }));
    const response = await patchSeries(series.id, { title: "Moderated" });
    expect(response.status).toBe(200);
    expect((await readJson<SeriesDetail>(response)).title).toBe("Moderated");
  });

  it("recomputes the sort title and normalises tags", async () => {
    const response = await patchSeries(series.id, {
      title: "A Silent Voice",
      tags: ["Drama", "drama", " Shounen "],
    });
    expect(response.status).toBe(200);
    const detail = await readJson<SeriesDetail>(response);
    expect(detail.tags).toEqual(["Drama", "Shounen"]);

    const row = await prisma.series.findUniqueOrThrow({ where: { id: series.id } });
    expect(row.sortTitle).toBe("silent voice");
  });

  it("refuses to make a book club pick private", async () => {
    mockCurrentUser(await createTestUser({ role: "admin" }));
    expect((await patchSeries(series.id, { isBookClub: true })).status).toBe(200);
    const response = await patchSeries(series.id, { visibility: "PRIVATE" });
    expect(response.status).toBe(400);
  });

  it("refuses a non-admin creator trying to turn book club on", async () => {
    // `owner` created `series` in beforeEach and can otherwise edit it freely.
    const response = await patchSeries(series.id, { isBookClub: true });
    expect(response.status).toBe(403);
    const body = await readJson<ApiErrorBody>(response);
    expect(body.error.message).toMatch(/only admins/i);
    expect((await prisma.series.findUniqueOrThrow({ where: { id: series.id } })).isBookClub).toBe(
      false,
    );
  });

  it("lets a non-admin creator turn book club back off", async () => {
    mockCurrentUser(await createTestUser({ role: "admin" }));
    expect((await patchSeries(series.id, { isBookClub: true })).status).toBe(200);

    mockCurrentUser(owner);
    const response = await patchSeries(series.id, { isBookClub: false });
    expect(response.status).toBe(200);
    expect((await prisma.series.findUniqueOrThrow({ where: { id: series.id } })).isBookClub).toBe(
      false,
    );
  });

  it("removes the stored cover on removeCover", async () => {
    await stubCoverDownload();
    const covered = await seedSeries({ title: "Cover me", coverUrl: "https://example.test/c.png" });
    expect(covered.coverUrl).not.toBeNull();

    const response = await patchSeries(covered.id, { removeCover: true });
    expect(response.status).toBe(200);
    expect((await readJson<SeriesDetail>(response)).coverUrl).toBeNull();
    await expect(stat(coversDir(covered.id))).rejects.toThrow();
  });

  it("enrolls every user once when the book club flag is turned on", async () => {
    const admin = await createTestUser({ role: "admin" });
    const member = await createTestUser();
    await createTestUser();

    // owner + admin + member + the extra user above.
    mockCurrentUser(admin);
    expect((await patchSeries(series.id, { isBookClub: true })).status).toBe(200);

    expect(await prisma.libraryEntry.count({ where: { seriesId: series.id } })).toBe(4);
    const entry = await prisma.libraryEntry.findUniqueOrThrow({
      where: { userId_seriesId: { userId: member.id, seriesId: series.id } },
    });
    expect(entry.status).toBe("PLAN_TO_READ");

    const notified = await prisma.notification.count({
      where: { seriesId: series.id, type: "BOOK_CLUB_ADDED" },
    });
    // Everyone but the actor.
    expect(notified).toBe(3);

    // A second run is a no-op: skipDuplicates + dedupeKey.
    expect((await patchSeries(series.id, { isBookClub: true })).status).toBe(200);
    expect(await prisma.libraryEntry.count({ where: { seriesId: series.id } })).toBe(4);
    expect(
      await prisma.notification.count({
        where: { seriesId: series.id, type: "BOOK_CLUB_ADDED" },
      }),
    ).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* Delete                                                                     */
/* -------------------------------------------------------------------------- */

describe("DELETE /api/series/:id", () => {
  it("deletes the row, its entries and the cover directory", async () => {
    await stubCoverDownload();
    const owner = await createTestUser();
    mockCurrentUser(owner);
    const detail = await seedSeries({ title: "Doomed", coverUrl: "https://example.test/c.png" });
    await expect(stat(coversDir(detail.id))).resolves.toBeDefined();

    const response = await deleteSeries(detail.id);
    expect(response.status).toBe(204);

    expect(await prisma.series.findUnique({ where: { id: detail.id } })).toBeNull();
    expect(await prisma.libraryEntry.count({ where: { seriesId: detail.id } })).toBe(0);
    await expect(stat(coversDir(detail.id))).rejects.toThrow();
  });

  it("refuses a non-creator", async () => {
    const owner = await createTestUser();
    mockCurrentUser(owner);
    const detail = await seedSeries({ title: "Kept" });

    mockCurrentUser(await createTestUser());
    expect((await deleteSeries(detail.id)).status).toBe(403);
    expect(await prisma.series.findUnique({ where: { id: detail.id } })).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Library entries                                                            */
/* -------------------------------------------------------------------------- */

describe("PUT/DELETE /api/series/:id/entry", () => {
  it("creates the entry on first write and patches it afterwards", async () => {
    const owner = await createTestUser();
    mockCurrentUser(owner);
    const detail = await seedSeries({ title: "Shared" });

    const reader = await createTestUser();
    mockCurrentUser(reader);

    const created = await putEntry(detail.id, { status: "READING", currentChapter: 3 });
    expect(created.status).toBe(200);
    expect(await readJson<LibraryEntryView>(created)).toMatchObject({
      status: "READING",
      currentChapter: 3,
      rating: null,
      notes: null,
      favorite: false,
    });

    const patched = await putEntry(detail.id, { favorite: true, rating: 9, notes: "  " });
    const entry = await readJson<LibraryEntryView>(patched);
    expect(entry).toMatchObject({
      status: "READING",
      currentChapter: 3,
      favorite: true,
      rating: 9,
      notes: null,
    });
  });

  it("removes only the caller's entry and leaves the series standing", async () => {
    const owner = await createTestUser();
    mockCurrentUser(owner);
    const detail = await seedSeries({ title: "Shared" });

    const reader = await createTestUser();
    mockCurrentUser(reader);
    await putEntry(detail.id, { status: "READING" });

    expect((await deleteEntry(detail.id)).status).toBe(204);
    expect(await prisma.libraryEntry.count({ where: { seriesId: detail.id } })).toBe(1);

    // The creator may untrack their own series; the series survives.
    mockCurrentUser(owner);
    expect((await deleteEntry(detail.id)).status).toBe(204);
    expect(await prisma.libraryEntry.count({ where: { seriesId: detail.id } })).toBe(0);
    expect(await prisma.series.findUnique({ where: { id: detail.id } })).not.toBeNull();

    const stillVisible = await getSeries(detail.id);
    expect(stillVisible.status).toBe(200);
    expect((await readJson<SeriesDetail>(stillVisible)).entry).toBeNull();
  });

  it("is idempotent when the entry does not exist", async () => {
    const owner = await createTestUser();
    mockCurrentUser(owner);
    const detail = await seedSeries({ title: "Shared" });

    mockCurrentUser(await createTestUser());
    expect((await deleteEntry(detail.id)).status).toBe(204);
  });

  it("refuses to track a series the user cannot see", async () => {
    const owner = await createTestUser();
    mockCurrentUser(owner);
    const detail = await seedSeries({ title: "Secret", visibility: "PRIVATE" });

    mockCurrentUser(await createTestUser());
    expect((await putEntry(detail.id, { status: "READING" })).status).toBe(404);
  });
});
