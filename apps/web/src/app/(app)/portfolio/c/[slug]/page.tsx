"use client";

// `/portfolio/c/[slug]` — a single company's page. Port of apps/app's
// Portfolio/Profile (V-15): Header + Overview's investment block + Funding
// only. Team, Updates, Deals, Notes, Sources, Documents and Co-Investors
// (as a tab) are dealflow-shell surfaces that don't port — their routers
// are gone.

import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import { PageBody, PageHeader } from "@/components/ui";
import type { CurrencyIsoCode } from "#trpc";

import { CompanyHeader } from "@/components/portfolio/company/header";
import { Overview } from "@/components/portfolio/company/overview";
import { FundingSection } from "@/components/portfolio/company/funding";

const TABS = [
  { label: "Overview", value: "overview" },
  { label: "Funding", value: "funding" },
] as const;

export default function CompanyPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? "";
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const currency = (searchParams.get("currency") as CurrencyIsoCode) || undefined;
  const valuationDate = searchParams.get("valuationDate") || undefined;
  const tab = searchParams.get("tab") ?? "overview";

  const { data: company, isLoading } = trpc.views.portfolio.company.getOverview.useQuery(
    {
      slug,
      config:
        currency || valuationDate
          ? {
              currency,
              valuationDate: valuationDate
                ? new Date(valuationDate).toISOString()
                : undefined,
            }
          : undefined,
    },
    { enabled: slug !== "" },
  );

  usePageTitle(company ? `${company.name} — Portfolio — TARS` : "Portfolio — TARS");

  const updateTab = (value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", value);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-gray-400">
        <Loader2 size={15} className="mr-2 animate-spin" />
        Loading company…
      </div>
    );
  }

  if (!company) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-gray-500">
        <div>This company doesn&apos;t exist (it may have been removed).</div>
        <Link href="/portfolio" className="text-gray-700 underline">
          Back to portfolio
        </Link>
      </div>
    );
  }

  // `investments` is a raw JSONB_AGG in getOverview (no COALESCE), so
  // Postgres returns SQL NULL when the company has zero investments even
  // though the tRPC type says `{...}[]` — guard, don't trust the type.
  const showFunding = (company.investments?.length ?? 0) > 0;
  const activeTab = tab === "funding" && showFunding ? "funding" : "overview";

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={company.name ?? "Company"}
        actions={
          <Link
            href="/portfolio"
            className="inline-flex items-center gap-1 text-[12px] text-gray-400 hover:text-gray-600"
          >
            <ArrowLeft size={12} /> Portfolio
          </Link>
        }
      />
      <PageBody width="wide">
        <CompanyHeader company={company} />

        <nav className="mt-6 flex gap-4 border-b border-gray-100">
          {TABS.filter((t) => t.value !== "funding" || showFunding).map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => updateTab(t.value)}
              className={`shrink-0 whitespace-nowrap border-b-2 px-1 pb-2 text-[13px] font-medium transition-colors ${
                activeTab === t.value
                  ? "border-primary text-primary-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="mt-6">
          {activeTab === "funding" ? (
            <FundingSection company={company} />
          ) : (
            <Overview company={company} />
          )}
        </div>
      </PageBody>
    </div>
  );
}
