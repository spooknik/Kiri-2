/**
 * MyAnimeList de-duplication.
 *
 * A self-hosted instance is shared, so "already in the library" means "already
 * there for someone whose series I can see" — a private copy owned by another
 * user must not block (or reveal itself to) me. Both helpers therefore AND in
 * `visibleSeriesWhere`.
 */
import type { SessionUser } from "@/lib/auth/types";
import { visibleSeriesWhere } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

/** Id of the oldest visible series carrying `malId`, or null. */
export async function findVisibleSeriesIdByMalId(
  user: SessionUser,
  malId: number,
  options: { excludeSeriesId?: string } = {},
): Promise<string | null> {
  const row = await prisma.series.findFirst({
    where: {
      malId,
      ...(options.excludeSeriesId ? { id: { not: options.excludeSeriesId } } : {}),
      AND: [visibleSeriesWhere(user)],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return row?.id ?? null;
}

/** One query for a whole search page: malId -> existing visible series id. */
export async function findVisibleSeriesIdsByMalIds(
  user: SessionUser,
  malIds: number[],
): Promise<Map<number, string>> {
  const unique = Array.from(new Set(malIds));
  if (unique.length === 0) return new Map();
  const rows = await prisma.series.findMany({
    where: { malId: { in: unique }, AND: [visibleSeriesWhere(user)] },
    select: { id: true, malId: true },
    orderBy: { createdAt: "asc" },
  });
  const found = new Map<number, string>();
  for (const row of rows) {
    if (row.malId !== null && !found.has(row.malId)) {
      found.set(row.malId, row.id);
    }
  }
  return found;
}
