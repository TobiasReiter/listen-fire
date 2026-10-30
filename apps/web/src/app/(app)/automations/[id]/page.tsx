"use client";

/**
 * `/automations/[id]` is a REDIRECT, not a page.
 *
 * A trigger has no life of its own: renaming and deleting happen by editing
 * the movement text, and both the arrival ledger and the run history live in
 * the movement's Activity view. The route survives only so links already out
 * in the world — alerts, chat messages, bookmarks — land somewhere useful
 * instead of 404ing.
 */

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";

export default function AutomationRedirectPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const router = useRouter();

  usePageTitle("Automations — KIPP");

  const { data, error } = trpc.views.triggers.getAutomationDetail.useQuery(
    { id },
    { enabled: !!id },
  );

  useEffect(() => {
    // A trigger with no movement behind it (a legacy row) has nothing to open,
    // and neither does an id that no longer resolves — the list is the honest
    // landing spot for both.
    if (error) {
      router.replace("/automations");
      return;
    }
    if (!data) return;
    router.replace(
      data.movement
        ? `/movements/${encodeURIComponent(data.movement.id)}?view=activity&lane=${encodeURIComponent(data.name)}`
        : "/automations",
    );
  }, [data, error, router]);

  return (
    <div className="flex h-full items-center justify-center gap-2 text-[13px] text-gray-400">
      <Loader2 size={15} className="animate-spin" />
      Opening this automation…
    </div>
  );
}
