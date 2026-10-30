"use client";

/**
 * Primary sidebar — user-mental-model nav.
 *
 *   Home
 *   Automation
 *     Automations / Runs
 *   Asks
 *     Inbox (open-count badge) / History
 *   Knowledge Graph
 *     Data model ─── (clickable → /model)
 *       ▸ <object types>    → /objects/{id}
 *     API Explorer
 *   Platform
 *     Credentials / Adapters / Plugins / Handbook
 *   ─────
 *   Settings
 *
 * The "Data model" group is first-class: the knowledge graph is half
 * the product (storing/querying data), so the model and its node types
 * live in the nav permanently, not behind Developer mode. This restores
 * the per-node-type entries that U2 dropped — a deliberate call, superseding
 * U2's "hide the data model behind the dev toggle" stance for the model
 * specifically.
 *
 * 2026-06-11: the Advanced section is gone — Library is an ordinary
 * top-level page, API Explorer lives with the Knowledge Graph it
 * queries, Schema types was deleted, and Ask was replaced by the
 * assistant panel's in-place expansion (no /ask page).
 *
 * 2026-08-04: Asks promoted to its own top-level section (was a single
 * "Waiting" item mixed in with Automations/Runs) — Inbox (open questions +
 * parked runs) and History (settled) are separate pages now. Library
 * relabelled "Handbook" in the nav (the page itself is unchanged — the
 * automations handbook shelf, not a code library) and moved under a new
 * "Platform" section with the other import-namespace pages.
 *
 */

