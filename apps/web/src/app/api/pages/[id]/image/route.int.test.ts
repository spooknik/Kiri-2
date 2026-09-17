/**
 * GET /api/pages/:id/image — the Content-Type rules.
 *
 * `Page.mime` is copied from a plugin's manifest, so it is attacker-controlled
 * text on an authenticated same-origin URL: serving it back verbatim would let
 * a plugin store HTML (or an SVG) that runs as the reader. Only real image
 * types are served inline; everything else is a download, and `nosniff` is on
 * either way.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

// The route (and with it @/lib/api) must be imported before the mocked session
// module, or api.ts binds the real getCurrentUser.
import { GET as pageImageRoute } from "./route";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../../../../test/factories";
import type { SessionUser } from "@/lib/auth/types";
import { chapterDir, chapterFilePath, ensureDir } from "@/lib/content/store";
import { resetEnvCache } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { toSortTitle } from "@/lib/text";

const ORIGIN = "http://localhost:3000";
let dataRoot: string;

beforeAll(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "kiri-page-mime-"));
  process.env.DATA_ROOT = dataRoot;
  resetEnvCache();
});

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase();
});

/** A series with one chapter and one page file, whose `mime` we choose. */
async function seedPage(options: { file: string; mime: string | null }): Promise<{
  user: SessionUser;
  pageId: string;
}> {
  const user = await createTestUser();
  const series = await prisma.series.create({
    data: { title: "Pages", sortTitle: toSortTitle("Pages"), createdById: user.id },
    select: { id: true },
  });
  const chapter = await prisma.chapter.create({
    data: { seriesId: series.id, slug: "chapter-1", title: "Chapter 1", sortIndex: 0 },
    select: { id: true, slug: true },
  });
  await ensureDir(chapterDir(series.id, chapter.slug));
  await writeFile(chapterFilePath(series.id, chapter.slug, options.file), "page-bytes");
  const page = await prisma.page.create({
    data: { chapterId: chapter.id, index: 1, file: options.file, mime: options.mime },
    select: { id: true },
  });
  return { user, pageId: page.id };
}

async function get(user: SessionUser, pageId: string): Promise<Response> {
  mockCurrentUser(user);
  return pageImageRoute(
    new NextRequest(`${ORIGIN}/api/pages/${pageId}/image`),
    routeContext({ id: pageId }),
  );
}

describe("GET /api/pages/:id/image content type", () => {
  it("serves a real image type inline, with nosniff", async () => {
    const { user, pageId } = await seedPage({ file: "001.png", mime: "image/png" });
    const response = await get(user, pageId);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBeNull();
  });

  it("ignores a manifest that claims text/html and trusts the extension", async () => {
    const { user, pageId } = await seedPage({ file: "002.jpg", mime: "text/html; charset=utf-8" });
    const response = await get(user, pageId);

    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses to serve an SVG as one — it is a document, not a picture", async () => {
    const { user, pageId } = await seedPage({ file: "003.svg", mime: "image/svg+xml" });
    const response = await get(user, pageId);

    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment");
  });

  it("falls back to a download when neither the mime nor the extension is known", async () => {
    const { user, pageId } = await seedPage({ file: "004.bin", mime: null });
    const response = await get(user, pageId);

    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
