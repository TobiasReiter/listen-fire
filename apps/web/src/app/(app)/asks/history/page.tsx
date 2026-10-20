"use client";

// `/asks/history` — settled questions: answered or expired. Read-only; the
// live inbox (open questions, parked runs) lives at /asks.

import Link from "next/link";
import { ArrowLeft, History as HistoryIcon } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import { QuestionRow } from "@/components/asks/question-row";
import { EmptyState, PageBody, PageHeader, PageIntro } from "@/components/ui";

export default function AsksHistoryPage() {
  usePageTitle("History — TARS");

  const { data: questions, isLoading } =
    trpc.views.controlTower.listAskRecords.useQuery();

  const settledQuestions = (questions ?? []).filter((q) => q.state !== "open");

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="History"
        actions={
          <Link
            href="/asks"
            className="inline-flex items-center gap-1 text-[12px] text-gray-400 hover:text-gray-600"
          >
            <ArrowLeft size={12} /> Inbox
          </Link>
        }
      />
      <PageBody>
        <PageIntro>Questions that have already been answered or are no longer needed.</PageIntro>

        {isLoading ? (
          <div className="text-[13px] text-gray-400">Loading…</div>
        ) : settledQuestions.length === 0 ? (
          <EmptyState
            icon={<HistoryIcon size={22} />}
            title="No history yet."
            caption="Answered and expired questions will show up here."
          />
        ) : (
          <div className="space-y-3">
            {settledQuestions.map((q) => (
              <QuestionRow key={q.askId} q={q} busy={false} onAnswer={() => {}} />
            ))}
          </div>
        )}
      </PageBody>
    </div>
  );
}
