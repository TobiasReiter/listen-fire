import type { Metadata } from "next";
import { Suspense } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  // Canonical origin for resolving relative og:image / twitter:image URLs.
  // Without this Next.js falls back to http://localhost:${PORT} — which on
  // Render (PORT=10000) leaks `http://localhost:10000/og.png` into link previews.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: {
    default: "TARS",
    template: "%s — TARS",
  },
  description:
    "TARS — the automation layer over the tools you already use, run by your own Claude.",
  openGraph: {
    title: "TARS — the automation layer over the tools you already use, run by your own Claude",
    description:
      "TARS — the automation layer over the tools you already use, run by your own Claude.",
    type: "website",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "TARS — the automation layer over the tools you already use, run by your own Claude",
    description:
      "TARS — the automation layer over the tools you already use, run by your own Claude.",
    images: ["/og.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/logo.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-gray-50 text-gray-900 antialiased">
        <Suspense>
          <Providers>{children}</Providers>
        </Suspense>
      </body>
    </html>
  );
}
