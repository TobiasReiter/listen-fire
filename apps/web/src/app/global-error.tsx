'use client';

/**
 * Root-level error boundary. Renders when a route segment throws
 * during render and no nested `error.tsx` catches it. We must render
 * our own <html>/<body> here because we are above the root layout.
 *
 * Same calm chrome as the 404 — logo, plain-English headline, primary
 * CTA back to home plus a "Try again" affordance.
 */

import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
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

          <h1 className="text-[28px] font-medium text-gray-900">
            Something went wrong
          </h1>
          <p className="mt-3 max-w-md text-[14px] leading-relaxed text-gray-500">
            We hit an unexpected error loading this page. Try again, or head
            back home.
          </p>

          <div className="mt-8 flex items-center gap-3">
            <button
              onClick={() => reset()}
              className="inline-flex items-center justify-center rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] font-medium text-gray-700 shadow-sm transition hover:bg-gray-50"
            >
              Try again
            </button>
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-md bg-[#8778F7] px-4 py-2 text-[13px] font-medium text-white shadow-sm transition hover:bg-[#7868e8]"
            >
              Back to home
            </Link>
          </div>
        </div>
      </body>
    </html>
  );
}
