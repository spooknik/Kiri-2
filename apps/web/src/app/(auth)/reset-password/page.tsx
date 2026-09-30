import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Reset your password" };
export const dynamic = "force-dynamic";

/**
 * Landing page for a one-time reset link (src/lib/auth/password-reset.ts). The
 * token is only checked when the form is submitted — better-auth consumes it
 * then — so an expired or used link fails with a clear message at that point.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params["token"] === "string" ? params["token"] : "";

  return (
    <>
      {token ? (
        <>
          <p className="mb-4 text-sm text-secondary">
            Choose a new password. You&apos;ll be signed out on every device and can sign in again
            with it.
          </p>
          <ResetPasswordForm token={token} />
        </>
      ) : (
        <p className="rounded-md bg-danger-light px-3 py-2 text-sm text-danger" role="alert">
          This reset link is incomplete. Ask an admin for a new one.
        </p>
      )}
      <p className="mt-6 text-center text-sm text-secondary">
        <Link className="font-medium text-primary hover:underline" href="/login">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
