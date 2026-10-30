// full node page
"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import { NodeIcon } from "@/components/node-icon";
import { EvidenceSidebar } from "@/components/objects/evidence-sidebar";
import { ChangelogSection } from "@/components/objects/changelog";
import { TAB_ORIGIN_ID } from "@/lib/tab-origin";

function formatValue(
  value: string | number | boolean | null,
  valueType: string,
): string {
  if (value === null || value === undefined) return "\u2014";
  if (valueType === "boolean") return value ? "Yes" : "No";
  if (valueType === "date" && typeof value === "string") {
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  return String(value);
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  URL: "Web page",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  FILE: "File",
  TEXT: "Text",
};

// ---------------------------------------------------------------------------
// EditablePropertyRow
// ---------------------------------------------------------------------------

function EditablePropertyRow({
  propertyName,
  propertyId,
  propertyTypeId,
  nodeId,
  valueType,
  valueText,
  valueNumber,
  valueDate,
  valueBoolean,
  enumValues,
  onEvidenceClick,
  onSaved,
}: {
  propertyName: string;
  propertyId: string | null;
  propertyTypeId: string;
  nodeId: string;
  valueType: string;
  valueText: string | null;
  valueNumber: string | null;
  valueDate: Date | string | null;
  valueBoolean: boolean | null;
  enumValues?: string[] | null;
  onEvidenceClick: () => void;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const editProperty = trpc.views.knowledge.graph.createUserEdit.useMutation();
  const createProperty = trpc.views.knowledge.graph.createProperty.useMutation();

  const currentValue = valueText ?? valueNumber ?? valueBoolean ?? valueDate ?? null;
  const display = formatValue(
    typeof valueDate === "object" && valueDate
      ? (valueDate.toISOString?.() ?? String(valueDate))
      : (currentValue as string | number | boolean | null),
    valueType,
  );
  const isLongText = valueType === "text" && display.length > 50;

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if ("select" in inputRef.current) inputRef.current.select();
    }
  }, [editing]);

  const handleSave = async (rawValue: string) => {
    setSaving(true);
    try {
      const valuePayload =
        valueType === "boolean"
          ? { valueBoolean: rawValue === "true" }
          : valueType === "number"
            ? { valueNumber: rawValue || null }
            : valueType === "date"
              ? { valueDate: rawValue || null }
              : { valueText: rawValue || null };

      if (propertyId) {
        await editProperty.mutateAsync({
          propertyId,
          description: "Manual edit",
          ...valuePayload,
        });
      } else {
        await createProperty.mutateAsync({
          nodeId,
          propertyTypeId,
          ...valuePayload,
        });
      }
      onSaved();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    const initialValue = (() => {
      if (valueType === "boolean") return String(valueBoolean ?? "false");
      if (valueType === "number") return valueNumber ?? "";
      if (valueType === "date") {
        if (!valueDate) return "";
        const dt = typeof valueDate === "string" ? new Date(valueDate) : valueDate;
        return dt.toISOString().slice(0, 10);
      }
      return valueText ?? "";
    })();

    if (valueType === "boolean" || (enumValues && enumValues.length > 0)) {
      const options =
        valueType === "boolean"
          ? [
              { value: "true", label: "Yes" },
              { value: "false", label: "No" },
            ]
          : (enumValues ?? []).map((v) => ({ value: v, label: v }));

      return (
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-[13px] text-gray-500">{propertyName}</span>
          <select
            defaultValue={initialValue}
            disabled={saving}
            onChange={(e) => handleSave(e.target.value)}
            onBlur={() => setEditing(false)}
            autoFocus
            className="rounded border border-primary/40 bg-transparent px-2 py-0.5 text-[13px] text-gray-900 outline-none"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    }

    const isLongTextEdit = valueType === "text" && String(initialValue).length > 50;

    if (isLongTextEdit) {
      return (
        <div className="px-4 py-2.5">
          <span className="mb-1 block text-[13px] text-gray-500">
            {propertyName}
          </span>
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            defaultValue={initialValue}
            disabled={saving}
            rows={4}
            className="w-full rounded border border-primary/40 bg-transparent p-2 text-[13px] leading-snug text-gray-900 outline-none"
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && e.metaKey) handleSave(e.currentTarget.value);
            }}
            onBlur={(e) => {
              if (!saving) handleSave(e.currentTarget.value);
            }}
          />
        </div>
      );
    }

    return (
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="shrink-0 text-[13px] text-gray-500">{propertyName}</span>
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type={
            valueType === "date" ? "date" : valueType === "number" ? "number" : "text"
          }
          defaultValue={initialValue}
          disabled={saving}
          className="w-40 rounded border border-primary/40 bg-transparent px-2 py-0.5 text-right text-[13px] text-gray-900 outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave(e.currentTarget.value);
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={(e) => {
            if (!saving) handleSave(e.currentTarget.value);
          }}
        />
      </div>
    );
  }

  // Long text: stacked layout
  if (isLongText) {
    return (
      <div
        className="group cursor-pointer px-4 py-2.5 transition-colors hover:bg-gray-50"
        onClick={() => setEditing(true)}
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[13px] text-gray-500">{propertyName}</span>
          <div className="flex items-center gap-1">
            {propertyId && (
              <button
                onClick={(e) => { e.stopPropagation(); onEvidenceClick(); }}
                className="flex h-5 w-5 items-center justify-center rounded-full transition-colors hover:bg-blue-50"
                title="View history"
              >
                <svg className="h-2.5 w-2.5 text-blue-400" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="12" r="6" />
                </svg>
              </button>
            )}
            <svg
              className="h-3 w-3 shrink-0 text-gray-300 opacity-0 transition-opacity group-hover:opacity-100"
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </div>
        </div>
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-gray-900">
          {saving ? "Saving\u2026" : display}
        </p>
      </div>
    );
  }

  // Short text: side-by-side
  return (
    <div
      className="group flex cursor-pointer items-center justify-between px-4 py-2.5 transition-colors hover:bg-gray-50"
      onClick={() => setEditing(true)}
    >
      <span className="shrink-0 text-[13px] text-gray-500">{propertyName}</span>
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-gray-900">
          {saving ? "Saving\u2026" : display}
        </span>
        {propertyId && (
          <button
            onClick={(e) => { e.stopPropagation(); onEvidenceClick(); }}
            className="flex h-5 w-5 items-center justify-center rounded-full transition-colors hover:bg-blue-50"
            title="View history"
          >
            <svg className="h-2.5 w-2.5 text-blue-400" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="6" />
            </svg>
          </button>
        )}
        <svg
          className="h-3 w-3 shrink-0 text-gray-300 opacity-0 transition-opacity group-hover:opacity-100"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expandable relationship section (grouped by edge type label)
// ---------------------------------------------------------------------------

type EdgeProperty = {
  property_id: string;
  edge_id: string | null;
  property_type_id: string;
  property_name: string;
  value_type: string;
  value_text: string | null;
  value_number: string | null;
  value_date: Date | string | null;
  value_boolean: boolean | null;
  value_json?: unknown;
};

type EdgeRecord = {
  edge_id: string;
  node_id: string;
  node_type_id: string;
  display_value: string | null;
  properties: EdgeProperty[];
};

type EdgeGroup = {
  label: string;
  direction: "outgoing" | "incoming";
  edgeTypeId: string;
  targetNodeTypeId: string;
  edges: EdgeRecord[];
};

function groupEdges(
  outgoing: any[],
  incoming: any[],
  edgeProperties: EdgeProperty[],
): EdgeGroup[] {
  const propsByEdge = new Map<string, EdgeProperty[]>();
  for (const p of edgeProperties) {
    if (!p.edge_id) continue;
    const arr = propsByEdge.get(p.edge_id) ?? [];
    arr.push(p);
    propsByEdge.set(p.edge_id, arr);
  }

  const groups = new Map<string, EdgeGroup>();
  for (const edge of outgoing) {
    const key = `out:${edge.edge_type_id ?? edge.edge_type_outbound_name}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        label: edge.edge_type_outbound_name,
        direction: "outgoing",
        edgeTypeId: edge.edge_type_id,
        targetNodeTypeId: edge.target_node_type_id,
        edges: [],
      };
      groups.set(key, g);
    }
    g.edges.push({
      edge_id: edge.edge_id,
      node_id: edge.target_node_id,
      node_type_id: edge.target_node_type_id,
      display_value: edge.target_display_value,
      properties: propsByEdge.get(edge.edge_id) ?? [],
    });
  }
  for (const edge of incoming) {
    const key = `in:${edge.edge_type_id ?? edge.edge_type_inbound_name}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        label: edge.edge_type_inbound_name,
        direction: "incoming",
        edgeTypeId: edge.edge_type_id,
        targetNodeTypeId: edge.source_node_type_id,
        edges: [],
      };
      groups.set(key, g);
    }
    g.edges.push({
      edge_id: edge.edge_id,
      node_id: edge.source_node_id,
      node_type_id: edge.source_node_type_id,
      display_value: edge.source_display_value,
      properties: propsByEdge.get(edge.edge_id) ?? [],
    });
  }
  return Array.from(groups.values());
}

