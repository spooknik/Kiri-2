/**
 * Retention sweep: purges only what is genuinely stale and never throws.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser, resetDatabase } from "../../test/factories";
import { InviteStatus } from "@/generated/prisma/client";
import { purgeOldNotifications } from "@/lib/notifications";
import { prisma } from "@/lib/prisma";
import { runRetention } from "@/lib/retention";
import { updateAppSettings } from "@/lib/settings";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function daysAhead(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

async function seedNotification(userId: string, title: string, createdAt: Date): Promise<void> {
  await prisma.notification.create({
    data: { userId, type: "SYNC_COMPLETED", title, message: title, createdAt },
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("purgeOldNotifications", () => {
  it("deletes only rows older than the cutoff", async () => {
    const user = await createTestUser();
    await seedNotification(user.id, "ancient", daysAgo(120));
    await seedNotification(user.id, "recent", daysAgo(2));

    expect(await purgeOldNotifications(90)).toBe(1);
    const left = await prisma.notification.findMany();
    expect(left.map((row) => row.title)).toEqual(["recent"]);
  });
});

describe("runRetention", () => {
  it("honours the configured notification retention window", async () => {
    const user = await createTestUser();
    await updateAppSettings({ notificationRetentionDays: 30 });
    await seedNotification(user.id, "too old", daysAgo(45));
    await seedNotification(user.id, "still fine", daysAgo(20));

    const result = await runRetention();

    expect(result.error).toBeNull();
    expect(result.notificationsPurged).toBe(1);
    expect(await prisma.notification.count()).toBe(1);
  });

  it("expires pending invites that are past their date and leaves the rest", async () => {
    const admin = await createTestUser({ role: "admin" });
    const rows = [
      { tokenHash: "hash-stale", status: InviteStatus.PENDING, expiresAt: daysAgo(1) },
      { tokenHash: "hash-live", status: InviteStatus.PENDING, expiresAt: daysAhead(5) },
      { tokenHash: "hash-used", status: InviteStatus.ACCEPTED, expiresAt: daysAgo(3) },
      { tokenHash: "hash-revoked", status: InviteStatus.REVOKED, expiresAt: daysAgo(3) },
    ];
    for (const row of rows) {
      await prisma.invite.create({ data: { ...row, createdById: admin.id } });
    }

    const result = await runRetention();

    expect(result.invitesExpired).toBe(1);
    const byHash = new Map(
      (await prisma.invite.findMany()).map((invite) => [invite.tokenHash, invite.status]),
    );
    expect(byHash.get("hash-stale")).toBe(InviteStatus.EXPIRED);
    expect(byHash.get("hash-live")).toBe(InviteStatus.PENDING);
    expect(byHash.get("hash-used")).toBe(InviteStatus.ACCEPTED);
    expect(byHash.get("hash-revoked")).toBe(InviteStatus.REVOKED);
  });

  it("drops expired sessions and verifications but keeps live ones", async () => {
    const user = await createTestUser();
    await prisma.session.createMany({
      data: [
        { userId: user.id, token: "stale-session", expiresAt: daysAgo(1) },
        { userId: user.id, token: "live-session", expiresAt: daysAhead(1) },
      ],
    });
    await prisma.verification.createMany({
      data: [
        { identifier: "stale", value: "x", expiresAt: daysAgo(1) },
        { identifier: "live", value: "y", expiresAt: daysAhead(1) },
      ],
    });

    const result = await runRetention();

    expect(result.sessionsDeleted).toBe(1);
    expect(result.verificationsDeleted).toBe(1);
    const sessions = await prisma.session.findMany();
    expect(sessions.map((row) => row.token)).toEqual(["live-session"]);
    const verifications = await prisma.verification.findMany();
    expect(verifications.map((row) => row.identifier)).toEqual(["live"]);
  });

  it("is a no-op on an empty instance and reports a duration", async () => {
    const result = await runRetention();

    expect(result).toMatchObject({
      notificationsPurged: 0,
      invitesExpired: 0,
      sessionsDeleted: 0,
      verificationsDeleted: 0,
      error: null,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
