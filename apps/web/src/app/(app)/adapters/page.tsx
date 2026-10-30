"use client";

/**
 * `/adapters` — the catalogue of system types Listen-Fire can talk to, rendered
 * straight from the static adapter manifests (`views.adapters.list`).
 *
 * One row per adapter: name, honest description, plain-language capability
 * badges (reads / writes / listens for events), the movement import name
 * (`import { attio } from adapters`), and a Connect affordance that opens
 * the existing credential-creation flow preselected for that service.
 * Built-in adapters (email, WhatsApp, web, the knowledge graph) say so
 * instead of offering Connect.
 *
 * Ends with an honest "Add your own adapter" card pointing at the
 * Library's adapter-authoring handbook stub.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { ExternalServiceType } from "#trpc";
import { usePageTitle } from "@/components/page-title";
import { usePublishPageContext } from "@/components/page-context";
import {
  IntegrationModal,
  CONNECTABLE_CREDENTIAL_TYPES,
} from "@/components/integrations/integration-modal";
import { ImportSnippet } from "@/components/import-snippet";
import { ServiceIcon } from "@/components/service-icon";
import {
  Badge,
  Button,
  CardList,
  ListRow,
  PageBody,
  PageHeader,
  PageIntro,
  SectionHeader,
} from "@/components/ui";

type AdapterEntry = RouterOutputs["views"]["adapters"]["list"][number];

/** ServiceIcon keys are uppercase service-type strings; a couple of
 *  intrinsic slugs need an explicit alias to the brand icon. */
function iconType(slug: string): string {
  const ALIASES: Record<string, string> = {
    "native-valuations": "NATIVE",
    "kg": "NATIVE",
  };
  return ALIASES[slug] ?? slug.toUpperCase();
}

function CapabilityBadges({ entry }: { entry: AdapterEntry }) {
  const badges: {
    label: string;
    tone: React.ComponentProps<typeof Badge>["tone"];
    title: string;
  }[] = [];
  if (entry.reads) {
    badges.push({
      label: "Readable",
      tone: "blue",
      title: "Movements can read records out of this system",
    });
  }
  if (entry.writes) {
    badges.push({
      label: "Writable",
      tone: "emerald",
      title: "Movements can create or update records in this system",
    });
  }
  if (entry.listensForEvents) {
    badges.push({
      label: "Emits events",
      tone: "violet",
      title: "A movement can run when something happens in this system",
    });
  }
  if (badges.length === 0) {
    badges.push({
      label: "In progress",
      tone: "gray",
      title: "Support for this system is still being built",
    });
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {badges.map((b) => (
        <Badge key={b.label} tone={b.tone} title={b.title}>
          {b.label}
        </Badge>
      ))}
    </div>
  );
}

function ConnectCell({
  entry,
  onConnect,
}: {
  entry: AdapterEntry;
  onConnect: () => void;
}) {
  if (!entry.connectType) {
    return (
      <span className="shrink-0 text-[11px] text-gray-400">
        Built in — nothing to connect
      </span>
    );
  }
  if (!CONNECTABLE_CREDENTIAL_TYPES.has(entry.connectType)) {
    return (
      <span className="shrink-0 text-[11px] text-gray-400">
        Connecting not available yet
      </span>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2">
      {entry.connectedCount > 0 && (
        <Badge tone="emerald">
          {entry.connectedCount === 1
            ? "1 credential"
            : `${entry.connectedCount} credentials`}
        </Badge>
      )}
      <Button variant="secondary" size="sm" onClick={onConnect}>
        {entry.connectedCount > 0 ? "Connect another" : "Connect"}
      </Button>
    </div>
  );
}

export default function AdaptersPage() {
  usePageTitle("Adapters — KIPP");

  const { data } = trpc.views.adapters.list.useQuery();
  const [connectType, setConnectType] = useState<ExternalServiceType | null>(
    null,
  );

  // Tell the global assistant which adapters are on screen.
  usePublishPageContext(
    useMemo(
      () =>
        data
          ? {
              page: "Adapters",
              entities: data.map((entry) => ({
                kind: "adapter",
                id: entry.slug,
                name: entry.name,
              })),
            }
          : null,
      [data],
    ),
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Adapters" />

      <PageBody>
        <PageIntro>
          Every kind of system KIPP knows how to talk to. Connecting one
          creates a credential, which movements import by name from{" "}
          <code className="rounded bg-gray-50 px-1 font-mono text-[11px] text-gray-600">
            credentials
          </code>
          .
        </PageIntro>

        {!data ? (
          <div className="text-[13px] text-gray-400">Loading…</div>
        ) : (
          <div className="space-y-10">
            {/* Grouped: always-available built-ins first, then services you
                connect with an account. Custom/remote adapters are the
                coming-soon card below. */}
            {[
              {
                title: "Always available",
                blurb: "part of the platform — nothing to connect",
                entries: data.filter((e) => !e.connectType),
              },
              {
                title: "Connected services",
                blurb: "external tools that need an account credential",
                entries: data.filter((e) => Boolean(e.connectType)),
              },
            ]
              .filter((g) => g.entries.length > 0)
              .map((group) => (
                <section key={group.title}>
                  <SectionHeader title={group.title} subtitle={group.blurb} />
                  <CardList>
                    {group.entries.map((entry) => (
                      <ListRow key={entry.slug} className="!items-start py-3.5">
                        <ServiceIcon
                          type={iconType(entry.slug)}
                          className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 opacity-45"
                        />
                        {/* Connect affordance sits beside the text on
                            desktop, below it on phones — side-by-side it
                            squeezes the description to half width. */}
                        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[13px] font-medium text-gray-900">
                                {entry.name}
                              </span>
                              <CapabilityBadges entry={entry} />
                            </div>
                            {entry.description && (
                              <p className="mt-0.5 text-[12px] leading-relaxed text-gray-500">
                                {entry.description}
                              </p>
                            )}
                            {entry.importName && (
                              <div className="mt-1.5">
                                <ImportSnippet
                                  name={entry.importName}
                                  from="adapters"
                                />
                              </div>
                            )}
                          </div>
                          <ConnectCell
                            entry={entry}
                            onConnect={() =>
                              setConnectType(
                                entry.connectType as ExternalServiceType,
                              )
                            }
                          />
                        </div>
                      </ListRow>
                    ))}
                  </CardList>
                </section>
              ))}

            {/* Honest coming-soon: authoring your own adapter. */}
            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/40 p-4">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-gray-900">
                  Add your own adapter
                </span>
                <Badge tone="gray">Coming soon</Badge>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
                Building an adapter for a system that isn&apos;t listed here
                isn&apos;t self-serve yet. The guide is on its way — see the
                adapter-authoring handbook in the Library.
              </p>
              <Link
                href="/library"
                className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-gray-600 hover:text-gray-900"
              >
                Open the Library
                <ArrowUpRight size={13} />
              </Link>
            </div>
          </div>
        )}
      </PageBody>

      <IntegrationModal
        isOpen={connectType !== null}
        onClose={() => setConnectType(null)}
        initialType={connectType ?? undefined}
      />
    </div>
  );
}
