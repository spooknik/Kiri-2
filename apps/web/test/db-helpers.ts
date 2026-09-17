/**
 * Helpers for integration tests (`*.int.test.ts`). The database comes from
 * test/global-setup.ts; these just reset it between cases.
 */
import { prisma } from "@/lib/prisma";

/** Wipe everything the auth stack touches so each test starts from zero users. */
export async function truncateAuthTables(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "session", "account", "verification", "invite", "audit_log", "user" RESTART IDENTITY CASCADE`,
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "app_setting"`);
}

/** Turn a response's Set-Cookie headers into a Cookie request header. */
export function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .filter(Boolean)
    .join("; ");
}
