/**
 * Storage of password-reset tokens, shared by the better-auth config
 * (src/lib/auth/server.ts) and the link minting in ./password-reset.ts.
 * Dependency-free so the auth config can import it without a cycle.
 */
import { createHash } from "node:crypto";

/** better-auth's verification identifier prefix for reset tokens. */
export const RESET_PASSWORD_PREFIX = "reset-password:";

/**
 * Storage hash for reset-token identifiers (better-auth's
 * `verification.storeIdentifier` override). Keeps the prefix readable so a
 * user's outstanding links can be found and replaced; the token is hashed, so
 * a database dump cannot be turned into working links.
 */
export async function hashResetIdentifier(identifier: string): Promise<string> {
  const digest = createHash("sha256").update(identifier).digest("base64url");
  return `${RESET_PASSWORD_PREFIX}sha256:${digest}`;
}
