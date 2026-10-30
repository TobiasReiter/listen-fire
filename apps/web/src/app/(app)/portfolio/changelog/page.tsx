"use client";

/**
 * Ported from apps/app's PortfolioList/Changelog/index.tsx — every recorded
 * change to a holding, filterable, exportable, linked from the holdings
 * list header.
 */

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";

import { usePageTitle } from "@/components/page-title";
import { Button, EmptyState, PageBody, PageHeader } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { ChangelogFilterBar, type ChangelogFilter } from "@/components/portfolio/list/changelog-filter-bar";
import { ChangelogTable } from "@/components/portfolio/list/changelog-table";
import { downloadCsv } from "@/components/portfolio/list/csv";

function encodeList(list: string[]): string {
  return list.map((v) => encodeURIComponent(v)).join(",");
}

function decodeList(str: string | null): string[] {
  if (!str) return [];
  return str.split(",").map((v) => decodeURIComponent(v));
}

function parseFilter(params: URLSearchParams): ChangelogFilter {
  return {
    companyName: params.get("company") || null,
    fundIds: decodeList(params.get("fundIds")),
    categories: decodeList(params.get("categories")),
    fromDate: params.get("fromDate") || null,
    toDate: params.get("toDate") || null,
  };
}

function serializeFilter(current: URLSearchParams, filter: ChangelogFilter): string {
  const params = new URLSearchParams(current);
  filter.companyName ? params.set("company", filter.companyName) : params.delete("company");
  filter.fundIds.length
    ? params.set("fundIds", encodeList(filter.fundIds))
    : params.delete("fundIds");
  filter.categories.length
    ? params.set("categories", encodeList(filter.categories))
    : params.delete("categories");
  filter.fromDate ? params.set("fromDate", filter.fromDate) : params.delete("fromDate");
  filter.toDate ? params.set("toDate", filter.toDate) : params.delete("toDate");
  return params.toString();
}

export default function ChangelogPage() {
  usePageTitle("Portfolio changelog — KIPP");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Filter state lives entirely in the URL (no local useState mirroring
  // it) — calling router.replace from inside a setState updater function
  // triggers React's "Cannot update a component while rendering a
  // different component" warning, since the updater runs during that
  // state's render phase.
  const filter = useMemo(() => parseFilter(searchParams), [searchParams]);

  const setFilter = useCallback(
    (updater: (f: ChangelogFilter) => ChangelogFilter) => {
      const next = updater(filter);
      router.replace(`${pathname}?${serializeFilter(searchParams, next)}`, { scroll: false });
    },
    [filter, pathname, router, searchParams],
  );

  const { data, isLoading } = trpc.views.portfolio.company.getChangelogList.useQuery({
    fromDate: filter.fromDate,
    toDate: filter.toDate,
    fundIds: filter.fundIds.length ? filter.fundIds : undefined,
    categories: filter.categories.length ? filter.categories : undefined,
    companyName: filter.companyName,
    limit: 500,
  });

  const { mutateAsync: getChangelogCSV, isLoading: exporting } =
    trpc.views.portfolio.company.getChangelogCSV.useMutation();

  async function handleExport() {
    const rows = await getChangelogCSV({
      fromDate: filter.fromDate,
      toDate: filter.toDate,
      fundIds: filter.fundIds.length ? filter.fundIds : undefined,
      categories: filter.categories.length ? filter.categories : undefined,
      companyName: filter.companyName,
    });
    downloadCsv(rows, `funding_changelog_${new Date().toISOString().slice(0, 10)}.csv`);
  }

  const items = data?.items ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Portfolio changelog"
        actions={
          <Button variant="secondary" onClick={() => void handleExport()} disabled={exporting}>
            <Download size={13} />
            Export CSV
          </Button>
        }
      />
      <PageBody width="wide">
        <Link
          href="/portfolio"
          className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft size={13} />
          Back to holdings
        </Link>

        <div className="mb-4">
          <ChangelogFilterBar filter={filter} setFilter={setFilter} />
        </div>

        {isLoading ? (
          <div className="py-20 text-center text-[13px] text-gray-400">Loading…</div>
        ) : items.length === 0 ? (
          <EmptyState title="No changelog entries found" />
        ) : (
          <ChangelogTable items={items} />
        )}
      </PageBody>
    </div>
  );
}
