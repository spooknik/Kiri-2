import type { Metadata, Viewport } from "next";

/**
 * Fullscreen shell for the reader.
 *
 * Deliberately outside the `(app)` route group: no header, no bottom nav, no
 * page gutter — the reader is the whole viewport. `fixed inset-0` also pins the
 * document so the page itself never scrolls; the strip view scrolls inside it.
 */
export const metadata: Metadata = {
  title: "Reader",
};

export const viewport: Viewport = {
  themeColor: "#000000",
  viewportFit: "cover",
  // A reader is a fixed surface: the browser's own pinch-zoom would fight the
  // in-page zoom layer and strand the chrome off screen.
  maximumScale: 1,
  userScalable: false,
};

export default function ReadLayout({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 overflow-hidden bg-black text-white">{children}</div>;
}
