/**
 * Shell for the signed-out screens: a single centred card on the app
 * background. Deliberately self-contained — no shared UI kit yet.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-lg border border-card-border bg-card p-6 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Kiri</h1>
        </div>
        {children}
      </div>
    </main>
  );
}
