"use client";

/**
 * better-auth browser client. Safe to import from client components — it only
 * talks to `/api/auth/*` over fetch and never pulls in Prisma.
 *
 * The additional fields are declared explicitly rather than inferred from
 * `typeof auth` so the client build never has to reach into the server module's
 * (Prisma-heavy) type graph.
 */
import { createAuthClient } from "better-auth/react";
import { adminClient, inferAdditionalFields } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [
    adminClient(),
    inferAdditionalFields({
      user: {
        displayName: { type: "string", required: true, input: true },
        showAdult: { type: "boolean", required: false, input: false },
        showSpoilers: { type: "boolean", required: false, input: false },
        optimizerFormat: { type: "string", required: false, input: false },
        optimizerQuality: { type: "number", required: false, input: false },
        mustSetPassword: { type: "boolean", required: false, input: false },
      },
    }),
  ],
});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;
