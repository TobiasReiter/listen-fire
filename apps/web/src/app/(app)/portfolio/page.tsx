"use client";

/**
 * The holdings list — ported from apps/app's PortfolioList (V-20: rebuilt
 * thin on apps/web primitives, since the source page's value was its query
 * and columns, not its hand-rolled Chakra card list).
 */

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, Plus } from "lucide-react";

import { usePageTitle } from "@/components/page-title";
import { Button, EmptyState, PageBody, PageHeader } from "@/components/ui";
import { useDisclosure } from "@/components/portfolio";
import { trpc } from "@/lib/trpc";
import { AddInvestment } from "@/components/portfolio/company/add-investment";
import { FilterBar } from "@/components/portfolio/list/filter-bar";
import { ConfigPanel } from "@/components/portfolio/list/config-panel";
import { TotalsRow } from "@/components/portfolio/list/totals-row";
import { HoldingsTable } from "@/components/portfolio/list/holdings-table";
import { ExportMenu } from "@/components/portfolio/list/export-menu";
import { toApiFilter, toApiConfig } from "@/components/portfolio/list/api-params";
import { parsePortfolioQuery, serializePortfolioQuery } from "@/components/portfolio/list/query-state";
import type { PortfolioConfig, PortfolioFilter } from "@/components/portfolio/list/types";

export default function PortfolioPage() {
  usePageTitle("Portfolio — KIPP");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();
  const addInvestment = useDisclosure();

  const { filter, config } = useMemo(() => parsePortfolioQuery(searchParams), [searchParams]);

  const updateQuery = useCallback(
    (nextFilter: PortfolioFilter, nextConfig: PortfolioConfig) => {
      router.replace(
        `${pathname}?${serializePortfolioQuery(searchParams, nextFilter, nextConfig)}`,
        { scroll: false },
      );
    },
    [pathname, router, searchParams],
  );

  const setFilter = useCallback(
    (updater: (f: PortfolioFilter) => PortfolioFilter) => updateQuery(updater(filter), config),
    [filter, config, updateQuery],
  );
  const setConfig = useCallback(
    (updater: (c: PortfolioConfig) => PortfolioConfig) => updateQuery(filter, updater(config)),
    [filter, config, updateQuery],
  );

  // The list is one page: the API returns the whole portfolio, so there is
  // nothing to scroll for.
  const { data, isLoading } = trpc.views.investments.getPortfolioInvestments.useQuery({
    filter: toApiFilter(filter),
    config: toApiConfig(config),
    grouping: filter.grouping,
  });

  const investments = useMemo(() => data?.items ?? [], [data]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Portfolio"
        actions={
          <>
            <Link
              href="/portfolio/changelog"
              className="mr-1 text-[13px] text-gray-500 hover:text-gray-700"
            >
              Changelog
            </Link>
            <Button
              variant="secondary"
              onClick={() => setConfig((c) => ({ ...c, showTotals: !c.showTotals }))}
            >
              {config.showTotals ? <EyeOff size={13} /> : <Eye size={13} />}
              {config.showTotals ? "Hide totals" : "Show totals"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfig((c) => ({ ...c, showDetails: !c.showDetails }))}
            >
              {config.showDetails ? <EyeOff size={13} /> : <Eye size={13} />}
              {config.showDetails ? "Hide details" : "Show details"}
            </Button>
            <ExportMenu filter={filter} config={config} />
            <Button variant="primary" onClick={addInvestment.onOpen}>
              <Plus size={13} />
              Add investment
            </Button>
          </>
        }
      />
      <PageBody width="wide">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <FilterBar filter={filter} setFilter={setFilter} config={config} setConfig={setConfig} />
          <ConfigPanel filter={filter} setFilter={setFilter} config={config} setConfig={setConfig} />
        </div>

        {config.showTotals && <TotalsRow totals={data?.totals} />}

        {isLoading ? (
          <div className="py-20 text-center text-[13px] text-gray-400">Loading…</div>
        ) : investments.length === 0 ? (
          <EmptyState title="No investments found" />
        ) : (
          <HoldingsTable
            investments={investments}
            aggregation={config.aggregation}
            showDetails={config.showDetails}
            config={config}
          />
        )}
      </PageBody>

      <AddInvestment
        entity={null}
        isOpen={addInvestment.isOpen}
        onOpen={addInvestment.onOpen}
        onClose={() => {
          addInvestment.onClose();
          void utils.views.investments.getPortfolioInvestments.invalidate();
        }}
      />
    </div>
  );
}
