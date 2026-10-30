/**
 * App-wide 404 surface. Next.js renders this whenever a request hits a
 * route that doesn't resolve. We give it the same calm chrome as
 * /setup — centered logo, plain-English headline, single primary CTA
 * back to home — instead of the bare "404 / This page could not be
 * found." that App Router ships by default.
 *
 * Kept as a server component (no hooks, no client state) so it can
 * render even when the user has no session.
 */

import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-white px-6 py-12 text-center">
      <Link
        href="/"
        aria-label="KIPP home"
        className="mb-10 flex items-center gap-3 text-[#8778F7]"
      >
        <img src="/logo.svg" alt="" className="h-8 w-8" />
        <span className="text-[22px] font-medium tracking-[0.15em]">
          KIPP
        </span>
      </Link>

      <h1 className="text-[28px] font-medium text-gray-900">Page not found</h1>
      <p className="mt-3 max-w-md text-[14px] leading-relaxed text-gray-500">
        We couldn&apos;t find the page you were looking for. It may have moved,
        or the link might be out of date.
      </p>

      <Link
        href="/"
        className="mt-8 inline-flex items-center justify-center rounded-md bg-[#8778F7] px-4 py-2 text-[13px] font-medium text-white shadow-sm transition hover:bg-[#7868e8]"
      >
        Back to home
      </Link>
    </div>
  );
}
