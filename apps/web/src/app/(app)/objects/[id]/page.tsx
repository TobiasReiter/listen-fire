"use client";

import { useCallback, useRef } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import { NodeIcon } from "@/components/node-icon";
import { NodesTable, type NodesTableHandle } from "@/components/nodes-table";

export default function ObjectTypePage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const tableRef = useRef<NodesTableHandle>(null);

  const filterId = searchParams.get("filter");

  const handleFilterIdChange = useCallback(
    (newFilterId: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (newFilterId) {
        params.set("filter", newFilterId);
      } else {
        params.delete("filter");
      }
      const qs = params.toString();
      router.replace(`/objects/${id}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [id, searchParams, router],
  );

  const { data: nodeType } = trpc.views.knowledge.ontology.getNodeType.useQuery(
    { id },
  );
  const { data: ontology } =
    trpc.views.knowledge.ontology.getOntologySummary.useQuery();

  usePageTitle(nodeType ? `${nodeType.name} — TARS` : "TARS");

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {nodeType ? (
            <>
              <NodeIcon
                nodeTypeId={id}
                iconSvg={
                  ontology?.nodeTypes.find((n) => n.id === id)?.icon_svg ?? null
                }
                size={18}
                className="text-gray-500"
              />
              <h1 className="shrink-0 text-base font-semibold text-gray-900">
                {nodeType.name}
              </h1>
              {nodeType.description && (
                <span className="hidden truncate text-[13px] text-gray-400 sm:block">
                  {nodeType.description}
                </span>
              )}
            </>
          ) : (
            <>
              <div className="h-4.5 w-4.5 animate-pulse rounded bg-gray-100" />
              <div className="h-4 w-28 animate-pulse rounded bg-gray-100" />
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => tableRef.current?.openCreate()}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-white transition-colors hover:bg-primary-600"
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="hidden sm:inline">New</span>
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1">
        <NodesTable ref={tableRef} nodeTypeId={id} ontology={ontology} showCreateButton={false} filterId={filterId} onFilterIdChange={handleFilterIdChange} />
      </div>
    </div>
  );
}