import { useCallback, useRef, useState, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Briefcase,
  History,
  Home,
  Inbox,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Puzzle,
  Settings,
  Sparkles,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { firstMountedHref, navIsMounted } from "@/lib/capabilities";
import { useCapabilities, useCapabilitiesSettled } from "@/lib/capabilities-provider";
import { trpc } from "@/lib/trpc";
import { Badge } from "./ui";
import {
  OntologyIcon,
  ApiExplorerIcon,
  LibraryIcon,
  SignOutIcon,
} from "./icons";
import { NodeIcon } from "./node-icon";
import { GlobalSearch } from "./global-search";
import { RunningIndicator } from "./running-indicator";

function NavItem({
  href,
  icon,
  label,
  active,
  shortcut,
  collapsed,
  trailing,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  shortcut?: string;
  collapsed?: boolean;
  trailing?: React.ReactNode;
}) {
  if (collapsed) {
    return (
      <Link
        href={href}
        title={label}
        className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
          active
            ? "bg-primary-50 text-primary-700"
            : "text-gray-600 hover:bg-gray-100/60 hover:text-gray-900"
        }`}
      >
        {icon}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      className={`relative flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
        active
          ? "bg-primary-50 font-medium text-primary-700"
          : "text-gray-600 hover:bg-gray-100/60 hover:text-gray-900"
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
      {shortcut && (
        <kbd className="ml-auto shrink-0 text-[10px] tracking-wide text-gray-300">
          {shortcut}
        </kbd>
      )}
      {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
    </Link>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="mt-4 px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-gray-400">
      {label}
    </div>
  );
}

function GroupHeader({
  href,
  icon,
  label,
  active,
  collapsed,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed?: boolean;
}) {
  if (collapsed) {
    return (
      <Link
        href={href}
        title={label}
        className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
          active
            ? "bg-primary-50 text-primary-700"
            : "text-gray-600 hover:bg-gray-100/60 hover:text-gray-900"
        }`}
      >
        {icon}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
        active
          ? "bg-primary-50 font-medium text-primary-700"
          : "text-gray-600 hover:bg-gray-100/60 hover:text-gray-900"
      }`}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

function GroupChild({
  href,
  icon,
  label,
  active,
  collapsed,
  trailing,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed?: boolean;
  trailing?: React.ReactNode;
}) {
  if (collapsed) {
    return (
      <Link
        href={href}
        title={label}
        className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
          active
            ? "bg-primary-50 text-primary-700"
            : "text-gray-600 hover:bg-gray-100/60 hover:text-gray-900"
        }`}
      >
        {icon}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      className={`flex items-center gap-2 rounded-md py-1 pl-6 pr-3 text-[13px] transition-colors ${
        active
          ? "bg-primary-50 font-medium text-primary-700"
          : "text-gray-600 hover:bg-gray-100/60 hover:text-gray-900"
      }`}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </Link>
  );
}

function EmptySection({ label }: { label: string }) {
  return (
    <div className="px-3 py-1.5 pl-6 text-[12px] text-gray-400">{label}</div>
  );
}

function SkeletonItem({ collapsed }: { collapsed?: boolean }) {
  if (collapsed) {
    return (
      <div className="flex h-8 w-8 items-center justify-center">
        <div className="h-4 w-4 animate-pulse rounded bg-gray-100" />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 py-1 pl-6 pr-3">
      <div className="h-4 w-4 animate-pulse rounded bg-gray-100" />
      <div className="h-3.5 w-24 animate-pulse rounded bg-gray-100" />
    </div>
  );
}

function isPathActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({
  collapsed,
  onToggle,
  isMobile,
}: {
  collapsed: boolean;
  onToggle: () => void;
  isMobile: boolean;
}) {
  const pathname = usePathname();
  const { identityLabel, logout, switchTeam, teamId: selectedTeamId } = useAuth();
  const capabilities = useCapabilities();
  // Until the capability probe lands, `capabilities` is null and every `shows`
  // answers yes — which on a shape that runs neither unit is a burst of calls
  // the gate is going to refuse. Every query below waits for the probe, the
  // same as `/` and the login page do; once it has settled nothing changes.
  const settled = useCapabilitiesSettled();
  const shows = (href: string) => navIsMounted(href, capabilities);
  // Not a product gate — the models tree is served everywhere. A static
  // install simply has no user row for its machine principal to look up.
  const { data: userContext } = trpc.models.user.context.useQuery(undefined, {
    enabled: settled && capabilities?.identity !== "static",
  });
  const { data: ontology, isLoading: ontologyLoading } =
    trpc.views.knowledge.ontology.getOntologySummary.useQuery(undefined, {
      enabled: settled && shows("/model"),
    });
  const { data: askRecords } = trpc.views.controlTower.listAskRecords.useQuery(
    undefined,
    { refetchInterval: 30_000, enabled: settled && shows("/automations") },
  );
  const openAskCount = (askRecords ?? []).filter((a) => a.state === "open").length;

  const objectTypes =
    ontology?.nodeTypes?.filter(
      (n) => n.category === "object" || n.category === "scoped_object",
    ) ?? [];

  const teams = userContext?.teams ?? [];
  const activeTeam = useMemo(() => {
    if (!teams.length) return null;
    const activeId = selectedTeamId ?? userContext?.defaultTeam?.id;
    return teams.find((t) => t.id === activeId) ?? teams[0];
  }, [teams, selectedTeamId, userContext?.defaultTeam?.id]);
  const hasMultipleTeams = teams.length > 1;

  // On mobile, collapsed means fully hidden (off-screen).
  // On desktop, collapsed means narrow icon-only rail.
  const iconOnly = !isMobile && collapsed;

  // Resizable width (desktop expanded only)
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 360;
  const SIDEBAR_DEFAULT = 224;
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = localStorage.getItem("sidebar-width");
      if (stored) {
        const n = parseInt(stored, 10);
        if (!isNaN(n)) return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, n));
      }
    } catch {}
    return SIDEBAR_DEFAULT;
  });
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      dragStartX.current = e.clientX;
      dragStartWidth.current = sidebarWidth;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [sidebarWidth],
  );

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const delta = e.clientX - dragStartX.current;
    setSidebarWidth(
      Math.max(
        SIDEBAR_MIN,
        Math.min(SIDEBAR_MAX, dragStartWidth.current + delta),
      ),
    );
  }, []);

  const onResizePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      try {
        localStorage.setItem("sidebar-width", String(sidebarWidth));
      } catch {}
    },
    [sidebarWidth],
  );

  const expanded = !iconOnly && !isMobile;

  return (
    <aside
      style={expanded ? { width: sidebarWidth } : undefined}
      className={`flex flex-shrink-0 flex-col border-r border-gray-200/80 bg-white transition-all duration-200 ${
        isMobile
          ? `fixed inset-y-0 left-0 z-50 h-full w-72 shadow-xl ${collapsed ? "-translate-x-full" : "translate-x-0"}`
          : `relative h-full ${iconOnly ? "w-12" : expanded ? "" : "w-56"}`
      }`}
    >
      {/* Logo + toggle */}
      <div
        className={`flex h-14 items-center gap-2 text-[24px] font-medium tracking-tight text-[#8778F7] ${
          iconOnly ? "justify-center px-2" : "px-4 justify-between"
        }`}
      >
        <Link
          href={capabilities === null ? "/dashboard" : firstMountedHref(capabilities)}
          title="Home"
          className={`flex items-center gap-2 ${iconOnly ? "" : "min-w-0"}`}
        >
          <img
            src="/logo.svg"
            alt="KIPP — home"
            className="h-[24px] w-[24px] flex-shrink-0"
          />
          {!iconOnly && (
            <span className="flex-0 whitespace-nowrap text-[20px] tracking-[0.15em]">
              KIPP
            </span>
          )}
        </Link>
        <button
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={`flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 ${
            iconOnly ? "hidden" : ""
          }`}
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      {/* Nav */}
      <nav
        className={`flex-1 overflow-y-auto pb-4 ${
          iconOnly ? "flex flex-col items-center gap-0.5 px-1.5" : "px-2"
        }`}
      >
        <GlobalSearch collapsed={iconOnly} />

        {shows("/dashboard") && (
          <NavItem
            href="/dashboard"
            icon={<Home size={16} className="shrink-0" />}
            label="Home"
            active={isPathActive(pathname, "/dashboard")}
            collapsed={iconOnly}
          />
        )}

        {shows("/automations") && (
          <>
            {!iconOnly && <SectionLabel label="Automation" />}
            <NavItem
              href="/automations"
              icon={<Sparkles size={16} className="shrink-0" />}
              label="Automations"
              active={
                isPathActive(pathname, "/automations") ||
                isPathActive(pathname, "/movements")
              }
              collapsed={iconOnly}
            />
            <NavItem
              href="/runs"
              icon={<Activity size={16} className="shrink-0" />}
              label="Runs"
              active={isPathActive(pathname, "/runs")}
              collapsed={iconOnly}
            />
          </>
        )}

        {shows("/asks") && (
          <>
            {!iconOnly && <SectionLabel label="Asks" />}
            <NavItem
              href="/asks"
              icon={<Inbox size={16} className="shrink-0" />}
              label="Inbox"
              active={isPathActive(pathname, "/asks") && !isPathActive(pathname, "/asks/history")}
              collapsed={iconOnly}
              trailing={
                !iconOnly && openAskCount > 0 ? (
                  <Badge tone="primary">{openAskCount}</Badge>
                ) : undefined
              }
            />
            <NavItem
              href="/asks/history"
              icon={<History size={16} className="shrink-0" />}
              label="History"
              active={isPathActive(pathname, "/asks/history")}
              collapsed={iconOnly}
            />
          </>
        )}

        {shows("/portfolio") && (
          <>
            {!iconOnly && <SectionLabel label="Portfolio" />}
            <NavItem
              href="/portfolio"
              icon={<Briefcase size={16} className="shrink-0" />}
              label="Portfolio"
              active={isPathActive(pathname, "/portfolio")}
              collapsed={iconOnly}
            />
          </>
        )}

        {shows("/model") && (
          <>
            {/* Data model — first-class. Header → the schema graph; children
                are the team's node types, each → its records. */}
            {!iconOnly && <SectionLabel label="Knowledge Graph" />}
            <GroupHeader
              href="/model"
              icon={<OntologyIcon />}
              label="Data model"
              active={isPathActive(pathname, "/model")}
              collapsed={iconOnly}
            />
            {ontologyLoading ? (
              <>
                <SkeletonItem collapsed={iconOnly} />
                <SkeletonItem collapsed={iconOnly} />
                <SkeletonItem collapsed={iconOnly} />
              </>
            ) : objectTypes.length === 0 ? (
              !iconOnly && <EmptySection label="No types defined" />
            ) : (
              <>
                {objectTypes.map((nt) => (
                  <GroupChild
                    key={nt.id}
                    href={`/objects/${nt.id}`}
                    icon={<NodeIcon nodeTypeId={nt.id} iconSvg={nt.icon_svg} />}
                    label={nt.name}
                    active={isPathActive(pathname, `/objects/${nt.id}`)}
                    collapsed={iconOnly}
                  />
                ))}
              </>
            )}

            <NavItem
              href="/api-explorer"
              icon={<ApiExplorerIcon />}
              label="API Explorer"
              active={isPathActive(pathname, "/api-explorer")}
              collapsed={iconOnly}
            />
          </>
        )}

        {shows("/credentials") && (
          <>
            {/* The movement language's three built-in import namespaces, in the
                same vocabulary the programs use: credentials / adapters / plugins. */}
            {!iconOnly && <SectionLabel label="Platform" />}
            <NavItem
              href="/credentials"
              icon={<KeyRound size={16} className="shrink-0" />}
              label="Credentials"
              active={isPathActive(pathname, "/credentials")}
              collapsed={iconOnly}
            />
            <NavItem
              href="/adapters"
              icon={<Plug size={16} className="shrink-0" />}
              label="Adapters"
              active={isPathActive(pathname, "/adapters")}
              collapsed={iconOnly}
            />
            <NavItem
              href="/plugins"
              icon={<Puzzle size={16} className="shrink-0" />}
              label="Plugins"
              active={isPathActive(pathname, "/plugins")}
              collapsed={iconOnly}
            />
          </>
        )}
        {shows("/library") && (
          <NavItem
            href="/library"
            icon={<LibraryIcon />}
            label="Handbook"
            active={isPathActive(pathname, "/library")}
            collapsed={iconOnly}
          />
        )}
      </nav>

      {/* Live "automations running" badge — sits just above the footer,
          shows only when something is in flight. */}
      <div className={iconOnly ? "px-1.5" : "px-2"}>
        <RunningIndicator collapsed={iconOnly} />
      </div>

      {/* User / settings / sign-out */}
      <div
        className={`border-t border-gray-200 py-3 ${iconOnly ? "flex flex-col items-center gap-1 px-1.5" : "px-2"}`}
      >
        {hasMultipleTeams && !iconOnly && (
          <div className="px-3 pb-2">
            <select
              value={activeTeam?.id ?? ""}
              onChange={(e) => switchTeam(e.target.value)}
              className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-[12px] text-gray-600 focus:border-gray-400 focus:outline-none"
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {shows("/settings") && (
          <NavItem
            href="/settings"
            icon={<Settings size={16} />}
            label="Settings"
            active={isPathActive(pathname, "/settings")}
            collapsed={iconOnly}
          />
        )}
        {iconOnly ? (
          <>
            <button
              onClick={onToggle}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <PanelLeftOpen size={15} />
            </button>
            <button
              onClick={logout}
              title={identityLabel ?? "Sign out"}
              aria-label="Sign out"
              className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-50 hover:text-gray-900"
            >
              <SignOutIcon />
            </button>
          </>
        ) : (
          <button
            onClick={logout}
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-[13px] text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-900"
          >
            <SignOutIcon />
            <span className="truncate">{identityLabel ?? "Sign out"}</span>
          </button>
        )}
      </div>
      {/* Resize handle (desktop expanded only) */}
      {expanded && (
        <div
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/30 active:bg-primary/50"
        />
      )}
    </aside>
  );
}
