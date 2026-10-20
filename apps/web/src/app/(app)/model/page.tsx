"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import { useIsMobile } from "@/lib/use-is-mobile";
import { ResizablePanel } from "@/components/resizable-panel";
import { PanelDrawer } from "@/components/panel-drawer";
import { MobileBottomBar } from "@/components/mobile-bottom-bar";
import { OntologyGraph } from "@/components/ontology/graph";
import { NodeDetailPanel } from "@/components/ontology/node-detail-panel";
import { EdgeDetailPanel } from "@/components/ontology/edge-detail-panel";
import { CreateNodeTypeModal } from "@/components/ontology/create-node-type-modal";
import { CreateEdgeTypeModal } from "@/components/ontology/create-edge-type-modal";
import { CreateEdgeGroupModal } from "@/components/ontology/create-edge-group-modal";
import { TemplatePickerModal } from "@/components/ontology/template-picker-modal";
import { PanelRight } from "lucide-react";
import { OnboardingChat } from "@/components/ontology/onboarding-chat";
import { TAB_ORIGIN_ID } from "@/lib/tab-origin";

type ModalId = "nodeType" | "edgeType" | "edgeGroup" | "template" | null;

export default function OntologyPage() {
  usePageTitle("Model — TARS");
  const router = useRouter();
  const isMobile = useIsMobile();
  const [rightOpen, setRightOpen] = useState(false);
  const [selectedNodeTypeId, setSelectedNodeTypeId] = useState<string | null>(
    null,
  );
  const [selectedEdgeTypeId, setSelectedEdgeTypeId] = useState<string | null>(
    null,
  );
  const [openModal, setOpenModal] = useState<ModalId>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchQuery("");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchOpen]);

  const { data: summary } =
    trpc.views.knowledge.ontology.getOntologySummary.useQuery();

  // When the agent edits the model (from the assistant overlay), refresh
  // — but don't yank a detail panel the user has open (they may be mid-
  // edit). With a panel open, defer to a "refresh" pill; otherwise the
  // canvas updates live.
  const utils = trpc.useUtils();
  const [modelChanged, setModelChanged] = useState(false);
  const refreshModel = useCallback(() => {
    setModelChanged(false);
    void utils.views.knowledge.ontology.getOntologySummary.invalidate();
  }, [utils]);
  const panelOpenRef = useRef(false);
  useEffect(() => {
    panelOpenRef.current = selectedNodeTypeId !== null || selectedEdgeTypeId !== null;
  }, [selectedNodeTypeId, selectedEdgeTypeId]);
  trpc.views.knowledge.ontology.onResourceChange.useSubscription(
    { kinds: ["ontology"] },
    {
      onData: (evt) => {
        if (evt.originId === TAB_ORIGIN_ID) return; // our own edit — already shown
        if (panelOpenRef.current) setModelChanged(true);
        else void utils.views.knowledge.ontology.getOntologySummary.invalidate();
      },
    },
  );

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeTypeId(nodeId);
    setSelectedEdgeTypeId(null);
  }, []);

  const handleNodeDoubleClick = useCallback(
    (nodeId: string, category: string) => {
      if (category === "object" || category === "scoped_object") {
        router.push(`/objects/${nodeId}`);
      }
    },
    [router],
  );

  const handleEdgeClick = useCallback((edgeId: string) => {
    setSelectedEdgeTypeId(edgeId);
    setSelectedNodeTypeId(null);
  }, []);

  const handleNavigateToNode = useCallback((nodeId: string) => {
    setSelectedNodeTypeId(nodeId);
    setSelectedEdgeTypeId(null);
  }, []);

  const hasDetail = selectedNodeTypeId || selectedEdgeTypeId;
  const isEmpty = summary && summary.nodeTypes.length === 0;

  if (isEmpty) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 px-5">
          <h1 className="text-base font-semibold text-gray-900">Model</h1>
        </div>
        <div className="flex-1 overflow-hidden">
          <OnboardingChat />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 px-5">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-gray-900">Model</h1>
          {modelChanged && (
            <button
              onClick={refreshModel}
              className="flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
              title="The assistant changed the model — refresh to see it"
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              Model updated — refresh
            </button>
          )}
          {searchOpen && (
            <div className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 shadow-sm">
              <svg className="h-3.5 w-3.5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter nodes..."
                className="w-40 bg-transparent text-[13px] text-gray-900 outline-none placeholder:text-gray-400"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchOpen(false);
                    setSearchQuery("");
                  }
                }}
              />
              <button
                onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <button
            onClick={() => setOpenModal("template")}
            className="hidden rounded-md px-2.5 py-1 text-[13px] text-gray-600 transition-colors hover:bg-gray-100 sm:block"
          >
            Templates
          </button>
          <button
            onClick={() => setOpenModal("edgeGroup")}
            className="hidden rounded-md border border-gray-200 px-2.5 py-1 text-[13px] text-gray-700 transition-colors hover:bg-gray-50 sm:block"
          >
            + Relationship Group
          </button>
          <button
            onClick={() => setOpenModal("edgeType")}
            className="hidden rounded-md border border-gray-200 px-2.5 py-1 text-[13px] text-gray-700 transition-colors hover:bg-gray-50 sm:block"
          >
            + Relationship
          </button>
          <button
            onClick={() => setOpenModal("nodeType")}
            className="rounded-md bg-primary px-2.5 py-1 text-[13px] text-white transition-colors hover:bg-primary-600"
          >
            <span className="sm:hidden">+ New</span>
            <span className="hidden sm:inline">+ New Type</span>
          </button>
        </div>
      </div>

      {/* Main content */}
      {isMobile ? (
        <>
          <div className="flex flex-1 overflow-hidden">
            <div className="flex-1">
              <OntologyGraph
                onNodeClick={handleNodeClick}
                onEdgeClick={handleEdgeClick}
                onNodeDoubleClick={handleNodeDoubleClick}
                searchFilter={searchQuery || undefined}
              />
            </div>
          </div>
          {hasDetail && (
            <MobileBottomBar>
              <button
                onClick={() => setRightOpen(true)}
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] text-gray-600 hover:bg-gray-100"
              >
                <PanelRight size={14} />
                Details
              </button>
            </MobileBottomBar>
          )}
          <PanelDrawer
            side="right"
            open={rightOpen && Boolean(hasDetail)}
            onClose={() => setRightOpen(false)}
            title="Details"
          >
            {selectedNodeTypeId && summary && (
              <NodeDetailPanel
                nodeTypeId={selectedNodeTypeId}
                allNodeTypes={summary.nodeTypes}
                allEdgeTypes={summary.edgeTypes}
                allPropertyTypes={summary.propertyTypes}
                onClose={() => setSelectedNodeTypeId(null)}
                onNavigateToNode={handleNavigateToNode}
              />
            )}
            {selectedEdgeTypeId && summary && (
              <EdgeDetailPanel
                edgeTypeId={selectedEdgeTypeId}
                allNodeTypes={summary.nodeTypes}
                allEdgeTypes={summary.edgeTypes}
                allPropertyTypes={summary.propertyTypes}
                onClose={() => setSelectedEdgeTypeId(null)}
                onNavigateToNode={handleNavigateToNode}
              />
            )}
          </PanelDrawer>
        </>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1">
            <OntologyGraph
              onNodeClick={handleNodeClick}
              onEdgeClick={handleEdgeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              searchFilter={searchQuery || undefined}
            />
          </div>
          {summary && hasDetail && (
            <ResizablePanel
              side="right"
              defaultWidth={320}
              minWidth={240}
              maxWidth={480}
              storageKey="panel:ontology:right"
              className="border-l border-gray-100 overflow-y-auto bg-white"
            >
              {selectedNodeTypeId && (
                <NodeDetailPanel
                  nodeTypeId={selectedNodeTypeId}
                  allNodeTypes={summary.nodeTypes}
                  allEdgeTypes={summary.edgeTypes}
                  allPropertyTypes={summary.propertyTypes}
                  onClose={() => setSelectedNodeTypeId(null)}
                  onNavigateToNode={handleNavigateToNode}
                />
              )}
              {selectedEdgeTypeId && (
                <EdgeDetailPanel
                  edgeTypeId={selectedEdgeTypeId}
                  allNodeTypes={summary.nodeTypes}
                  allEdgeTypes={summary.edgeTypes}
                  allPropertyTypes={summary.propertyTypes}
                  onClose={() => setSelectedEdgeTypeId(null)}
                  onNavigateToNode={handleNavigateToNode}
                />
              )}
            </ResizablePanel>
          )}
        </div>
      )}

      {/* Modals */}
      <CreateNodeTypeModal
        isOpen={openModal === "nodeType"}
        onClose={() => setOpenModal(null)}
      />
      <CreateEdgeTypeModal
        isOpen={openModal === "edgeType"}
        onClose={() => setOpenModal(null)}
      />
      <CreateEdgeGroupModal
        isOpen={openModal === "edgeGroup"}
        onClose={() => setOpenModal(null)}
      />
      <TemplatePickerModal
        isOpen={openModal === "template"}
        onClose={() => setOpenModal(null)}
      />
    </div>
  );
}
