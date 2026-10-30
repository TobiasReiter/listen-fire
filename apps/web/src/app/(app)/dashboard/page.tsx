"use client";

/**
 * `/dashboard` — the platform home and the front door every sign in lands on.
 * Three states, picked by the server-side `kind` discriminator on the
 * `home.getDashboard` payload:
 *
 *   1. `empty`        — no triggers and no knowledge nodes. A plain empty
 *                       state that points at the Connect-Claude steps in
 *                       settings (you build automations in Claude, not here).
 *
 *   2. `needs_setup`  — at least one trigger exists but nothing is live.
 *                       Hero card pointing at the first incomplete automation.
 *
 *   3. `live`         — at least one automation is live. A 12-column overview:
 *                       a row of headline tiles, the activity feed and the
 *                       automation list on the left, what's waiting on you and
 *                       the things you'd come here to start on the right.
 *
 * Every tile and panel is a door — the number tells you whether to care, the
 * click lands on the page where you'd act. Nothing here is decorative.
 *
 * Building happens in Claude over MCP; this page is the viewer/manager of what
 * you've built.
 */

import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  HelpCircle,
  Inbox,
  Plus,
  Sparkles,
  Zap,
} from "lucide-react";

import { trpc, type RouterOutputs } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import {
  Badge,
  CardList,
  EmptyState,
  ListRow,
  PageBody,
  PageHeader,
  SectionHeader,
} from "@/components/ui";

type Dashboard = RouterOutputs["views"]["home"]["getDashboard"];
type DashboardAutomation = Dashboard["automations"][number];
type DashboardEvent = Dashboard["recentEvents"][number];
type ThingWaiting = Dashboard["thingsWaiting"][number];
type DashboardStats = Dashboard["stats"];

function formatRelativeTime(date: Date | string | null): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}

/** Headline numbers stay readable at a glance — grouped below 10k, compacted
 *  above it so a tile never wraps. */
