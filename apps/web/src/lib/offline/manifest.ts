/**
 * Server-side builder for `GET /api/series/:id/offline-manifest`.
 *
 * Server-only (it imports Prisma and the authorization rules); the browser half
 * of `src/lib/offline` never imports this file.
 *
 * The manifest is the download plan: every COMPLETED chapter that actually has
 * pages, each page's stable `/api/pages/:id/image` URL, its byte size (for the
 * quota check and the progress bar) and its real dimensions (so the offline
 * reader lays out without shift, exactly like the online one). Chapters that
 * are still downloading, failed or vanished from their source are excluded —
 * there is nothing to put in a cache for them.
 */
import type { Prisma } from "@/generated/prisma/client";
import { notFound } from "@/lib/api";
import type { SessionUser } from "@/lib/auth/types";
import { assertCanViewSeries } from "@/lib/authz";
import type { OfflineManifest } from "@/lib/contracts/offline";
import { coverUrlFor } from "@/lib/cover-storage";
import { prisma } from "@/lib/prisma";

const SERIES_SELECT = {
  id: true,
  title: true,
  mediaType: true,
  coverFile: true,
  updatedAt: true,
  visibility: true,
  isAdult: true,
  createdById: true,
} satisfies Prisma.SeriesSelect;

export async function buildOfflineManifest(
  user: SessionUser,
  seriesId: string,
): Promise<OfflineManifest> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: SERIES_SELECT,
  });
  if (!series) throw notFound("Series");
  assertCanViewSeries(user, series);

  const rows = await prisma.chapter.findMany({
    where: { seriesId, status: "COMPLETED", pageCount: { gt: 0 } },
    orderBy: { sortIndex: "asc" },
    select: {
      id: true,
      slug: true,
      title: true,
      number: true,
      sortIndex: true,
      pageCount: true,
      bytes: true,
      pages: {
        orderBy: { index: "asc" },
        select: { id: true, index: true, width: true, height: true, bytes: true },
      },
    },
  });

  const chapters = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    number: row.number,
    sortIndex: row.sortIndex,
    pageCount: row.pageCount,
    // Summed from the page rows rather than read off `Chapter.bytes` (a BigInt
    // column): an optimisation pass rewrites page sizes, and the denormalised
    // chapter total can lag behind. The downloader's progress bar and the quota
    // check both count these same bytes.
    bytes: row.pages.reduce((sum, page) => sum + page.bytes, 0),
    pages: row.pages.map((page) => ({
      id: page.id,
      index: page.index,
      // Identical to `toPageView`: immutable for the life of the page row,
      // which is what lets the service worker cache it CacheFirst.
      url: `/api/pages/${page.id}/image`,
      width: page.width,
      height: page.height,
      bytes: page.bytes,
    })),
  }));

  return {
    series: {
      id: series.id,
      title: series.title,
      mediaType: series.mediaType,
      coverUrl: coverUrlFor(series),
    },
    generatedAt: new Date().toISOString(),
    chapters,
    totalBytes: chapters.reduce((total, chapter) => total + chapter.bytes, 0),
  };
}
