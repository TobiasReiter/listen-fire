import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Attio integration — KIPP",
  description:
    "Connect Attio to KIPP. Describe an automation in plain language — KIPP extracts from emails and documents, writes records, lists, notes, and tasks into Attio, and reacts to changes in your workspace.",
};

const CAPABILITIES = [
  {
    title: "Write records",
    body: "KIPP extracts structured fields from emails, meetings, and documents, then creates or updates Companies, People, Deals, or any custom object in Attio. Values are checked against your attribute types — selects, statuses, currencies, references — before they're written.",
  },
  {
    title: "Deduplicate on write",
    body: "KIPP honours your workspace's uniqueness rules, plus any matching rules you add, so an inbound mention updates the existing record instead of creating a copy. Fields can be set-once, so a value entered by hand is never overwritten.",
  },
  {
    title: "Maintain lists",
    body: "Add records to lists (e.g. a Dealflow pipeline) and update list-specific attributes like Stage or Priority as the situation evolves.",
  },
  {
    title: "Create tasks",
    body: "Generate follow-up tasks attached to the right record, with the deadline derived from the source message and the assignee resolved to a real workspace member.",
  },
  {
    title: "Add notes",
    body: "Drop summaries and rationale onto records so the human reading them in Attio sees not just the values, but the reasoning behind them.",
  },
  {
    title: "Attach files",
    body: "Upload supporting documents — pitch decks, contracts, screenshots — and link them to the record they belong to.",
  },
  {
    title: "React to changes in Attio",
    body: "Trigger automations when records are created, updated, or deleted in Attio — move a deal to Won and let KIPP handle what follows. KIPP recognises its own writes, so nothing loops.",
  },
  {
    title: "Query and backfill",
    body: "Read from Attio inside an automation — search, filter, sort — and sweep existing records on demand or on a schedule, e.g. every Seed-stage company created this quarter.",
  },
  {
    title: "See what it did, field by field",
    body: "Run a new automation on a real email or record and watch what lands in Attio. Run history shows every write, field by field, traced back to the exact source text that produced it.",
  },
];

const STEPS = [
  {
    title: "Connect your Attio workspace",
    detail: (
      <>
        Open <span className="font-medium text-gray-900">Credentials</span> in
        the KIPP sidebar, click{" "}
        <span className="font-medium text-gray-900">Add credential</span>, and
        pick Attio. A pop-up runs the Attio authorization flow — approve the
        requested scopes (see <a href="#permissions" className="underline underline-offset-2 hover:text-primary-700">Permissions</a> below).
      </>
    ),
  },
  {
    title: "Describe your automation",
    detail: (
      <>
        Open <span className="font-medium text-gray-900">Automations</span> and
        create a new one. Describe what you want in plain language — &quot;when
        a pitch email arrives, extract the company and round details, then
        create or update the Attio Company and add it to our Dealflow
        list&quot; — and the assistant drafts it as a short, readable program.
        You can read exactly what it will do, and change it by asking or by
        editing it directly.
      </>
    ),
  },
  {
    title: "Run it on something real",
    detail:
      "Point it at a real email or record and see what lands in Attio: which records, which fields, and the source text each value came from. If it isn't right, say so and it changes.",
  },
  {
    title: "Turn it on",
    detail:
      "Flip it live. Email, Slack, schedules, and Attio webhooks start firing it, and every run is recorded — each record written in Attio links back to the message that produced it.",
  },
];

const SCOPES = [
  {
    name: "object_configuration:read",
    desc: "Enumerate objects and their attributes so KIPP can show available fields and validate types before writing.",
  },
  {
    name: "record_permission:read",
    desc: "Read records to dedupe before creation, enrich webhook events with the full record payload, and resolve records your automations reference.",
  },
  {
    name: "record_permission:write",
    desc: "Core product purpose: create and update records in Attio (Companies, People, Deals, custom objects) from extracted message data.",
  },
  {
    name: "list_configuration:read",
    desc: "Enumerate lists and their attributes when an automation writes into a list.",
  },
  {
    name: "list_entry:read",
    desc: "Check whether a record is already on a list to prevent duplicates; reconcile list state during bidirectional sync.",
  },
  {
    name: "list_entry:write",
    desc: "Add records to lists and update list-specific attributes like Stage on a Deals list.",
  },
  {
    name: "task:read",
    desc: "Fetch task content for webhooks. Attio's webhook only references the task ID, so we retrieve the body to reflect edits in KIPP.",
  },
  {
    name: "task:write",
    desc: "Create follow-up tasks linked to the right record, with the right assignee and deadline.",
  },
  {
    name: "comment:read",
    desc: "Fetch comment content for webhooks so automations can react to threads added inside Attio.",
  },
  {
    name: "file:read / file:write",
    desc: "Upload supporting files (pitch decks, contracts) and read file references on records during sync.",
  },
  {
    name: "user_management:read",
    desc: 'Resolve assigned owners (e.g. "Owner: Sarah") to actual Attio workspace members so task assignments are routable.',
  },
];