function formatCount(value: number): string {
  if (value < 10_000) return value.toLocaleString("en-US");
  if (value < 1_000_000) return `${trimZero(value / 1000)}K`;
  return `${trimZero(value / 1_000_000)}M`;
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/**
 * Where an automation link should land: the movement page (run history +
 * editing live there now) when the trigger dispatches into one, else the
 * trigger's own config-only page — the fallback legacy movement-less
 * triggers still need.
 */
function automationHref(automation: { id: string; movementId: string | null }): string {
  return automation.movementId
    ? `/movements/${automation.movementId}`
    : `/automations/${automation.id}`;
}

type AutomationStatus = "live" | "setting_up" | "paused" | "error";

const STATUS_TONES: Record<
  AutomationStatus,
  React.ComponentProps<typeof Badge>["tone"]
> = {
  live: "emerald",
  setting_up: "amber",
  paused: "gray",
  error: "red",
};

function StatusPill({
  status,
  label,
}: {
  status: AutomationStatus;
  label: string;
}) {
  return (
    <Badge tone={STATUS_TONES[status]} testId={`status-pill-${status}`}>
      {label}
    </Badge>
  );
}

/**
 * A quiet reminder that automations are built in Claude — a text link to the
 * Connect-Claude steps in settings. Shown where the user likely hasn't built
 * anything yet; a `live` account is already connected, so it's omitted there.
 */
function ConnectReminder() {
  return (
    <Link
      href="/settings#connect"
      className="flex items-center gap-2 rounded-lg border border-primary/15 bg-primary/[0.04] px-4 py-2.5 text-[13px] text-gray-600 transition-colors hover:border-primary/30"
      data-testid="dashboard-connect-reminder"
    >
      <Sparkles size={14} className="shrink-0 text-primary" />
      <span>
        Automations are built in Claude.{" "}
        <span className="font-medium text-primary">Connect your Claude →</span>
      </span>
    </Link>
  );
}

export default function DashboardPage() {
  usePageTitle("Home — KIPP");

  const { data, isLoading } = trpc.views.home.getDashboard.useQuery();

  let content: React.ReactNode;
  if (isLoading || !data) {
    content = (
      <div className="flex h-full items-center justify-center bg-white">
        <div className="flex items-center gap-2 text-[13px] text-gray-400">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-300" />
          <div
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-300"
            style={{ animationDelay: "0.15s" }}
          />
          <div
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-300"
            style={{ animationDelay: "0.3s" }}
          />
        </div>
      </div>
    );
  } else if (data.kind === "empty") {
    content = <EmptyDashboardView />;
  } else if (data.kind === "needs_setup") {
    content = <NeedsSetupView automations={data.automations} />;
  } else {
    content = <LiveView dashboard={data} />;
  }

  return content;
}

/**
 * Empty team — nothing built yet. The story is "build in Claude": point them
 * at the Connect-Claude steps in settings.
 */
function EmptyDashboardView() {
  return (
    <div className="flex h-full flex-col" data-testid="dashboard-empty">
      <PageHeader title="Home" />
      <PageBody width="narrow">
        <div className="space-y-8">
          <EmptyState
            icon={<Sparkles size={20} />}
            title="Nothing here yet — build your first automation in Claude."
            action={
              <Link
                href="/settings#connect"
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-primary-600"
              >
                Connect your Claude →
              </Link>
            }
          />
        </div>
      </PageBody>
    </div>
  );
}

/**
 * "Has-team, no live automations" — typical right after an automation has been
 * authored but not activated. Hero CTA points at the first incomplete
 * automation; secondary list shows the others if multiple.
 */
function NeedsSetupView({
  automations,
}: {
  automations: DashboardAutomation[];
}) {
  // Pick the first incomplete one as the hero. Almost always exactly one.
  const hero = automations.find((a) => a.status === "setting_up") ?? automations[0];

  return (
    <div className="flex h-full flex-col" data-testid="dashboard-needs-setup">
      <PageHeader title="Home" />

      <PageBody width="narrow">
        <div className="mb-10">
          <ConnectReminder />
        </div>
        <div>
          {hero && (
            <div
              className="rounded-2xl border border-amber-100 bg-amber-50/40 p-6"
              data-testid="dashboard-hero-finish-setup"
            >
              <div className="flex items-start gap-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                  <Sparkles size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-semibold text-gray-900">
                    Finish setting up{" "}
                    <span className="text-amber-700">{hero.name}</span>
                  </h2>
                  <p className="mt-1 text-[13px] leading-relaxed text-gray-600">
                    {hero.description} It's almost ready — one more step and
                    your records will start flowing.
                  </p>
                  <div className="mt-4 flex items-center gap-3">
                    <Link
                      href={automationHref(hero)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-amber-700"
                    >
                      Continue setup
                    </Link>
                    <StatusPill status={hero.status} label={hero.statusLabel} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {automations.length > 1 && (
            <div className="mt-10" data-testid="dashboard-other-automations">
              <SectionHeader title="Other automations" />
              <CardList>
                {automations
                  .filter((a) => a.id !== hero?.id)
                  .map((a) => (
                    <ListRow key={a.id} href={automationHref(a)}>
                      <Zap size={14} className="shrink-0 text-gray-400" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">
                        {a.name}
                      </span>
                      <StatusPill status={a.status} label={a.statusLabel} />
                    </ListRow>
                  ))}
              </CardList>
            </div>
          )}
        </div>
      </PageBody>
    </div>
  );
}

// ─── Live overview ────────────────────────────────────────────────────

/**
 * The card every panel on the overview wears, so the grid reads as one
 * surface: one border, a titled head, a flush body the rows divide
 * themselves. (`CardList` draws its own border — inside a panel that would
 * double up, so panel bodies use the divider alone.)
 */
function Panel({
  title,
  action,
  testId,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className="overflow-hidden rounded-xl border border-gray-100"
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-2.5">
        <h2 className="truncate text-[13px] font-semibold text-gray-900">
          {title}
        </h2>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="divide-y divide-gray-100">{children}</div>
    </section>
  );
}

function PanelLink({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className="text-[12px] text-gray-400 transition-colors hover:text-primary"
    >
      {children} →
    </Link>
  );
}

/** A panel's own quiet nothing-here line. Deliberately not `EmptyState` —
 *  its dashed box inside a bordered panel reads as a second card. */
function PanelEmpty({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      {icon && <div className="text-gray-300">{icon}</div>}
      <p className="max-w-xs text-[12px] leading-relaxed text-gray-400">
        {children}
      </p>
    </div>
  );
}

/**
 * One headline number. The label names it, the value carries it in ink, and
 * the note underneath says what the number is measured over — or badges the
 * one thing that would make you click. Colour never carries meaning alone:
 * a badge always spells out what it means.
 */
function StatTile({
  label,
  value,
  note,
  href,
  testId,
}: {
  label: string;
  value: number;
  note: React.ReactNode;
  href: string;
  testId: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="col-span-6 rounded-xl border border-gray-100 px-4 py-3.5 transition-colors hover:border-gray-200 hover:bg-gray-50/60 lg:col-span-3"
    >
      <p className="truncate text-[12px] text-gray-500">{label}</p>
      <p className="mt-1.5 text-[26px] font-semibold leading-none text-gray-900">
        {formatCount(value)}
      </p>
      <div className="mt-2.5 flex h-[18px] items-center">{note}</div>
    </Link>
  );
}

function StatNote({ children }: { children: React.ReactNode }) {
  return <span className="truncate text-[11px] text-gray-400">{children}</span>;
}

function StatRow({
  stats,
  automationCount,
}: {
  stats: DashboardStats;
  automationCount: number;
}) {
  const idle = automationCount - stats.activeAutomations;
  return (
    <>
      <StatTile
        label="Active automations"
        value={stats.activeAutomations}
        href="/automations"
        testId="dashboard-stat-active"
        note={
          idle > 0 ? (
            <StatNote>{idle} not running</StatNote>
          ) : (
            <StatNote>all running</StatNote>
          )
        }
      />
      <StatTile
        label="Events today"
        value={stats.eventsToday}
        href="/runs"
        testId="dashboard-stat-events"
        note={<StatNote>last 24 hours</StatNote>}
      />
      <StatTile
        label="Runs"
        value={stats.runs7d}
        href="/runs"
        testId="dashboard-stat-runs"
        note={
          stats.failures7d > 0 ? (
            <Badge tone="red" testId="dashboard-stat-failures">
              {stats.failures7d} failed
            </Badge>
          ) : (
            <StatNote>last 7 days</StatNote>
          )
        }
      />
      <StatTile
        label="Open questions"
        value={stats.openAsks}
        href="/asks"
        testId="dashboard-stat-asks"
        note={
          stats.openAsks > 0 ? (
            <Badge tone="amber" testId="dashboard-stat-asks-waiting">
              Needs an answer
            </Badge>
          ) : (
            <StatNote>nothing to answer</StatNote>
          )
        }
      />
    </>
  );
}

/**
 * "Has-team, live automations" — the overview grid. One 12-column grid holds
 * everything: tiles across the top, then the two reading columns. On a narrow
 * screen the columns stack and "Needs your attention" is ordered above the
 * feed, because on a phone you came here to act, not to browse.
 */
function LiveView({ dashboard }: { dashboard: Dashboard }) {
  return (
    <div className="flex h-full flex-col" data-testid="dashboard-live">
      <PageHeader title="Home" />

      <PageBody width="wide">
        <div className="space-y-5">
          <div className="grid grid-cols-12 gap-4">
            <StatRow
              stats={dashboard.stats}
              automationCount={dashboard.automations.length}
            />

            <div className="order-2 col-span-12 space-y-5 lg:order-1 lg:col-span-8">
              <RecentActivityPanel events={dashboard.recentEvents} />
              <AutomationStatusPanel automations={dashboard.automations} />
            </div>

            <div className="order-1 col-span-12 space-y-5 lg:order-2 lg:col-span-4">
              <ThingsWaitingPanel items={dashboard.thingsWaiting} />
              <QuickActionsPanel />
            </div>
          </div>
        </div>
      </PageBody>
    </div>
  );
}

const WAITING_ICON_TONES: Record<ThingWaiting["kind"], string> = {
  setup_incomplete: "text-amber-500",
  error: "text-red-500",
  ask: "text-primary",
};

function WaitingIcon({ kind }: { kind: ThingWaiting["kind"] }) {
  const className = `mt-0.5 shrink-0 ${WAITING_ICON_TONES[kind]}`;
  return kind === "ask" ? (
    <HelpCircle size={14} className={className} />
  ) : (
    <AlertCircle size={14} className={className} />
  );
}

function ThingsWaitingPanel({ items }: { items: ThingWaiting[] }) {
  return (
    <Panel title="Needs your attention" testId="dashboard-things-waiting">
      {items.length === 0 ? (
        <PanelEmpty icon={<CheckCircle2 size={18} />}>
          Nothing waiting on you.
        </PanelEmpty>
      ) : (
        items.map((item, i) => (
          <ListRow
            key={`${item.kind}-${item.automationId ?? "all"}-${i}`}
            href={item.actionUrl}
            className="!items-start"
          >
            <WaitingIcon kind={item.kind} />
            <span className="min-w-0 flex-1 text-[13px] leading-snug text-gray-700">
              {item.message}
            </span>
            <ArrowRight size={13} className="mt-0.5 shrink-0 text-gray-300" />
          </ListRow>
        ))
      )}
    </Panel>
  );
}

/** The handful of places you'd go to start something, rather than to react to
 *  something that already happened. */
function QuickActionsPanel() {
  const actions = [
    { href: "/movements/new", icon: Plus, label: "New automation" },
    { href: "/asks", icon: HelpCircle, label: "Answer questions" },
    { href: "/settings#connect", icon: BookOpen, label: "Setup guide" },
  ];
  return (
    <Panel title="Quick actions" testId="dashboard-quick-actions">
      {actions.map(({ href, icon: Icon, label }) => (
        <ListRow key={href} href={href}>
          <Icon size={14} className="shrink-0 text-gray-400" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-gray-700">
            {label}
          </span>
          <ArrowRight size={13} className="shrink-0 text-gray-300" />
        </ListRow>
      ))}
    </Panel>
  );
}

function RecentActivityPanel({ events }: { events: DashboardEvent[] }) {
  return (
    <Panel
      title="Recent activity"
      testId="dashboard-recent-activity"
      action={events.length > 0 ? <PanelLink href="/runs">All runs</PanelLink> : undefined}
    >
      {events.length === 0 ? (
        <PanelEmpty icon={<Inbox size={18} />}>
          Nothing yet — once your automations start receiving events, they'll
          appear here.
        </PanelEmpty>
      ) : (
        events.map((event) => (
          <ListRow key={event.id} className="!items-start">
            <span
              className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                event.status === "failed"
                  ? "bg-red-500"
                  : event.status === "partial"
                    ? "bg-amber-400"
                    : "bg-emerald-500"
              }`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="text-[13px] leading-snug text-gray-700">
                  {event.description}
                </p>
                {event.dryRun && (
                  <Badge
                    tone="gray"
                    title="A preview run — it captured writes but didn't commit anything."
                    testId={`recent-event-dry-run-${event.id}`}
                  >
                    Dry run
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-[12px] text-gray-400">
                {formatRelativeTime(event.at)}
              </p>
            </div>
            {event.automationId && (
              <Link
                href={automationHref({ id: event.automationId, movementId: event.movementId })}
                className="shrink-0 self-start text-gray-300 transition-colors hover:text-primary"
              >
                <ArrowRight size={13} />
              </Link>
            )}
          </ListRow>
        ))
      )}
    </Panel>
  );
}

function AutomationStatusPanel({
  automations,
}: {
  automations: DashboardAutomation[];
}) {
  return (
    <Panel
      title="Your automations"
      testId="dashboard-automation-status"
      action={
        automations.length > 0 ? (
          <PanelLink href="/automations">See all</PanelLink>
        ) : undefined
      }
    >
      {automations.length === 0 ? (
        <PanelEmpty icon={<Zap size={18} />}>
          You don't have any automations yet.
        </PanelEmpty>
      ) : (
        automations.map((a) => (
          <ListRow key={a.id} href={automationHref(a)}>
            <Zap size={14} className="shrink-0 text-gray-400" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-gray-900">
                {a.name}
              </p>
              <p className="mt-0.5 truncate text-[12px] text-gray-500">
                {a.description}
              </p>
            </div>
            <div className="hidden shrink-0 text-right md:block">
              <p className="text-[12px] text-gray-400">
                {plural(a.eventsToday, "event")} today
              </p>
              <p className="text-[12px] text-gray-300">
                {a.lastEventAt
                  ? `last ${formatRelativeTime(a.lastEventAt)}`
                  : "no events yet"}
              </p>
            </div>
            <StatusPill status={a.status} label={a.statusLabel} />
          </ListRow>
        ))
      )}
    </Panel>
  );
}
