"use client";

/**
 * `/data` — user-vocabulary view of records (one row per entity type
 * with counts). U5b owns the real content; U2 ships a route shell so
 * the new sidebar link resolves and we don't 404 in between waves.
 *
 */

import Link from "next/link";

import { usePageTitle } from "@/components/page-title";

export default function DataPage() {
  usePageTitle("Data — KIPP");

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 px-5">
        <h1 className="text-base font-semibold text-gray-900">Data</h1>
      </div>

      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="max-w-md text-center">
          <h2 className="text-[15px] font-medium text-gray-900">
            Your records, by type
          </h2>
          <p className="mt-3 text-[13px] leading-relaxed text-gray-500">
            Companies, people, deals, and anything else captured from your
            inbox or imports will show up here. This view is being built.
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <Link
              href="/model"
              className="inline-flex items-center justify-center rounded-md border border-gray-200 px-4 py-2 text-[13px] font-medium text-gray-700 transition hover:bg-gray-50"
            >
              View as graph
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
