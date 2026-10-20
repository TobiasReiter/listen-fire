"use client";

// `/movements/new` — write a movement script. The editor opens straight
// into an automation starter (a movement plus a listener, so events on a
// source fire it). Saving stores the script (and makes it live when it has
// no problems), then moves to the movement's own page.

import { usePageTitle } from "@/components/page-title";
import { MovementWorkbench } from "@/components/movements/movement-workbench";

export default function NewMovementPage() {
  usePageTitle("New movement — TARS");
  return <MovementWorkbench starter="automation" />;
}
