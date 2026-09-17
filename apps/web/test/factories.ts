/**
 * Test data factories for DB-backed tests (*.int.test.ts). They write straight
 * through Prisma to the embedded test database; combine with
 * `mockCurrentUser` to exercise route handlers as a given user.
 *
 * Usage in a test file:
 *   vi.mock("@/lib/auth/session", async (importOriginal) => ({
 *     ...(await importOriginal<typeof import("@/lib/auth/session")>()),
 *     getCurrentUser: vi.fn(),
 *   }));
 *   const user = await createTestUser();
 *   mockCurrentUser(user);
 */
import { vi } from "vitest";
import { prisma } from "@/lib/prisma";
import * as session from "@/lib/auth/session";
import type { SessionUser } from "@/lib/auth/types";

let counter = 0;

export interface CreateTestUserOptions {
  email?: string;
  displayName?: string;
  role?: "admin" | "member";
  showAdult?: boolean;
  showSpoilers?: boolean;
}

export async function createTestUser(options: CreateTestUserOptions = {}): Promise<SessionUser> {
  counter += 1;
  const email = options.email ?? `user${counter}-${Date.now()}@example.com`;
  const displayName = options.displayName ?? `User ${counter}`;
  const row = await prisma.user.create({
    data: {
      email,
      name: displayName,
      displayName,
      role: options.role ?? "member",
      showAdult: options.showAdult ?? false,
      showSpoilers: options.showSpoilers ?? false,
      emailVerified: true,
    },
  });
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role === "admin" ? "admin" : "member",
    showAdult: row.showAdult,
    showSpoilers: row.showSpoilers,
    mustSetPassword: row.mustSetPassword,
  };
}

/** Point the mocked getCurrentUser at `user` (or null for signed-out). */
export function mockCurrentUser(user: SessionUser | null): void {
  vi.mocked(session.getCurrentUser).mockResolvedValue(user);
}

/** Truncate every application table (auth tables included). */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "import_mapping", "audit_log", "notification", "plugin_credential", "job",
      "note", "reading_position", "chapter_read", "page", "chapter", "source",
      "plugin", "library_entry", "series", "invite", "verification", "account",
      "session", "user", "app_setting"
    RESTART IDENTITY CASCADE
  `);
}

/** Build a Next.js-style route context from params. */
export function routeContext(params: Record<string, string>): {
  params: Promise<Record<string, string>>;
} {
  return { params: Promise.resolve(params) };
}