// Inline edge property row — mirrors EditableEdgePropertyRow from edges/[id]/page
function InlineEdgePropertyRow({
  propertyName,
  propertyId,
  propertyTypeId,
  edgeId,
  valueType,
  valueText,
  valueNumber,
  valueDate,
  valueBoolean,
  enumValues,
  onEvidenceClick,
  onSaved,
}: {
  propertyName: string;
  propertyId: string | null;
  propertyTypeId: string;
  edgeId: string;
  valueType: string;
  valueText: string | null;
  valueNumber: string | null;
  valueDate: Date | string | null;
  valueBoolean: boolean | null;
  enumValues?: string[] | null;
  onEvidenceClick: () => void;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const editProperty = trpc.views.knowledge.graph.createUserEdit.useMutation();
  const createEdgeProperty = trpc.views.knowledge.graph.createEdgeProperty.useMutation();

  const currentValue = valueText ?? valueNumber ?? valueBoolean ?? valueDate ?? null;
  const display = formatValue(
    typeof valueDate === "object" && valueDate
      ? (valueDate.toISOString?.() ?? String(valueDate))
      : (currentValue as string | number | boolean | null),
    valueType,
  );

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if ("select" in inputRef.current) inputRef.current.select();
    }
  }, [editing]);

  const handleSave = async (rawValue: string) => {
    setSaving(true);
    try {
      const valuePayload =
        valueType === "boolean"
          ? { valueBoolean: rawValue === "true" }
          : valueType === "number"
            ? { valueNumber: rawValue || null }
            : valueType === "date"
              ? { valueDate: rawValue || null }
              : { valueText: rawValue || null };

      if (propertyId) {
        await editProperty.mutateAsync({
          propertyId,
          description: "Manual edit",
          ...valuePayload,
        });
      } else {
        await createEdgeProperty.mutateAsync({
          edgeId,
          propertyTypeId,
          ...valuePayload,
        });
      }
      onSaved();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    const initialValue = (() => {
      if (valueType === "boolean") return String(valueBoolean ?? "false");
      if (valueType === "number") return valueNumber ?? "";
      if (valueType === "date") {
        if (!valueDate) return "";
        const dt = typeof valueDate === "string" ? new Date(valueDate) : valueDate;
        return dt.toISOString().slice(0, 10);
      }
      return valueText ?? "";
    })();

    if (valueType === "boolean" || (enumValues && enumValues.length > 0)) {
      const options =
        valueType === "boolean"
          ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }]
          : (enumValues ?? []).map((v) => ({ value: v, label: v }));

      return (
        <div className="flex items-center justify-between py-1">
          <span className="text-[12px] text-gray-500">{propertyName}</span>
          <select
            defaultValue={initialValue}
            disabled={saving}
            onChange={(e) => handleSave(e.target.value)}
            onBlur={() => setEditing(false)}
            autoFocus
            className="rounded border border-primary/40 bg-transparent px-1.5 py-0.5 text-[12px] text-gray-900 outline-none"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-between py-1">
        <span className="text-[12px] text-gray-500">{propertyName}</span>
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type={valueType === "date" ? "date" : valueType === "number" ? "number" : "text"}
          defaultValue={initialValue}
          disabled={saving}
          className="w-32 rounded border border-primary/40 bg-transparent px-1.5 py-0.5 text-right text-[12px] text-gray-900 outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave(e.currentTarget.value);
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={(e) => { if (!saving) handleSave(e.currentTarget.value); }}
        />
      </div>
    );
  }

  return (
    <div
      className="group/prop flex cursor-pointer items-center justify-between py-1 transition-colors hover:bg-gray-50"
      onClick={() => setEditing(true)}
    >
      <span className="text-[12px] text-gray-500">{propertyName}</span>
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] text-gray-900">{saving ? "Saving\u2026" : display}</span>
        {propertyId && (
          <button
            onClick={(e) => { e.stopPropagation(); onEvidenceClick(); }}
            className="flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-blue-50"
            title="View history"
          >
            <svg className="h-2 w-2 text-blue-400" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="6" />
            </svg>
          </button>
        )}
        <svg
          className="h-2.5 w-2.5 shrink-0 text-gray-300 opacity-0 transition-opacity group-hover/prop:opacity-100"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </div>
    </div>
  );
}

