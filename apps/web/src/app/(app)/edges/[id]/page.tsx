// full edge page
"use client";

import { useState, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import { NodeIcon } from "@/components/node-icon";
import { EvidenceSidebar } from "@/components/objects/evidence-sidebar";
import { ChangelogSection } from "@/components/objects/changelog";

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

function EditableEdgePropertyRow({
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

    const isLongText = valueType === "text" && String(initialValue).length > 50;

    if (isLongText) {
      return (
        <div className="px-4 py-2.5">
          <span className="mb-1 block text-[13px] text-gray-500">
            {propertyName}
          </span>
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            defaultValue={initialValue}
            disabled={saving}
            rows={3}
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
        <span className="text-[13px] text-gray-500">{propertyName}</span>
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

  return (
    <div
      className="group flex cursor-pointer items-center justify-between px-4 py-2.5 transition-colors hover:bg-gray-50"
      onClick={() => setEditing(true)}
    >
      <span className="text-[13px] text-gray-500">{propertyName}</span>
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-gray-900">
          {saving ? "Saving\u2026" : display}
        </span>
        {propertyId && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEvidenceClick();
            }}
            className="flex h-5 w-5 items-center justify-center rounded-full transition-colors hover:bg-blue-50"
            title="View evidence"
          >
            <svg className="h-2.5 w-2.5 text-blue-400" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="6" />
            </svg>
          </button>
        )}
        <svg
          className="h-3 w-3 shrink-0 text-gray-300 opacity-0 transition-opacity group-hover:opacity-100"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </div>
    </div>
  );
}

export default function EdgePage() {
  const { id: edgeId } = useParams<{ id: string }>();
  const router = useRouter();
  const [evidencePropertyId, setEvidencePropertyId] = useState<string | null>(null);
  const [evidencePropertyName, setEvidencePropertyName] = useState<string>("");

  const utils = trpc.useUtils();
  const { data: edge, isLoading } =
    trpc.views.knowledge.graph.getEdge.useQuery({ edgeId });
  const { data: ontology } =
    trpc.views.knowledge.ontology.getOntologySummary.useQuery();

  usePageTitle(
    edge ? `${edge.outbound_name} \u2014 KIPP` : "KIPP",
  );

  const invalidate = () => {
    utils.views.knowledge.graph.getEdge.invalidate({ edgeId });
    utils.views.knowledge.graph.getEdgeChanges.invalidate({ edgeId });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-primary" />
      </div>
    );
  }

  if (!edge) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[14px] text-gray-400">Edge not found</p>
      </div>
    );
  }

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
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <h1 className="text-base font-semibold text-gray-900">
            {edge.outbound_name}
          </h1>
          <span className="text-[12px] text-gray-400">Relationship</span>
        </div>

        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          {/* Connected nodes */}
          <section>
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gray-400">
              Connected Nodes
            </h2>
            <div className="rounded-lg border border-gray-200 bg-white">
              <button
                onClick={() => router.push(`/nodes/${edge.source_node_id}`)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50"
              >
                <NodeIcon
                  nodeTypeId={edge.source_node_type_id}
                  iconSvg={
                    ontology?.nodeTypes.find(
                      (n) => n.id === edge.source_node_type_id,
                    )?.icon_svg ?? null
                  }
                  size={16}
                  className="text-gray-400"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-gray-900">
                    {edge.source_display_value ?? edge.source_node_id.slice(0, 8)}
                  </div>
                  <div className="text-[11px] text-gray-400">
                    {edge.source_node_type_name}
                  </div>
                </div>
                <svg
                  className="h-3 w-3 text-gray-300"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              <button
                onClick={() => router.push(`/nodes/${edge.target_node_id}`)}
                className="flex w-full items-center gap-3 border-t border-gray-100 px-4 py-3 text-left transition-colors hover:bg-gray-50"
              >
                <NodeIcon
                  nodeTypeId={edge.target_node_type_id}
                  iconSvg={
                    ontology?.nodeTypes.find(
                      (n) => n.id === edge.target_node_type_id,
                    )?.icon_svg ?? null
                  }
                  size={16}
                  className="text-gray-400"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-gray-900">
                    {edge.target_display_value ?? edge.target_node_id.slice(0, 8)}
                  </div>
                  <div className="text-[11px] text-gray-400">
                    {edge.target_node_type_name}
                  </div>
                </div>
                <svg
                  className="h-3 w-3 text-gray-300"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          </section>

          {/* Properties */}
          <section>
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gray-400">
              Properties
            </h2>
            <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
              {edge.propertyTypes.length > 0 ? (
                edge.propertyTypes.map((pt: any) => {
                  const prop = edge.properties.find(
                    (p: any) => p.property_type_id === pt.id,
                  );

                  return (
                    <EditableEdgePropertyRow
                      key={pt.id}
                      propertyName={pt.name}
                      propertyId={prop?.property_id ?? null}
                      propertyTypeId={pt.id}
                      edgeId={edgeId}
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
              ) : edge.properties.length > 0 ? (
                edge.properties.map((prop: any) => (
                  <EditableEdgePropertyRow
                    key={prop.property_id}
                    propertyName={prop.property_name}
                    propertyId={prop.property_id}
                    propertyTypeId={prop.property_type_id}
                    edgeId={edgeId}
                    valueType={prop.value_type ?? "text"}
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

          {/* Changelog */}
          <ChangelogSection edgeId={edgeId} />

          {/* Metadata */}
          <section>
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gray-400">
              Metadata
            </h2>
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-[13px] text-gray-500">Edge type</span>
                <span className="text-[13px] text-gray-900">
                  {edge.outbound_name}
                </span>
              </div>
              <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2.5">
                <span className="text-[13px] text-gray-500">Created</span>
                <span className="text-[13px] text-gray-900">
                  {new Date(edge.created_at).toLocaleDateString(undefined, {
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
                <span className="font-mono text-[11px] text-gray-400">{edgeId}</span>
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
