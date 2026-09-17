import type { Metadata, Viewport } from "next";
import "./globals.css";
import { OfflineBootstrap } from "@/components/offline/offline-bootstrap";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: {
    default: "Kiri",
    template: "%s · Kiri",
  },
  description: "Track manga, manhwa, and more with friends",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Kiri",
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#0f172a" },
  ],
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>
          {/* Registers the service worker, points reading-progress and note
              writes at the offline sync queue, and flushes that queue whenever
              the network is back. Mounted here (not in the `(app)` layout) so
              the reader and the offline hub get it too. */}
          <OfflineBootstrap />
          {children}
        </Providers>
      </body>
    </html>
  );
}
