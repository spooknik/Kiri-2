/**
 * Book-club enrollment, in one place.
 *
 * V1 only enrolled users when an *existing* series was flipped to book club
 * (`src/app/api/series/[id]/route.ts:513`), so a series created with the flag
 * already set enrolled nobody. Here both paths — create and update — call
 * {@link enrollAllUsers}, and it is idempotent: `skipDuplicates` for the
 * entries, `dedupeKey` for the notifications.
 */
import { truncate } from "@/lib/text";
import { createNotifications } from "@/lib/notifications";
import { prisma } from "@/lib/prisma";

export interface EnrollResult {
  /** Library entries actually created (existing trackers are untouched). */
  enrolled: number;
  /** Notifications actually inserted (repeat runs collapse to zero). */
  notified: number;
}

export interface EnrollOptions {
  /**
   * The user who turned the flag on. They already know, so they are enrolled
   * but not notified.
   */
  actorId?: string;
}

/** Stable per-series key so a re-run never notifies the same user twice. */
export function bookClubDedupeKey(seriesId: string): string {
  return `book-club:${seriesId}`;
}

/**
 * Give every non-banned user a `PLAN_TO_READ` entry for `seriesId` and tell
 * them about it. Users who already track the series keep their status.
 */
export async function enrollAllUsers(
  seriesId: string,
  options: EnrollOptions = {},
): Promise<EnrollResult> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: { id: true, title: true },
  });
  if (!series) return { enrolled: 0, notified: 0 };

  const users = await prisma.user.findMany({
    where: { banned: false },
    select: { id: true },
  });
  if (users.length === 0) return { enrolled: 0, notified: 0 };

  const created = await prisma.libraryEntry.createMany({
    data: users.map((user) => ({ userId: user.id, seriesId, status: "PLAN_TO_READ" as const })),
    skipDuplicates: true,
  });

  const recipients = users.map((user) => user.id).filter((userId) => userId !== options.actorId);

  const notified = await createNotifications({
    userIds: recipients,
    type: "BOOK_CLUB_ADDED",
    title: "New book club pick",
    message: `${truncate(series.title, 120)} was added to the book club.`,
    link: `/series/${seriesId}`,
    seriesId,
    dedupeKey: bookClubDedupeKey(seriesId),
  });

  return { enrolled: created.count, notified };
}
