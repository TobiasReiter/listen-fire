"use client";

/**
 * `/plugins` — the catalogue of bundled plugins a movement can import,
 * rendered from the static per-plugin manifests (`views.plugins.list`).
 *
 * One card per plugin: name, honest description, the movement import name
 * (`import { vc_url_retrieval } from plugins`), what the caller passes in,
 * and what the plugin adds to the data passing through it.
 *
 * Ends with an honest "Write your own plugin" card pointing at the
 * Library's plugin-authoring handbook stub.
 */

import { useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight, Puzzle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import { usePublishPageContext } from "@/components/page-context";
import { ImportSnippet } from "@/components/import-snippet";
import {
  Badge,
  CardList,
  ListRow,
  PageBody,
  PageHeader,
  PageIntro,
} from "@/components/ui";

export default function PluginsPage() {
  usePageTitle("Plugins — KIPP");

  const { data } = trpc.views.plugins.list.useQuery();

  // Tell the global assistant which plugins are on screen.
  usePublishPageContext(
    useMemo(
      () =>
        data
          ? {
              page: "Plugins",
              entities: data.map((plugin) => ({
                kind: "plugin",
                id: plugin.importName,
                name: plugin.name,
              })),
            }
          : null,
      [data],
    ),
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Plugins" />

      <PageBody>
        <PageIntro>
          Reusable steps a movement can call to enrich or reshape data as it
          moves — fetch a linked page, look up a profile. Import one by name
          from{" "}
          <code className="rounded bg-gray-50 px-1 font-mono text-[11px] text-gray-600">
            plugins
          </code>
          .
        </PageIntro>

        {!data ? (
          <div className="text-[13px] text-gray-400">Loading…</div>
        ) : (
          <div className="space-y-10">
            <CardList>
              {data.map((plugin) => (
                <ListRow key={plugin.pluginName} className="!items-start py-3.5">
                  <Puzzle
                    size={16}
                    className="mt-0.5 shrink-0 text-gray-400 opacity-45"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="text-[13px] font-medium text-gray-900">
                      {plugin.name}
                    </span>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-gray-500">
                      {plugin.description}
                    </p>
                    <div className="mt-1.5">
                      <ImportSnippet name={plugin.importName} from="plugins" />
                    </div>
                    <dl className="mt-2 space-y-1">
                      {plugin.params.length > 0 && (
                        <div className="flex gap-1.5 text-[12px]">
                          <dt className="shrink-0 font-medium text-gray-500">
                            Takes:
                          </dt>
                          <dd className="text-gray-400">
                            {plugin.params.map((p, i) => (
                              <span key={p.name}>
                                {i > 0 && "; "}
                                <code className="font-mono text-[11px] text-gray-500">
                                  {p.name}
                                </code>
                                {p.description && ` — ${p.description}`}
                              </span>
                            ))}
                          </dd>
                        </div>
                      )}
                      {plugin.contextAdditions && (
                        <div className="flex gap-1.5 text-[12px]">
                          <dt className="shrink-0 font-medium text-gray-500">
                            Adds:
                          </dt>
                          <dd className="text-gray-400">
                            {plugin.contextAdditions}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </div>
                </ListRow>
              ))}
            </CardList>

            {/* Honest coming-soon: registering your own plugin. */}
            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/40 p-4">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-gray-900">
                  Write your own plugin
                </span>
                <Badge tone="gray">Coming soon</Badge>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
                Registering new plugins isn&apos;t self-serve yet — the ones
                above ship with KIPP. The guide is on its way — see the
                plugin-authoring handbook in the Library.
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
    </div>
  );
}
