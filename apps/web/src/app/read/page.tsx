import { Suspense } from "react";
import { ReaderShell } from "@/components/reader/reader-shell";
import { Spinner } from "@/components/ui/spinner";

/**
 * `/read?series=&chapter=&page=`
 *
 * Prerendered on purpose. The route reads no cookies and no headers, so Next
 * can emit it as a static shell that the service worker precaches — which is
 * what makes opening a downloaded chapter work with no network at all. Every
 * byte of state comes from the query string, read client side inside
 * `ReaderShell` (hence the Suspense boundary around `useSearchParams`).
 *
 * Access control still applies: `src/proxy.ts` redirects to `/login` when there
 * is no session, and the chapter/page APIs re-check on every request.
 */
export const dynamic = "force-static";

export default function ReadPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full w-full items-center justify-center bg-black">
          <Spinner size="lg" label="Loading reader" />
        </div>
      }
    >
      <ReaderShell />
    </Suspense>
  );
}