function RelationshipGroup({
  group,
  nodeId,
  ontology,
  edgePropertyTypes,
  onNavigate,
  onDeleted,
  onEvidenceClick,
}: {
  group: EdgeGroup;
  nodeId: string;
  ontology: { nodeTypes: Array<{ id: string; name: string; icon_svg: string | null }> } | undefined;
  edgePropertyTypes: Array<{ id: string; edge_type_id: string | null; name: string; value_type: string; enum_values: string[] | null }>;
  onNavigate: (nodeId: string) => void;
  onDeleted: () => void;
  onEvidenceClick: (propertyId: string, propertyName: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [expandedEdges, setExpandedEdges] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [deletingEdgeId, setDeletingEdgeId] = useState<string | null>(null);
  const deleteEdge = trpc.views.knowledge.graph.deleteEdge.useMutation();
  const createEdge = trpc.views.knowledge.graph.createEdge.useMutation();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const propertyTypesForEdge = edgePropertyTypes.filter(
    (pt) => pt.edge_type_id === group.edgeTypeId,
  );
  const hasEdgeProperties = propertyTypesForEdge.length > 0;

  const { data: searchResults } =
    trpc.views.knowledge.graph.searchNodes.useQuery(
      {
        nodeTypeId: group.targetNodeTypeId,
        search: searchQuery,
        excludeIds: group.edges.map((e) => e.node_id),
      },
      { enabled: adding && searchQuery.length > 0 },
    );

  const handleDelete = async (edgeId: string) => {
    setDeletingEdgeId(edgeId);
    try {
      await deleteEdge.mutateAsync({ id: edgeId });
      onDeleted();
    } finally {
      setDeletingEdgeId(null);
    }
  };

  const handleAdd = async (targetNodeId: string) => {
    const sourceNodeId = group.direction === "outgoing" ? nodeId : targetNodeId;
    const targetId = group.direction === "outgoing" ? targetNodeId : nodeId;
    await createEdge.mutateAsync({
      edgeTypeId: group.edgeTypeId,
      sourceNodeId: sourceNodeId,
      targetNodeId: targetId,
    });
    setAdding(false);
    setSearchQuery("");
    onDeleted();
  };

  const toggleEdgeExpand = (edgeId: string) => {
    setExpandedEdges((prev) => {
      const next = new Set(prev);
      if (next.has(edgeId)) next.delete(edgeId);
      else next.add(edgeId);
      return next;
    });
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center justify-between px-4 py-2">
        <button
          className="flex items-center gap-1 text-left"
          onClick={() => setExpanded(!expanded)}
        >
          <svg
            className={`h-3 w-3 text-gray-400 transition-transform ${expanded ? "rotate-90" : ""}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="text-[12px] font-medium text-gray-600">
            {group.label}
            <span className="ml-1.5 text-gray-400">({group.edges.length})</span>
          </span>
        </button>
        <button
          onClick={() => { setAdding(true); setTimeout(() => searchInputRef.current?.focus(), 0); }}
          className="rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          title="Add relationship"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
      {expanded && (
        <div className="border-t border-gray-100">
          {group.edges.map((edge) => {
            const isEdgeExpanded = expandedEdges.has(edge.edge_id);
            return (
              <div
                key={edge.edge_id}
                className="border-t border-gray-50 first:border-t-0"
              >
                <div className="group flex items-center">
                  <button
                    onClick={() => onNavigate(edge.node_id)}
                    className="flex flex-1 items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-gray-50"
                  >
                    <NodeIcon
                      nodeTypeId={edge.node_type_id}
                      iconSvg={ontology?.nodeTypes.find((n) => n.id === edge.node_type_id)?.icon_svg ?? null}
                      size={14}
                      className="text-gray-400"
                    />
                    <span className="text-[13px] text-gray-800">
                      {edge.display_value ?? edge.node_id.slice(0, 8)}
                    </span>
                  </button>
                  <div className="flex items-center gap-0.5 pr-2">
                    {hasEdgeProperties && (
                      <button
                        onClick={() => toggleEdgeExpand(edge.edge_id)}
                        className={`rounded p-1 text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-500 ${isEdgeExpanded ? "text-gray-500" : ""}`}
                        title={isEdgeExpanded ? "Hide properties" : "Show properties"}
                      >
                        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="1" />
                          <circle cx="19" cy="12" r="1" />
                          <circle cx="5" cy="12" r="1" />
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(edge.edge_id)}
                      disabled={deletingEdgeId === edge.edge_id}
                      className="rounded p-1 text-gray-300 opacity-0 transition-all hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 disabled:opacity-50"
                      title="Remove relationship"
                    >
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>
                {isEdgeExpanded && hasEdgeProperties && (
                  <div className="border-t border-gray-50 bg-gray-50/50 px-6 py-1.5">
                    {propertyTypesForEdge.map((pt) => {
                      const prop = edge.properties.find(
                        (p) => p.property_type_id === pt.id,
                      );
                      return (
                        <InlineEdgePropertyRow
                          key={pt.id}
                          propertyName={pt.name}
                          propertyId={prop?.property_id ?? null}
                          propertyTypeId={pt.id}
                          edgeId={edge.edge_id}
                          valueType={pt.value_type}
                          valueText={prop?.value_text ?? null}
                          valueNumber={prop?.value_number ?? null}
                          valueDate={prop?.value_date ?? null}
                          valueBoolean={prop?.value_boolean ?? null}
                          enumValues={pt.enum_values}
                          onEvidenceClick={() => {
                            if (prop) onEvidenceClick(prop.property_id, pt.name);
                          }}
                          onSaved={onDeleted}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {adding && (
            <div className="border-t border-gray-50 px-4 py-2">
              <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-2.5 py-1">
                <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search nodes..."
                  className="flex-1 bg-transparent text-[13px] text-gray-900 outline-none placeholder:text-gray-400"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { setAdding(false); setSearchQuery(""); }
                  }}
                />
                <button
                  onClick={() => { setAdding(false); setSearchQuery(""); }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              {searchResults && searchResults.length > 0 && (
                <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-gray-200 bg-white">
                  {searchResults.map((result: { id: string; display_value: string | null }) => (
                    <button
                      key={result.id}
                      onClick={() => handleAdd(result.id)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-gray-700 transition-colors hover:bg-gray-50"
                    >
                      <NodeIcon
                        nodeTypeId={group.targetNodeTypeId}
                        iconSvg={ontology?.nodeTypes.find((n) => n.id === group.targetNodeTypeId)?.icon_svg ?? null}
                        size={12}
                        className="text-gray-400"
                      />
                      {result.display_value ?? result.id.slice(0, 8)}
                    </button>
                  ))}
                </div>
              )}
              {searchQuery && searchResults && searchResults.length === 0 && (
                <p className="mt-1 px-1 text-[12px] text-gray-400">No results</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relationships section wrapper with "Add Relationship" for new edge types
// ---------------------------------------------------------------------------

type OntologySummary = {
  nodeTypes: Array<{ id: string; name: string; icon_svg: string | null }>;
  edgeTypes?: Array<{
    id: string;
    outbound_name: string;
    inbound_name: string;
    source_node_type_id: string;
    target_node_type_id: string;
  }>;
  propertyTypes?: Array<{
    id: string;
    node_type_id: string | null;
    edge_type_id: string | null;
    name: string;
    value_type: string;
    enum_values: string[] | null;
  }>;
};

function RelationshipsSection({
  nodeId,
  nodeTypeId,
  edgeGroups,
  ontology,
  onNavigate,
  onChanged,
  onEvidenceClick,
}: {
  nodeId: string;
  nodeTypeId: string;
  edgeGroups: EdgeGroup[];
  ontology: OntologySummary | undefined;
  onNavigate: (nodeId: string) => void;
  onChanged: () => void;
  onEvidenceClick: (propertyId: string, propertyName: string) => void;
}) {
  const [addingNewType, setAddingNewType] = useState(false);
  const [selectedEdgeType, setSelectedEdgeType] = useState<{
    id: string;
    label: string;
    direction: "outgoing" | "incoming";
    targetNodeTypeId: string;
  } | null>(null);
  const [newSearchQuery, setNewSearchQuery] = useState("");
  const newSearchRef = useRef<HTMLInputElement>(null);
  const createEdge = trpc.views.knowledge.graph.createEdge.useMutation();

  const edgePropertyTypes = (ontology?.propertyTypes ?? []).filter(
    (pt) => pt.edge_type_id != null,
  );

  // Compute available edge types for this node that aren't already shown
  const existingEdgeTypeIds = new Set(edgeGroups.map((g) => g.edgeTypeId));
  const availableEdgeTypes = useMemo(() => {
    if (!ontology?.edgeTypes) return [];
    return ontology.edgeTypes
      .filter((et) => {
        const isSource = et.source_node_type_id === nodeTypeId;
        const isTarget = et.target_node_type_id === nodeTypeId;
        return isSource || isTarget;
      })
      .filter((et) => !existingEdgeTypeIds.has(et.id))
      .map((et) => {
        const isSource = et.source_node_type_id === nodeTypeId;
        return {
          id: et.id,
          label: isSource ? et.outbound_name : et.inbound_name,
          direction: isSource ? "outgoing" as const : "incoming" as const,
          targetNodeTypeId: isSource ? et.target_node_type_id : et.source_node_type_id,
        };
      });
  }, [ontology?.edgeTypes, nodeTypeId, existingEdgeTypeIds]);

  const { data: newSearchResults } =
    trpc.views.knowledge.graph.searchNodes.useQuery(
      {
        nodeTypeId: selectedEdgeType?.targetNodeTypeId ?? "",
        search: newSearchQuery,
      },
      { enabled: !!selectedEdgeType && newSearchQuery.length > 0 },
    );

  const handleAddNew = async (targetNodeId: string) => {
    if (!selectedEdgeType) return;
    const sourceNodeId = selectedEdgeType.direction === "outgoing" ? nodeId : targetNodeId;
    const targetId = selectedEdgeType.direction === "outgoing" ? targetNodeId : nodeId;
    await createEdge.mutateAsync({
      edgeTypeId: selectedEdgeType.id,
      sourceNodeId,
      targetNodeId: targetId,
    });
    setAddingNewType(false);
    setSelectedEdgeType(null);
    setNewSearchQuery("");
    onChanged();
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
          Relationships
        </h2>
        {availableEdgeTypes.length > 0 && (
          <button
            onClick={() => setAddingNewType(!addingNewType)}
            className="rounded px-1.5 py-0.5 text-[11px] text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            + Add
          </button>
        )}
      </div>
      <div className="space-y-2">
        {edgeGroups.map((group) => (
          <RelationshipGroup
            key={`${group.direction}:${group.edgeTypeId}`}
            group={group}
            nodeId={nodeId}
            ontology={ontology}
            edgePropertyTypes={edgePropertyTypes}
            onNavigate={onNavigate}
            onDeleted={onChanged}
            onEvidenceClick={onEvidenceClick}
          />
        ))}
        {edgeGroups.length === 0 && !addingNewType && (
          <p className="px-1 text-[13px] italic text-gray-400">No relationships</p>
        )}
        {addingNewType && (
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            {!selectedEdgeType ? (
              <div>
                <p className="mb-2 text-[12px] font-medium text-gray-600">Select relationship type</p>
                <div className="space-y-1">
                  {availableEdgeTypes.map((et) => (
                    <button
                      key={et.id}
                      onClick={() => {
                        setSelectedEdgeType(et);
                        setTimeout(() => newSearchRef.current?.focus(), 0);
                      }}
                      className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-[13px] text-gray-700 transition-colors hover:bg-gray-50"
                    >
                      <span>{et.label}</span>
                      <span className="text-[11px] text-gray-400">
                        {ontology?.nodeTypes.find((n) => n.id === et.targetNodeTypeId)?.name}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[12px] font-medium text-gray-600">
                    {selectedEdgeType.label}
                  </span>
                  <button
                    onClick={() => { setSelectedEdgeType(null); setNewSearchQuery(""); }}
                    className="text-[11px] text-gray-400 hover:text-gray-600"
                  >
                    Back
                  </button>
                </div>
                <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-2.5 py-1">
                  <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    ref={newSearchRef}
                    type="text"
                    value={newSearchQuery}
                    onChange={(e) => setNewSearchQuery(e.target.value)}
                    placeholder="Search nodes..."
                    className="flex-1 bg-transparent text-[13px] text-gray-900 outline-none placeholder:text-gray-400"
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { setAddingNewType(false); setSelectedEdgeType(null); setNewSearchQuery(""); }
                    }}
                  />
                </div>
                {newSearchResults && newSearchResults.length > 0 && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-gray-200 bg-white">
                    {newSearchResults.map((result: { id: string; display_value: string | null }) => (
                      <button
                        key={result.id}
                        onClick={() => handleAddNew(result.id)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-gray-700 transition-colors hover:bg-gray-50"
                      >
                        <NodeIcon
                          nodeTypeId={selectedEdgeType.targetNodeTypeId}
                          iconSvg={ontology?.nodeTypes.find((n) => n.id === selectedEdgeType.targetNodeTypeId)?.icon_svg ?? null}
                          size={12}
                          className="text-gray-400"
                        />
                        {result.display_value ?? result.id.slice(0, 8)}
                      </button>
                    ))}
                  </div>
                )}
                {newSearchQuery && newSearchResults && newSearchResults.length === 0 && (
                  <p className="mt-1 px-1 text-[12px] text-gray-400">No results</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sources section
// ---------------------------------------------------------------------------

function SourcesSection({ nodeId }: { nodeId: string }) {
  const { data: sources, isLoading } =
    trpc.views.knowledge.graph.getLinkedResources.useQuery({ nodeId });
  const [expanded, setExpanded] = useState(true);
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());

  const toggleSource = (id: string) => {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (isLoading) {
    return (
      <section>
        <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gray-400">Sources</h2>
        <div className="h-12 animate-pulse rounded-lg bg-gray-50" />
      </section>
    );
  }

  if (!sources || sources.length === 0) return null;

  return (
    <section>
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gray-400">
        Sources
      </h2>
      <div className="rounded-lg border border-gray-200 bg-white">
        <button
          className="flex w-full items-center justify-between px-4 py-2 text-left"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-[12px] font-medium text-gray-600">
            Sources
            <span className="ml-1.5 text-gray-400">({sources.length})</span>
          </span>
          <svg
            className={`h-3 w-3 text-gray-400 transition-transform ${expanded ? "rotate-90" : ""}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        {expanded && (
          <div className="border-t border-gray-100">
            {sources.map((src: any) => {
              const isOpen = expandedSources.has(src.id);
              const content = src.raw_text as string | null;
              return (
                <div
                  key={src.id}
                  className="border-t border-gray-50 px-4 py-2 first:border-t-0"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                      {RESOURCE_TYPE_LABELS[src.type] ?? src.type}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-gray-800">
                        {src.name}
                      </span>
                      {src.url && (
                        <a
                          href={src.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-[11px] text-blue-500 hover:underline"
                        >
                          {src.url}
                        </a>
                      )}
                    </div>
                    <span className="shrink-0 text-[10px] text-gray-400">
                      {new Date(src.created_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    {content && (
                      <button
                        onClick={() => toggleSource(src.id)}
                        className="shrink-0 text-[11px] font-medium text-blue-500 hover:text-blue-600"
                      >
                        {isOpen ? "Hide" : "View"}
                      </button>
                    )}
                  </div>
                  {isOpen && content && (
                    <div className="mt-2 max-h-60 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2">
                      <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-gray-600">
                        {content.length > 5000
                          ? content.slice(0, 5000) + "\u2026"
                          : content}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Linked objects section
// ---------------------------------------------------------------------------

const LO_SOURCE_LABELS: Record<string, string> = {
  retrieval: "Retrieval",
  output: "Output",
  manual: "Manual",
};

const LO_SOURCE_COLORS: Record<string, string> = {
  retrieval: "bg-blue-100 text-blue-700",
  output: "bg-green-100 text-green-700",
  manual: "bg-purple-100 text-purple-700",
};

function getLinkedObjectDisplayName(lo: { data?: unknown; external_id: string; external_object_type?: string | null }): string {
  const data = lo.data as Record<string, unknown> | null;
  if (data) {
    if (typeof data.name === "string" && data.name) return data.name;
    if (typeof data.title === "string" && data.title) return data.title;
    const firstString = Object.values(data).find(
      (v) => typeof v === "string" && v.length > 0 && v !== data.url,
    );
    if (firstString) return firstString as string;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(lo.external_id)) {
    return lo.external_object_type ?? "Linked record";
  }
  return lo.external_id;
}

const ADAPTER_LABELS: Record<string, string> = {
  "native-valuations": "KIPP Valuations",
  "kg": "KIPP",
  attio: "Attio",
  affinity: "Affinity",
};

function prettyAdapterLabel(adapterType: string | null | undefined): string {
  if (!adapterType) return "";
  if (ADAPTER_LABELS[adapterType]) return ADAPTER_LABELS[adapterType];
  return adapterType
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function prettyObjectType(
  adapterType: string | null | undefined,
  externalObjectType: string | null | undefined,
): string | null {
  if (!externalObjectType) return null;
  // Strip the adapter prefix the TG framework stamps onto type ids (e.g.
  // `native-valuations:legal_entity` → `legal_entity`).
  const stripped =
    adapterType && externalObjectType.startsWith(`${adapterType}:`)
      ? externalObjectType.slice(adapterType.length + 1)
      : externalObjectType;
  // Hide raw UUIDs — adapters that haven't filled a friendly type yet
  // leave Attio object UUIDs here.
  if (/^[0-9a-f]{8}[- ]/i.test(stripped)) return null;
  return stripped
    .split(/[_\s]+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function getLinkedObjectUrl(lo: {
  data?: unknown;
  adapter_type?: string | null;
  external_object_type?: string | null;
}): string | null {
  const data = lo.data as Record<string, unknown> | null;
  if (typeof data?.url === "string" && data.url) return data.url;
  // Valuations legal_entity records don't surface their own URL in the
  // payload — synthesize the portfolio-page link from the slug. The
  // external_object_type comes through as the TG framework's typeId
  // (`native-valuations:legal_entity`), not the bare table name.
  if (
    lo.adapter_type === "native-valuations" &&
    (lo.external_object_type === "native-valuations:legal_entity" ||
      lo.external_object_type === "legal_entity") &&
    typeof data?.slug === "string" &&
    data.slug
  ) {
    if (typeof window === "undefined") return null;
    return `${window.location.origin}/portfolio/c/${encodeURIComponent(data.slug)}`;
  }
  return null;
}

function LinkedObjectsSection({ nodeId }: { nodeId: string }) {
  const { data: linkedObjects, isLoading } =
    trpc.views.knowledge.graph.getLinkedObjects.useQuery({ nodeId });
  const [sectionExpanded, setSectionExpanded] = useState(true);
  const [expandedFields, setExpandedFields] = useState<Record<string, boolean>>({});

  if (isLoading) {
    return (
      <section>
        <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gray-400">Linked Objects</h2>
        <div className="h-12 animate-pulse rounded-lg bg-gray-50" />
      </section>
    );
  }

  if (!linkedObjects || linkedObjects.length === 0) return null;

  return (
    <section>
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gray-400">
        Linked Objects
      </h2>
      <div className="rounded-lg border border-gray-200 bg-white">
        <button
          className="flex w-full items-center justify-between px-4 py-2 text-left"
          onClick={() => setSectionExpanded(!sectionExpanded)}
        >
          <span className="text-[12px] font-medium text-gray-600">
            Linked Objects
            <span className="ml-1.5 text-gray-400">({linkedObjects.length})</span>
          </span>
          <svg
            className={`h-3 w-3 text-gray-400 transition-transform ${sectionExpanded ? "rotate-90" : ""}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        {sectionExpanded && (
          <div className="border-t border-gray-100">
            {linkedObjects.map((lo: any) => {
              const displayName = getLinkedObjectDisplayName(lo);
              const url = getLinkedObjectUrl(lo);
              const systemLabel = [
                prettyAdapterLabel(lo.adapter_type),
                prettyObjectType(lo.adapter_type, lo.external_object_type),
              ].filter(Boolean).join(" \u00b7 ");
              const data = (lo.data ?? {}) as Record<string, unknown>;
              const dataEntries = Object.entries(data).filter(([key]) => key !== "url");
              const hasData = dataEntries.length > 0;

              return (
                <div
                  key={lo.id}
                  className="border-t border-gray-50 px-4 py-2.5 first:border-t-0"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium text-gray-500">
                        {systemLabel}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${LO_SOURCE_COLORS[lo.source] ?? "bg-gray-100 text-gray-600"}`}
                      >
                        {LO_SOURCE_LABELS[lo.source] ?? lo.source}
                      </span>
                    </div>
                    <span className="text-[10px] text-gray-400">
                      {new Date(lo.updated_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                  <div className="mt-1 text-[13px] font-medium text-gray-800">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {displayName}
                      </a>
                    ) : (
                      displayName
                    )}
                  </div>
                  {hasData && (
                    <div className="mt-1">
                      <button
                        onClick={() =>
                          setExpandedFields((e) => ({ ...e, [lo.id]: !e[lo.id] }))
                        }
                        className="text-[10px] text-gray-400 hover:text-gray-600"
                      >
                        {expandedFields[lo.id]
                          ? "Hide fields"
                          : `${dataEntries.length} field${dataEntries.length !== 1 ? "s" : ""}`}
                      </button>
                      {expandedFields[lo.id] && (
                        <div className="mt-1 space-y-0.5">
                          {dataEntries.map(([key, val]) => (
                            <div
                              key={key}
                              className="flex justify-between text-[11px]"
                            >
                              <span className="text-gray-500">{key}</span>
                              <span className="max-w-[60%] truncate text-right text-gray-700">
                                {String(val)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function NodePage() {
  const { id: nodeId } = useParams<{ id: string }>();
  const router = useRouter();
  const [evidencePropertyId, setEvidencePropertyId] = useState<string | null>(null);
  const [evidencePropertyName, setEvidencePropertyName] = useState<string>("");

  const utils = trpc.useUtils();
  const { data: node, isLoading } =
    trpc.views.knowledge.graph.getNode.useQuery({ id: nodeId });
  const { data: ontology } =
    trpc.views.knowledge.ontology.getOntologySummary.useQuery();

  // A single record: when data changes (any source), refetch this node
  // and its relationships — no rows to reorder, so auto-refresh is
  // unobtrusive. If the node was merged away the query simply 404s into
  // the existing "doesn't exist" state.
  //
  // Coalesce a burst (a bulk write / pipeline run fires several change
  // events) into one refetch with a short debounce.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);
  trpc.views.knowledge.ontology.onResourceChange.useSubscription(
    { kinds: ["kg-data"] },
    {
      onData: (evt) => {
        if (evt.originId === TAB_ORIGIN_ID) return; // our own edit — already shown
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => {
          void utils.views.knowledge.graph.getNode.invalidate({ id: nodeId });
          void utils.views.knowledge.graph.getLinkedObjects.invalidate({ nodeId });
          void utils.views.knowledge.graph.getLinkedResources.invalidate({ nodeId });
        }, 400);
      },
    },
  );

  const propertyTypes = node
    ? ontology?.propertyTypes?.filter(
        (pt) => pt.node_type_id === node.node_type_id,
      )
    : undefined;

  const edgeGroups = useMemo(
    () => node ? groupEdges(node.outgoingEdges, node.incomingEdges, node.edgeProperties) : [],
    [node],
  );

  const displayName =
    node?.display_value ??
    node?.properties.find((p) => {
      const pt = propertyTypes?.find((col) => col.id === p.property_type_id);
      return pt?.identity === "unique" || pt?.identity === "fuzzy";
    })?.value_text ??
    node?.properties[0]?.value_text ??
    nodeId.slice(0, 8);

  usePageTitle(node ? `${displayName} \u2014 KIPP` : "KIPP");

  const invalidate = () => {
    utils.views.knowledge.graph.getNode.invalidate({ id: nodeId });
    utils.views.knowledge.graph.getNodeChanges.invalidate({ nodeId });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-primary" />
      </div>
    );
  }

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[14px] text-gray-400">Node not found</p>
      </div>
    );
  }

  const nodeTypeIcon =
    ontology?.nodeTypes.find((n) => n.id === node.node_type_id)?.icon_svg ?? null;

  return (
    <div className="flex h-full">
      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-gray-200 bg-white px-6">
          <button
            onClick={() => router.back()}
            className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <NodeIcon
            nodeTypeId={node.node_type_id}
            iconSvg={nodeTypeIcon}
            size={18}
            className="text-gray-500"
          />
          <h1 className="text-base font-semibold text-gray-900">
            {displayName}
          </h1>
          <span className="text-[12px] text-gray-400">{node.node_type_name}</span>
        </div>

        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          {/* Properties */}
          <section>
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gray-400">
              Properties
            </h2>
            <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
              {propertyTypes && propertyTypes.length > 0 ? (
                propertyTypes.map((pt) => {
                  const prop = node.properties.find(
                    (p) => p.property_type_id === pt.id,
                  );
                  return (
                    <EditablePropertyRow
                      key={pt.id}
                      propertyName={pt.name}
                      propertyId={prop?.property_id ?? null}
                      propertyTypeId={pt.id}
                      nodeId={nodeId}
                      valueType={pt.value_type}
                      valueText={prop?.value_text ?? null}
                      valueNumber={prop?.value_number ?? null}
                      valueDate={prop?.value_date ?? null}
                      valueBoolean={prop?.value_boolean ?? null}
                      enumValues={pt.enum_values}
                      onEvidenceClick={() => {
                        if (prop) {
                          setEvidencePropertyId(prop.property_id);
                          setEvidencePropertyName(pt.name);
                        }
                      }}
                      onSaved={invalidate}
                    />
                  );
                })
              ) : node.properties.length > 0 ? (
                node.properties.map((prop) => (
                  <EditablePropertyRow
                    key={prop.property_id}
                    propertyName={prop.property_name}
                    propertyId={prop.property_id}
                    propertyTypeId={prop.property_type_id}
                    nodeId={nodeId}
                    valueType={prop.value_type}
                    valueText={prop.value_text}
                    valueNumber={prop.value_number}
                    valueDate={prop.value_date}
                    valueBoolean={prop.value_boolean}
                    onEvidenceClick={() => {
                      setEvidencePropertyId(prop.property_id);
                      setEvidencePropertyName(prop.property_name);
                    }}
                    onSaved={invalidate}
                  />
                ))
              ) : (
                <p className="px-4 py-3 text-[13px] italic text-gray-400">
                  No properties
                </p>
              )}
            </div>
          </section>

          {/* Relationships */}
          <RelationshipsSection
            nodeId={nodeId}
            nodeTypeId={node.node_type_id}
            edgeGroups={edgeGroups}
            ontology={ontology}
            onNavigate={(id) => router.push(`/nodes/${id}`)}
            onChanged={invalidate}
            onEvidenceClick={(propertyId, propertyName) => {
              setEvidencePropertyId(propertyId);
              setEvidencePropertyName(propertyName);
            }}
          />

          {/* Sources */}
          <SourcesSection nodeId={nodeId} />

          {/* Linked Objects */}
          <LinkedObjectsSection nodeId={nodeId} />

          {/* Changelog */}
          <ChangelogSection nodeId={nodeId} />

          {/* Metadata */}
          <section>
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gray-400">
              Metadata
            </h2>
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-[13px] text-gray-500">Type</span>
                <span className="text-[13px] text-gray-900">{node.node_type_name}</span>
              </div>
              <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2.5">
                <span className="text-[13px] text-gray-500">Created</span>
                <span className="text-[13px] text-gray-900">
                  {new Date(node.created_at).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2.5">
                <span className="text-[13px] text-gray-500">ID</span>
                <span className="font-mono text-[11px] text-gray-400">{nodeId}</span>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* Evidence sidebar */}
      {evidencePropertyId && (
        <EvidenceSidebar
          propertyId={evidencePropertyId}
          propertyName={evidencePropertyName}
          onClose={() => setEvidencePropertyId(null)}
          onRegenerate={invalidate}
        />
      )}
    </div>
  );
}
