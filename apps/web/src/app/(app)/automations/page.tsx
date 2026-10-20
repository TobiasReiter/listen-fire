"use client";

// `/automations` — every saved movement script for the team, one row each.
// A script is an automation whether or not anything triggers it yet: what
// varies is what's listed under "Listens on" — a trigger, several, "On
// demand" for a manual-only script, or nothing at all for one that only
// runs when another script calls it. Clicking a row opens the saved script
// in the editor.

import Link from "next/link";
import { FileCode2, Plus } from "lucide-react";

import { trpc, type RouterOutputs } from "@/lib/trpc";
import { TAB_ORIGIN_ID } from "@/lib/tab-origin";
import { usePageTitle } from "@/components/page-title";
import { ValidityBadge } from "@/components/movements/movement-workbench";
import { LanguageVersionCell } from "@/components/movements/language-version";
import {
  Badge,
  ButtonLink,
  EmptyState,
  PageBody,
  PageHeader,
  PageIntro,
} from "@/components/ui";

type MovementListItem = RouterOutputs["views"]["movement"]["list"][number];
type MovementListener = MovementListItem["listeners"][number];
function formatRelativeTime(date: string | Date) {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}

function laneName(listener: MovementListener): string {
  return listener.movementName ?? listener.name;
}

function mostRecentRun(listeners: MovementListener[]): MovementListener["lastRun"] {
  return listeners.reduce<MovementListener["lastRun"]>((best, l) => {
    if (!l.lastRun) return best;
    if (!best) return l.lastRun;
    return new Date(l.lastRun.startedAt) > new Date(best.startedAt) ? l.lastRun : best;
  }, null);
}

// A paused or dry-run trigger is worth a subtle flag in the summary cell —
// the full per-trigger detail now lives on the movement's own page.
function listenerModeAnnotation(listeners: MovementListener[]): string | null {
  if (listeners.some((l) => l.runMode === "off")) return "paused";
  if (listeners.some((l) => l.runMode === "dry_run")) return "dry run";
  return null;
}

function NameCell({ movement }: { movement: MovementListItem }) {
  return (
    <td className="py-0 pr-4">
      <Link
        href={`/movements/${movement.id}`}
        className="block py-3 pl-4 font-medium text-gray-800"
      >
        {movement.name}
      </Link>
    </td>
  );
}

function MovementsTable({
  columns,
  children,
}: {
  columns: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50/50 text-[11px] uppercase tracking-wider text-gray-400">
            {columns.map((col, i) => (
              <th
                key={col}
                className={`py-2.5 pr-4 font-medium ${i === 0 ? "pl-4" : ""}`}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">{children}</tbody>
      </table>
    </div>
  );
}

function StatusCell({ movement }: { movement: MovementListItem }) {
  // A trigger-less script with no problems isn't "Live" (nothing runs it
  // on its own) — but it isn't broken either, so it reads as "Ready"
  // rather than borrowing the triggered rows' badge.
  const showValidity =
    movement.listeners.length > 0 ||
    movement.validityStatus === "invalid" ||
    movement.validityStatus === "unverified";
  return (
    <td className="py-3 pr-4">
      {showValidity ? (
        <ValidityBadge validityStatus={movement.validityStatus} />
      ) : (
        <Badge tone="gray">Ready</Badge>
      )}
    </td>
  );
}

function ListensOnCell({ movement }: { movement: MovementListItem }) {
  const { listeners } = movement;
  if (listeners.length === 0) {
    return (
      <td className="py-3 pr-4 text-gray-500">
        {movement.facets.runnableOnDemand ? "On demand" : "—"}
      </td>
    );
  }
  const names = listeners.map(laneName);
  const label =
    listeners.length === 1 ? names[0] : `${names[0]} +${listeners.length - 1} more`;
  const annotation = listenerModeAnnotation(listeners);
  return (
    <td
      className="py-3 pr-4 text-gray-500"
      title={listeners.length > 1 ? names.join(", ") : undefined}
    >
      {label}
      {annotation && <span className="ml-1.5 text-gray-400">· {annotation}</span>}
    </td>
  );
}

function AutomationsTable({ movements }: { movements: MovementListItem[] }) {
  return (
    <MovementsTable columns={["Name", "Status", "Listens on", "Version", "Last run"]}>
      {movements.map((m) => {
        const latest = mostRecentRun(m.listeners);
        return (
          <tr key={m.id} className="transition-colors hover:bg-gray-50">
            <NameCell movement={m} />
            <StatusCell movement={m} />
            <ListensOnCell movement={m} />
            <LanguageVersionCell
              languageVersion={m.languageVersion}
              upgradeDiagnostics={m.upgradeDiagnostics}
            />
            <td className="py-3 pr-4 text-gray-400">
              {latest ? formatRelativeTime(latest.startedAt) : "—"}
            </td>
          </tr>
        );
      })}
    </MovementsTable>
  );
}

export default function AutomationsPage() {
  usePageTitle("Automations — TARS");

  const { data: movements, isLoading } = trpc.views.movement.list.useQuery();

  // The assistant saved or deleted a movement — refresh the list so the
  // new/changed/removed automation appears without a manual reload.
  const utils = trpc.useUtils();
  trpc.views.knowledge.ontology.onResourceChange.useSubscription(
    { kinds: ["movement"] },
    {
      onData: (evt) => {
        if (evt.originId === TAB_ORIGIN_ID) return; // our own edit — already shown
        void utils.views.movement.list.invalidate();
      },
    },
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Automations"
        actions={
          <ButtonLink href="/movements/new" variant="primary">
            <Plus size={13} />
            New automation
          </ButtonLink>
        }
      />
      <PageBody>
        <PageIntro>
          Scripts that move data when something happens — they listen on a
          channel, react to events, and write the results wherever they belong.
        </PageIntro>

        <div className="space-y-10">
          {isLoading ? (
            <div className="text-[13px] text-gray-400">Loading…</div>
          ) : !movements || movements.length === 0 ? (
            <EmptyState
              icon={<FileCode2 size={22} />}
              title="No automations yet."
              caption="Write a script that reacts to new items from a source and writes the results wherever they belong."
              action={
                <ButtonLink href="/movements/new" variant="secondary">
                  Write your first automation
                </ButtonLink>
              }
            />
          ) : (
            <AutomationsTable movements={movements} />
          )}
        </div>
      </PageBody>
    </div>
  );
}
