"use client";

// `/asks` — the inbox: the questions automations are waiting on a person to
// answer, and nothing else. Runs themselves — active, stalled, cancellable —
// live on /runs; a question here is the one thing only a human can do.
// Settled questions live at /asks/history. Copy is deliberately plain — no
// "interaction request" / "parked run" / "address".

import Link from "next/link";
import { Inbox } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import { QuestionRow } from "@/components/asks/question-row";
import { EmptyState, PageBody, PageHeader, PageIntro } from "@/components/ui";

export default function AsksPage() {
  usePageTitle("Inbox — TARS");

  const utils = trpc.useUtils();
  const { data: questions, isLoading } =
    trpc.views.controlTower.listAskRecords.useQuery();

  const answerQuestionMut = trpc.views.controlTower.answerAskRecord.useMutation({
    onSettled: () => void utils.views.controlTower.listAskRecords.invalidate(),
  });

  const openQuestions = (questions ?? []).filter((q) => q.state === "open");

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Inbox"
        actions={
          <Link href="/asks/history" className="text-[12px] text-gray-400 hover:text-gray-600">
            History
          </Link>
        }
      />
      <PageBody>
        <PageIntro>
          When an automation needs a person to decide something before it can
          continue, the question lands here.
        </PageIntro>

        {isLoading ? (
          <div className="text-[13px] text-gray-400">Loading…</div>
        ) : openQuestions.length === 0 ? (
          <EmptyState
            icon={<Inbox size={22} />}
            title="Nothing's waiting on you."
            caption="When an automation pauses to ask someone a question, it'll appear here until it's answered."
            action={
              <Link href="/asks/history" className="text-[12px] text-primary hover:underline">
                See past questions →
              </Link>
            }
          />
        ) : (
          <div className="space-y-3">
            {openQuestions.map((q) => (
              <QuestionRow
                key={q.askId}
                q={q}
                busy={answerQuestionMut.isLoading}
                onAnswer={(answer) =>
                  answerQuestionMut.mutate({ askId: q.askId, answer })
                }
              />
            ))}
          </div>
        )}
      </PageBody>
    </div>
  );
}
