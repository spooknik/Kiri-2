/**
 * Shape of the signed-in user as seen by API routes and server components.
 * Produced by src/lib/auth/session.ts; consumed by src/lib/api.ts and
 * src/lib/authz.ts. Keep this small: it is read on every request.
 */
export type UserRole = "admin" | "member";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  showAdult: boolean;
  showSpoilers: boolean;
  mustSetPassword: boolean;
}

export function isAdmin(user: Pick<SessionUser, "role"> | null | undefined): boolean {
  return user?.role === "admin";
}
