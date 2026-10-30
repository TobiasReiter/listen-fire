"use client";

// `/movements/[id]` — re-open a saved movement. The editor loads the
// SAVED SCRIPT (the script is the movement — everything else is compiled
// from it), so what you wrote is exactly what you get back.

import Link from "next/link";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import { MovementWorkbench } from "@/components/movements/movement-workbench";

export default function MovementPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const { data: movement, isLoading } = trpc.views.movement.get.useQuery(
    { id },
    { enabled: id !== "", refetchOnWindowFocus: false },
  );
  usePageTitle(
    movement ? `${movement.name} — Movements — KIPP` : "Movements — KIPP",
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-gray-400">
        <Loader2 size={15} className="mr-2 animate-spin" />
        Loading movement…
      </div>
    );
  }

  if (!movement) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-gray-500">
        <div>This movement doesn&apos;t exist (it may have been deleted).</div>
        <Link href="/automations" className="text-gray-700 underline">
          Back to automations
        </Link>
      </div>
    );
  }

  return (
    <MovementWorkbench
      movementId={movement.id}
      movementName={movement.name}
      initialSource={movement.source}
      initialUpdatedAt={movement.updatedAt}
      initialValidityStatus={movement.validityStatus}
      initialListeners={movement.listeners}
      initialRunnable={movement.runnable}
      languageVersion={movement.languageVersion}
      upgradeDiagnostics={movement.upgradeDiagnostics}
      dependents={movement.dependents}
    />
  );
}