export default function AttioIntegrationDocs() {
  return (
    <div className="min-h-dvh bg-white text-gray-900">
      {/* Header */}
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
        <Link
          href="/"
          className="text-[15px] font-bold tracking-wide text-primary-600"
        >
          KIPP
        </Link>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="rounded-md border border-gray-200 px-3.5 py-2 text-[13px] font-medium text-gray-700 transition-colors hover:border-gray-300 hover:text-gray-900"
          >
            Sign in
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto w-full max-w-3xl px-6 pb-12 pt-10 text-center">
        <div className="mb-7 flex items-center justify-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-gray-100 bg-gray-50 p-1.5">
            <Image
              src="/listen-fire-icon-1024.png"
              alt="KIPP"
              width={56}
              height={56}
            />
          </div>
          <span className="text-2xl text-gray-300">×</span>
          <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-gray-100 bg-white p-2.5">
            <Image
              src="/attio.svg"
              alt="Attio"
              width={40}
              height={40}
            />
          </div>
        </div>
        <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-primary-600">
          Integration · Attio
        </p>
        <h1 className="mb-4 text-[clamp(32px,5vw,48px)] font-semibold leading-[1.1] tracking-tight text-gray-900">
          Turn unstructured signal into Attio records.
        </h1>
        <p className="mx-auto max-w-xl text-[16px] leading-relaxed text-gray-600">
          KIPP reads your emails, meetings, and documents and writes the
          structured result back into Attio — records, list entries, notes,
          tasks, and file attachments — deduplicated against your workspace,
          with every value traceable to its source. Describe what you want in
          plain language; KIPP turns it into an automation you can read.
        </p>
      </section>

      {/* Capabilities */}
      <section className="mx-auto w-full max-w-5xl px-6 py-12">
        <div className="mb-5 flex items-baseline gap-2">
          <h2 className="text-[18px] font-semibold tracking-tight text-gray-900">
            What KIPP can do in Attio
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((c) => (
            <div
              key={c.title}
              className="rounded-xl border border-gray-100 bg-white p-5"
            >
              <h3 className="mb-1.5 text-[14px] font-semibold text-gray-900">
                {c.title}
              </h3>
              <p className="text-[13px] leading-relaxed text-gray-600">
                {c.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Setup */}
      <section className="mx-auto w-full max-w-5xl px-6 py-12">
        <div className="mb-5 flex items-baseline gap-3">
          <h2 className="text-[18px] font-semibold tracking-tight text-gray-900">
            Setup
          </h2>
          <span className="text-[12px] tracking-wide text-gray-400">
            plain language, no field mapping
          </span>
        </div>
        <div className="overflow-hidden rounded-xl border border-gray-100 bg-white">
          {STEPS.map((step, i) => (
            <div
              key={step.title}
              className="grid grid-cols-[64px_1fr] border-b border-gray-100 last:border-b-0"
            >
              <div className="py-5 pl-6 text-[13px] font-semibold tracking-wide text-primary-600">
                {String(i + 1).padStart(2, "0")}
              </div>
              <div className="py-5 pr-6">
                <div className="mb-1 text-[14px] font-semibold text-gray-900">
                  {step.title}
                </div>
                <div className="text-[13px] leading-relaxed text-gray-600">
                  {step.detail}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Permissions */}
      <section
        id="permissions"
        className="mx-auto w-full max-w-5xl px-6 py-12"
      >
        <div className="mb-5 flex items-baseline gap-3">
          <h2 className="text-[18px] font-semibold tracking-tight text-gray-900">
            Permissions
          </h2>
          <span className="text-[12px] tracking-wide text-gray-400">
            requested at install
          </span>
        </div>
        <div className="overflow-hidden rounded-xl border border-gray-100 bg-white">
          {SCOPES.map((s) => (
            <div
              key={s.name}
              className="grid grid-cols-1 border-b border-gray-100 last:border-b-0 sm:grid-cols-[minmax(200px,1fr)_2fr]"
            >
              <div className="px-5 py-4 font-mono text-[12.5px] font-medium text-gray-900">
                {s.name}
              </div>
              <div className="border-t border-gray-100 px-5 py-4 text-[13px] leading-relaxed text-gray-600 sm:border-l sm:border-t-0">
                {s.desc}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 rounded-xl border border-dashed border-gray-200 px-5 py-4 text-[13px] leading-relaxed text-gray-500">
          KIPP only stores the data needed to run your automations. Tokens are
          scoped to the workspace that authorized them and can be revoked at any
          time from{" "}
          <a
            href="https://app.attio.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-600 hover:underline"
          >
            app.attio.com
          </a>{" "}
          or from your KIPP Integrations page.
        </p>
      </section>

      {/* Footer */}
      <footer className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-end gap-4 px-6 py-6 text-[13px] text-gray-400">
        <div className="flex items-center gap-6">
          <Link href="/login" className="hover:text-gray-600">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
