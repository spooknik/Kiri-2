import { LibraryView } from "@/components/library/library-view";
import { requireUser } from "@/lib/auth/session";

/** The library dashboard — the app's home route. */
export default async function HomePage() {
  const user = await requireUser();

  return <LibraryView user={{ displayName: user.displayName, showAdult: user.showAdult }} />;
}
