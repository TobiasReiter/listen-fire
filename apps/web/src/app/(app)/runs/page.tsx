"use client";

// `/runs` — every automation run that's currently live or paused, in one
// place, with the two things an operator can do about it:
//
//   - cancel it     (stops the run; keeps everything it already did)
//   - resume it     (only offered when the pause is one the operator can
//                     clear themselves — e.g. it's over its cost limit)
//
// Copy is deliberately plain — no "parked" / "TG" / "cost_exhausted".

import Link from "next/link";
import { Activity, Play, X } from "lucide-react";

import { trpc, type RouterOutputs } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import {
  Badge,
  EmptyState,
  PageBody,
  PageHeader,
  PageIntro,
  SectionHeader,
} from "@/components/ui";

type Run = RouterOutputs["views"]["controlTower"]["listRuns"][number];

function sinceLabel(date: string | Date): string {
  const d = new Date(date);
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const WAITING_ON_LABEL: Record<NonNullable<Run["waitingOn"]>, string> = {
  limit: "reached its cost limit",
  ask: "waiting for an answer",
  timer: "waiting (scheduled pause)",
};

function WaitingOnLabel({ run }: { run: Run }) {
  if (!run.waitingOn) return null;
  if (run.waitingOn === "ask") {
    return (
      <Link href="/asks" className="text-primary hover:underline">
        {WAITING_ON_LABEL.ask}
      </Link>
    );
  }
  return <>{WAITING_ON_LABEL[run.waitingOn]}</>;
}

function RunningRow({
  run,
  onCancel,
  busy,
}: {
  run: Run;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 p-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium text-gray-900">
            {run.automationName}
          </span>
          <Badge tone="emerald">Running</Badge>
        </div>
        <div className="mt-0.5 text-[12px] text-gray-400">
          started {sinceLabel(run.startedAt)}
        </div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy || run.cancelRequested}
        title="Stop this run and keep everything it already did"
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
      >
        <X size={12} /> {run.cancelRequested ? "Stopping…" : "Cancel"}
      </button>
    </div>
  );
}

function ParkedRow({
  run,
  onCancel,
  onResume,
  busy,
}: {
  run: Run;
  onCancel: () => void;
  onResume: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 p-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium text-gray-900">
            {run.automationName}
          </span>
          <Badge tone="amber">Paused</Badge>
        </div>
        <div className="mt-0.5 text-[12px] text-gray-400">
          {run.waitingOn && (
            <>
              <WaitingOnLabel run={run} /> ·{" "}
            </>
          )}
          started {sinceLabel(run.startedAt)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {run.waitingOn === "limit" && (
          <button
            type="button"
            onClick={onResume}
            disabled={busy || run.cancelRequested}
            title="Carry on from where it stopped. Its cost limit applies afresh."
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-primary transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            <Play size={12} /> Resume
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={busy || run.cancelRequested}
          title="Stop this run and keep everything it already did"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
        >
          <X size={12} /> {run.cancelRequested ? "Stopping…" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

export default function RunsPage() {
  usePageTitle("Runs — KIPP");

  const utils = trpc.useUtils();

  const shouldPoll = (runs: Run[] | undefined) =>
    (runs ?? []).some((run) => run.status === "running" || run.cancelRequested);

  const { data: runs, isLoading } = trpc.views.controlTower.listRuns.useQuery(
    undefined,
    {
      refetchInterval: (data) => (shouldPoll(data) ? 5000 : false),
    }
  );

  const refresh = () => {
    void utils.views.controlTower.listRuns.invalidate();
  };

  const cancelMut = trpc.views.controlTower.abortRun.useMutation({
    onSettled: refresh,
  });
  const resumeMut = trpc.views.controlTower.resumeRun.useMutation({
    onSettled: refresh,
  });
  const busy = cancelMut.isLoading || resumeMut.isLoading;

  const running = (runs ?? []).filter((run) => run.status === "running");
  const parked = (runs ?? []).filter((run) => run.status === "parked");
  const hasWork = running.length > 0 || parked.length > 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Runs" />
      <PageBody>
        <PageIntro>
          Every automation that's currently running or paused shows up here.
          Stopping a run keeps everything it already did — it just won't do
          anything more.
        </PageIntro>

        {isLoading ? (
          <div className="text-[13px] text-gray-400">Loading…</div>
        ) : !hasWork ? (
          <EmptyState
            icon={<Activity size={22} />}
            title="Nothing's running right now."
            caption="When an automation starts a run, it'll appear here until it finishes, pauses, or is stopped."
          />
        ) : (
          <div className="space-y-8">
            {running.length > 0 && (
              <section>
                <SectionHeader
                  title="Running now"
                  subtitle="automations actively doing work"
                />
                <div className="space-y-3">
                  {running.map((run) => (
                    <RunningRow
                      key={run.runId}
                      run={run}
                      busy={busy}
                      onCancel={() => cancelMut.mutate({ runId: run.runId })}
                    />
                  ))}
                </div>
              </section>
            )}

            {parked.length > 0 && (
              <section>
                <SectionHeader
                  title="Paused"
                  subtitle="automations that stopped short of finishing"
                />
                <div className="space-y-3">
                  {parked.map((run) => (
                    <ParkedRow
                      key={run.runId}
                      run={run}
                      busy={busy}
                      onCancel={() => cancelMut.mutate({ runId: run.runId })}
                      onResume={() => resumeMut.mutate({ runId: run.runId })}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </PageBody>
    </div>
  );
}
