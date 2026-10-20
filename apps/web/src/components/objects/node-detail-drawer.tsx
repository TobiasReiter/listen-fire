"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { NodeIcon } from "@/components/node-icon";
import { Select, type SelectOption } from "@/components/select";
import { InlineSelect } from "@/components/inline-select";
import { useRouter } from "next/navigation";

function formatValue(
  value: string | number | boolean | null,
  valueType: string,
): string {
  if (value === null || value === undefined) return "—";
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

function formatDate(date: string | Date) {
  return new Date(date).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Property = {
  property_id: string;
  property_type_id: string;
  property_name: string;
  value_type: string;
  value_text: string | null;
  value_number: string | null;
  value_date: Date | string | null;
  value_boolean: boolean | null;
  value_json?: unknown;
};

function EditableProperty({
  prop,
  enumValues,
  onSave,
}: {
  prop: Property;
  enumValues?: string[] | null;
  onSave: (
    propertyId: string,
    value: {
      valueText?: string | null;
      valueNumber?: string | null;
      valueDate?: string | null;
      valueBoolean?: boolean | null;
    },
  ) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const currentValue =
    prop.value_text ??
    prop.value_number ??
    prop.value_boolean ??
    prop.value_date ??
    null;
  const displayValue = formatValue(
    typeof prop.value_date === "object" && prop.value_date
      ? prop.value_date.toISOString?.() ?? String(prop.value_date)
      : (currentValue as string | number | boolean | null),
    prop.value_type,
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
      if (prop.value_type === "boolean") {
        await onSave(prop.property_id, { valueBoolean: rawValue === "true" });
      } else if (prop.value_type === "number") {
        await onSave(prop.property_id, { valueNumber: rawValue || null });
      } else if (prop.value_type === "date") {
        await onSave(prop.property_id, { valueDate: rawValue || null });
      } else {
        await onSave(prop.property_id, { valueText: rawValue || null });
      }
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    const initialValue = (() => {
      if (prop.value_type === "boolean")
        return String(prop.value_boolean ?? "false");
      if (prop.value_type === "number") return prop.value_number ?? "";
      if (prop.value_type === "date") {
        const d = prop.value_date;
        if (!d) return "";
        const dt = typeof d === "string" ? new Date(d) : d;
        return dt.toISOString().slice(0, 10);
      }
      return prop.value_text ?? "";
    })();

    // Shared row wrapper: same layout as display mode (py-0.5, items-baseline, gap-3)
    // Inputs use -my-px to offset border height, keeping row height stable.
    if (
      prop.value_type === "boolean" ||
      (enumValues && enumValues.length > 0)
    ) {
      const options: SelectOption[] =
        prop.value_type === "boolean"
          ? [
              { value: "true", label: "Yes" },
              { value: "false", label: "No" },
            ]
          : (enumValues ?? []).map((v) => ({ value: v, label: v }));

      return (
        <div className="flex items-baseline justify-between gap-4 rounded-md px-0 py-1">
          <span className="shrink-0 text-[12px] text-gray-500">
            {prop.property_name}
          </span>
          <InlineSelect
            value={initialValue}
            disabled={saving}
            onChange={(v) => handleSave(v)}
            options={options}
            align="right"
            textSize="text-[13px]"
          />
        </div>
      );
    }

    // Use textarea for long text values
    const isLongTextEdit =
      prop.value_type === "text" && String(initialValue).length > 30;

    if (isLongTextEdit) {
      return (
        <div className="rounded-md px-0 py-1">
          <span className="mb-0.5 block text-[12px] text-gray-500">
            {prop.property_name}
          </span>
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            defaultValue={initialValue}
            disabled={saving}
            rows={3}
            className="w-full rounded border border-primary/40 bg-transparent p-1.5 text-[13px] leading-snug text-gray-800 outline-none"
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && e.metaKey)
                handleSave(e.currentTarget.value);
            }}
            onBlur={(e) => {
              if (!saving) handleSave(e.currentTarget.value);
            }}
          />
        </div>
      );
    }

    return (
      <div className="flex items-baseline justify-between gap-4 rounded-md px-0 py-1">
        <span className="shrink-0 text-[12px] text-gray-500">
          {prop.property_name}
        </span>
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type={
            prop.value_type === "date"
              ? "date"
              : prop.value_type === "number"
                ? "number"
                : "text"
          }
          defaultValue={initialValue}
          disabled={saving}
          onFocus={(e) => e.currentTarget.select()}
          className="-my-px w-32 border-0 border-b border-b-primary/40 bg-transparent p-0 text-right text-[13px] text-gray-800 outline-none"
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

  const isLongText =
    prop.value_type === "text" &&
    displayValue != null &&
    String(displayValue).length > 30;

  if (isLongText) {
    return (
      <div
        className="group cursor-pointer rounded-md px-0 py-1 transition-colors hover:bg-gray-50"
        onClick={() => setEditing(true)}
      >
        <div className="mb-0.5 flex items-center justify-between">
          <span className="text-[12px] text-gray-500">
            {prop.property_name}
          </span>
          <div className="flex items-center gap-0.5">
            <svg
              className="h-3 w-3 text-gray-300 opacity-0 transition-opacity group-hover:opacity-100"
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
        <span className="text-[13px] leading-snug text-gray-800">
          {saving ? (
            <span className="text-gray-400">Saving...</span>
          ) : (
            displayValue
          )}
        </span>
      </div>
    );
  }

  return (
    <div
      className="group flex cursor-pointer items-center justify-between gap-4 rounded-md px-0 py-1 transition-colors hover:bg-gray-50"
      onClick={() => setEditing(true)}
    >
      <span className="shrink-0 text-[12px] text-gray-500">
        {prop.property_name}
      </span>
      <div className="flex items-center gap-1">
        <span className="truncate text-right text-[13px] font-medium text-gray-900">
          {saving ? (
            <span className="font-normal text-gray-400">Saving...</span>
          ) : (
            displayValue
          )}
        </span>
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

function EmptyPropertyRow({
  propertyType,
  nodeId,
  onCreated,
}: {
  propertyType: PropertyTypeColumn;
  nodeId: string;
  onCreated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const createProperty =
    trpc.views.knowledge.graph.createProperty.useMutation();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editing]);

  const handleSave = async (rawValue: string) => {
    if (!rawValue) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const params: {
        nodeId: string;
        propertyTypeId: string;
        valueText?: string | null;
        valueNumber?: string | null;
        valueDate?: string | null;
        valueBoolean?: boolean | null;
      } = {
        nodeId,
        propertyTypeId: propertyType.id,
      };
      if (propertyType.value_type === "boolean")
        params.valueBoolean = rawValue === "true";
      else if (propertyType.value_type === "number")
        params.valueNumber = rawValue;
      else if (propertyType.value_type === "date") params.valueDate = rawValue;
      else params.valueText = rawValue;

      await createProperty.mutateAsync(params);
      setEditing(false);
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    if (
      propertyType.value_type === "boolean" ||
      (Array.isArray(propertyType.enum_values) && propertyType.enum_values.length > 0)
    ) {
      const options: SelectOption[] =
        propertyType.value_type === "boolean"
          ? [
              { value: "true", label: "Yes" },
              { value: "false", label: "No" },
            ]
          : propertyType.enum_values!.map((v) => ({ value: v, label: v }));

      return (
        <div className="flex items-baseline justify-between gap-4 rounded-md px-0 py-1">
          <span className="shrink-0 text-[12px] text-gray-400">
            {propertyType.name}
          </span>
          <InlineSelect
            value=""
            disabled={saving}
            onChange={(v) => handleSave(v)}
            options={options}
            align="right"
            textSize="text-[13px]"
          />
        </div>
      );
    }

    return (
      <div className="flex items-baseline justify-between gap-4 rounded-md px-0 py-1">
        <span className="shrink-0 text-[12px] text-gray-400">
          {propertyType.name}
        </span>
        <input
          ref={inputRef}
          type={
            propertyType.value_type === "date"
              ? "date"
              : propertyType.value_type === "number"
                ? "number"
                : "text"
          }
          disabled={saving}
          placeholder="Add value..."
          className="-my-px w-32 border-0 border-b border-b-primary/40 bg-transparent p-0 text-right text-[13px] text-gray-800 placeholder:text-gray-400 outline-none"
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
      className="group flex cursor-pointer items-baseline justify-between gap-4 rounded-md px-0 py-1 transition-colors hover:bg-gray-50"
      onClick={() => setEditing(true)}
    >
      <span className="shrink-0 text-[12px] text-gray-400">
        {propertyType.name}
      </span>
      <span className="text-[13px] text-gray-300">
        —
        <svg
          className="ml-1 inline-block h-3 w-3 text-gray-300 opacity-0 transition-opacity group-hover:opacity-100"
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
      </span>
    </div>
  );
}

function AddEdgeDialog({
  nodeId,
  nodeTypeId,
  ontology,
  onClose,
  onAdded,
}: {
  nodeId: string;
  nodeTypeId: string;
  ontology:
    | {
        nodeTypes: Array<{ id: string; name: string; icon_svg: string | null }>;
      }
    | undefined;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [selectedEdgeTypeId, setSelectedEdgeTypeId] = useState("");
  const [searchText, setSearchText] = useState("");
  const [direction, setDirection] = useState<"outgoing" | "incoming">(
    "outgoing",
  );

  const { data: edgeTypes } =
    trpc.views.knowledge.graph.getEdgeTypesForNode.useQuery({ nodeTypeId });
  const createEdge = trpc.views.knowledge.graph.createEdge.useMutation();

  const outgoingTypes = edgeTypes?.outgoing ?? [];
  const incomingTypes = edgeTypes?.incoming ?? [];

  const targetNodeTypeId = (() => {
    if (direction === "outgoing") {
      const et = outgoingTypes.find((e) => e.id === selectedEdgeTypeId);
      return et?.target_node_type_id;
    }
    const et = incomingTypes.find((e) => e.id === selectedEdgeTypeId);
    return et?.source_node_type_id;
  })();

  const { data: candidates } = trpc.views.knowledge.graph.searchNodes.useQuery(
    { nodeTypeId: targetNodeTypeId!, search: searchText, excludeIds: [nodeId] },
    { enabled: !!targetNodeTypeId },
  );

  const handleAdd = async (candidateId: string) => {
    await createEdge.mutateAsync({
      edgeTypeId: selectedEdgeTypeId,
      sourceNodeId: direction === "outgoing" ? nodeId : candidateId,
      targetNodeId: direction === "outgoing" ? candidateId : nodeId,
    });
    onAdded();
    onClose();
  };

  return (
    <div className="border-b border-gray-100 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
          Add Relationship
        </h3>
        <button
          onClick={onClose}
          className="text-[11px] text-gray-400 hover:text-gray-600"
        >
          Cancel
        </button>
      </div>

      <div className="mb-2 flex gap-1">
        <button
          onClick={() => {
            setDirection("outgoing");
            setSelectedEdgeTypeId("");
          }}
          className={`rounded-md px-2 py-1 text-[11px] ${direction === "outgoing" ? "bg-primary text-white" : "bg-gray-100 text-gray-600"}`}
        >
          Outgoing
        </button>
        <button
          onClick={() => {
            setDirection("incoming");
            setSelectedEdgeTypeId("");
          }}
          className={`rounded-md px-2 py-1 text-[11px] ${direction === "incoming" ? "bg-primary text-white" : "bg-gray-100 text-gray-600"}`}
        >
          Incoming
        </button>
      </div>

      <Select
        value={selectedEdgeTypeId}
        onChange={setSelectedEdgeTypeId}
        options={
          direction === "outgoing"
            ? outgoingTypes.map((et) => ({
                value: et.id,
                label: `${et.outbound_name} → ${et.target_node_type_name}`,
              }))
            : incomingTypes.map((et) => ({
                value: et.id,
                label: `${et.inbound_name} ← ${et.source_node_type_name}`,
              }))
        }
        placeholder="Select edge type..."
        size="sm"
        className="mb-2"
      />

      {selectedEdgeTypeId && (
        <>
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search nodes..."
            className="mb-2 w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-[12px] placeholder:text-gray-400 focus:border-primary/40 focus:bg-white focus:outline-none"
            autoFocus
          />
          <div className="max-h-40 overflow-y-auto">
            {candidates?.map((c) => (
              <button
                key={c.id}
                onClick={() => handleAdd(c.id)}
                disabled={createEdge.isLoading}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
              >
                <NodeIcon
                  nodeTypeId={targetNodeTypeId!}
                  iconSvg={
                    ontology?.nodeTypes.find((n) => n.id === targetNodeTypeId)
                      ?.icon_svg ?? null
                  }
                  size={12}
                  className="text-gray-400"
                />
                {c.display_value ?? c.id.slice(0, 8)}
              </button>
            ))}
            {candidates?.length === 0 && (
              <p className="px-2 py-1.5 text-[11px] italic text-gray-400">
                No matches
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MergePanel({
  nodeId,
  nodeTypeId,
  displayName,
  ontology,
  onClose,
  onMerged,
}: {
  nodeId: string;
  nodeTypeId: string;
  displayName: string;
  ontology:
    | {
        nodeTypes: Array<{ id: string; name: string; icon_svg: string | null }>;
      }
    | undefined;
  onClose: () => void;
  onMerged: () => void;
}) {
  const [searchText, setSearchText] = useState("");
  const [selectedCandidate, setSelectedCandidate] = useState<{
    id: string;
    display_value: string | null;
  } | null>(null);

  const mergeNodes = trpc.views.knowledge.graph.mergeNodes.useMutation();
  const { data: candidates } = trpc.views.knowledge.graph.searchNodes.useQuery(
    { nodeTypeId, search: searchText, excludeIds: [nodeId] },
    { enabled: searchText.length > 0 },
  );

  const [error, setError] = useState<string | null>(null);

  const handleMerge = async () => {
    if (!selectedCandidate) return;
    setError(null);
    try {
      await mergeNodes.mutateAsync({
        targetNodeId: nodeId,
        sourceNodeId: selectedCandidate.id,
      });
      onMerged();
      setSelectedCandidate(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed');
    }
  };

  const iconSvg =
    ontology?.nodeTypes.find((n) => n.id === nodeTypeId)?.icon_svg ?? null;

  if (selectedCandidate) {
    return (
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-3">
        <p className="mb-2 text-[12px] text-amber-800">
          Merge{" "}
          <span className="font-medium">
            {selectedCandidate.display_value ??
              selectedCandidate.id.slice(0, 8)}
          </span>{" "}
          into{" "}
          <span className="font-medium">{displayName}</span>? Properties,
          edges, and evidence will be combined.
        </p>
        <div className="flex gap-2">
          <button
            onClick={handleMerge}
            disabled={mergeNodes.isLoading}
            className="rounded-md bg-amber-600 px-3 py-1 text-[12px] font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
          >
            {mergeNodes.isLoading ? "Merging..." : "Merge"}
          </button>
          <button
            onClick={() => setSelectedCandidate(null)}
            className="rounded-md bg-white px-3 py-1 text-[12px] text-gray-600 transition-colors hover:bg-gray-100"
          >
            Back
          </button>
          <button
            onClick={onClose}
            className="rounded-md bg-white px-3 py-1 text-[12px] text-gray-600 transition-colors hover:bg-gray-100"
          >
            Cancel
          </button>
        </div>
        {error && (
          <p className="mt-2 text-[11px] text-red-600">{error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="border-b border-gray-200 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
          Merge Into This Node
        </h3>
        <button
          onClick={onClose}
          className="text-[11px] text-gray-400 hover:text-gray-600"
        >
          Cancel
        </button>
      </div>
      <input
        type="text"
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        placeholder="Search for duplicate..."
        className="mb-2 w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-[12px] placeholder:text-gray-400 focus:border-primary/40 focus:bg-white focus:outline-none"
        autoFocus
      />
      <div className="max-h-40 overflow-y-auto">
        {candidates?.map((c) => (
          <button
            key={c.id}
            onClick={() =>
              setSelectedCandidate({
                id: c.id,
                display_value: c.display_value,
              })
            }
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-gray-700 transition-colors hover:bg-gray-50"
          >
            <NodeIcon
              nodeTypeId={nodeTypeId}
              iconSvg={iconSvg}
              size={12}
              className="text-gray-400"
            />
            {c.display_value ?? c.id.slice(0, 8)}
          </button>
        ))}
        {searchText && candidates?.length === 0 && (
          <p className="px-2 py-1.5 text-[11px] italic text-gray-400">
            No matches
          </p>
        )}
      </div>
    </div>
  );
}

function EmptyEdgePropertyRow({
  propertyType,
  edgeId,
  onCreated,
}: {
  propertyType: PropertyTypeColumn;
  edgeId: string;
  onCreated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const createEdgeProperty =
    trpc.views.knowledge.graph.createEdgeProperty.useMutation();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editing]);

  const handleSave = async (rawValue: string) => {
    if (!rawValue) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const params: {
        edgeId: string;
        propertyTypeId: string;
        valueText?: string | null;
        valueNumber?: string | null;
        valueDate?: string | null;
        valueBoolean?: boolean | null;
      } = {
        edgeId,
        propertyTypeId: propertyType.id,
      };
      if (propertyType.value_type === "boolean")
        params.valueBoolean = rawValue === "true";
      else if (propertyType.value_type === "number")
        params.valueNumber = rawValue;
      else if (propertyType.value_type === "date") params.valueDate = rawValue;
      else params.valueText = rawValue;

      await createEdgeProperty.mutateAsync(params);
      setEditing(false);
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    if (
      propertyType.value_type === "boolean" ||
      (Array.isArray(propertyType.enum_values) && propertyType.enum_values.length > 0)
    ) {
      const options: SelectOption[] =
        propertyType.value_type === "boolean"
          ? [
              { value: "true", label: "Yes" },
              { value: "false", label: "No" },
            ]
          : propertyType.enum_values!.map((v) => ({ value: v, label: v }));

      return (
        <div className="flex items-baseline justify-between gap-4 rounded-md px-0 py-1">
          <span className="shrink-0 text-[12px] text-gray-400">
            {propertyType.name}
          </span>
          <InlineSelect
            value=""
            disabled={saving}
            onChange={(v) => handleSave(v)}
            options={options}
            align="right"
            textSize="text-[13px]"
          />
        </div>
      );
    }

    return (
      <div className="flex items-baseline justify-between gap-4 rounded-md px-0 py-1">
        <span className="shrink-0 text-[12px] text-gray-400">
          {propertyType.name}
        </span>
        <input
          ref={inputRef}
          type={
            propertyType.value_type === "date"
              ? "date"
              : propertyType.value_type === "number"
                ? "number"
                : "text"
          }
          disabled={saving}
          placeholder="Add value..."
          className="-my-px w-32 border-0 border-b border-b-primary/40 bg-transparent p-0 text-right text-[13px] text-gray-800 placeholder:text-gray-400 outline-none"
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
      className="group flex cursor-pointer items-baseline justify-between gap-4 rounded-md px-0 py-1 transition-colors hover:bg-gray-50"
      onClick={() => setEditing(true)}
    >
      <span className="shrink-0 text-[12px] text-gray-400">
        {propertyType.name}
      </span>
      <span className="text-[13px] text-gray-300">
        —
        <svg
          className="ml-1 inline-block h-3 w-3 text-gray-300 opacity-0 transition-opacity group-hover:opacity-100"
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
      </span>
    </div>
  );
}

function ExpandedEdgeDetail({
  edgeId,
  nodeId,
  ontology,
  onClose,
  onNavigate,
  onEdgeChanged,
}: {
  edgeId: string;
  nodeId: string;
  ontology:
    | {
        nodeTypes: Array<{ id: string; name: string; icon_svg: string | null }>;
      }
    | undefined;
  onClose: () => void;
  onNavigate: (nodeId: string) => void;
  onEdgeChanged: () => void;
}) {
  const utils = trpc.useUtils();
  const { data: edge, isLoading } =
    trpc.views.knowledge.graph.getEdge.useQuery({ edgeId });
  const editProperty = trpc.views.knowledge.graph.createUserEdit.useMutation();
  const deleteEdge = trpc.views.knowledge.graph.deleteEdge.useMutation();
  const updateEdgeTarget =
    trpc.views.knowledge.graph.updateEdgeTarget.useMutation();
  const mergeEdgeMut = trpc.views.knowledge.graph.mergeEdge.useMutation();

  const [showRetarget, setShowRetarget] = useState<"source" | "target" | null>(
    null,
  );
  const [retargetSearch, setRetargetSearch] = useState("");
  const [showMergePicker, setShowMergePicker] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  const retargetNodeTypeId =
    showRetarget === "source"
      ? edge?.source_node_type_id
      : edge?.target_node_type_id;
  const retargetExcludeId =
    showRetarget === "source"
      ? edge?.source_node_id
      : edge?.target_node_id;

  const { data: retargetCandidates } =
    trpc.views.knowledge.graph.searchNodes.useQuery(
      {
        nodeTypeId: retargetNodeTypeId!,
        search: retargetSearch,
        excludeIds: retargetExcludeId ? [retargetExcludeId] : [],
      },
      { enabled: !!showRetarget && !!retargetNodeTypeId },
    );

  const { data: edgeEvidence } =
    trpc.views.knowledge.graph.getEdgeEvidence.useQuery(
      { edgeId },
      { enabled: showEvidence },
    );

  const invalidateAll = () => {
    utils.views.knowledge.graph.getEdge.invalidate({ edgeId });
    utils.views.knowledge.graph.getNode.invalidate({ id: nodeId });
    onEdgeChanged();
  };

  const handlePropertySave = async (
    propertyId: string,
    value: {
      valueText?: string | null;
      valueNumber?: string | null;
      valueDate?: string | null;
      valueBoolean?: boolean | null;
    },
  ) => {
    await editProperty.mutateAsync({
      propertyId,
      description: "Edited from UI",
      ...value,
    });
    invalidateAll();
  };

  const handleRetarget = async (newNodeId: string) => {
    if (!showRetarget) return;
    await updateEdgeTarget.mutateAsync({
      edgeId,
      direction: showRetarget,
      newNodeId,
    });
    setShowRetarget(null);
    setRetargetSearch("");
    invalidateAll();
  };

  const handleMerge = async (sourceEdgeId: string) => {
    await mergeEdgeMut.mutateAsync({
      targetEdgeId: edgeId,
      sourceEdgeId,
    });
    setShowMergePicker(false);
    invalidateAll();
  };

  const handleDelete = async () => {
    await deleteEdge.mutateAsync({ id: edgeId });
    onClose();
    onEdgeChanged();
  };

  if (isLoading || !edge) {
    return (
      <div className="ml-4 border-l-2 border-primary/20 pl-3 py-2">
        <div className="h-4 w-32 animate-pulse rounded bg-gray-100" />
      </div>
    );
  }

  const existingPropTypeIds = new Set(
    edge.properties.map((p) => p.property_type_id),
  );
  const missingPropertyTypes = edge.propertyTypes.filter(
    (pt) => !existingPropTypeIds.has(pt.id),
  );

  return (
    <div className="ml-4 border-l-2 border-primary/20 pl-3 py-2 space-y-3">
      {/* Edge properties */}
      {(edge.properties.length > 0 || missingPropertyTypes.length > 0) && (
        <div>
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
            Edge Properties
          </span>
          <div className="mt-1 space-y-0.5">
            {edge.properties.map((prop) => {
              const pt = edge.propertyTypes.find(
                (t) => t.id === prop.property_type_id,
              );
              return (
                <EditableProperty
                  key={prop.property_id}
                  prop={prop}
                  enumValues={pt?.enum_values}
                  onSave={handlePropertySave}
                />
              );
            })}
            {missingPropertyTypes.map((pt) => (
              <EmptyEdgePropertyRow
                key={pt.id}
                propertyType={pt}
                edgeId={edgeId}
                onCreated={invalidateAll}
              />
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-1.5">
        {/* Re-target buttons */}
        {edge.source_node_id !== nodeId && (
          <button
            onClick={() => {
              setShowRetarget(showRetarget === "source" ? null : "source");
              setShowMergePicker(false);
              setRetargetSearch("");
            }}
            className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
              showRetarget === "source"
                ? "bg-primary/10 text-primary"
                : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            Change source
          </button>
        )}
        {edge.target_node_id !== nodeId && (
          <button
            onClick={() => {
              setShowRetarget(showRetarget === "target" ? null : "target");
              setShowMergePicker(false);
              setRetargetSearch("");
            }}
            className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
              showRetarget === "target"
                ? "bg-primary/10 text-primary"
                : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            Change target
          </button>
        )}
        {edge.duplicates.length > 0 && (
          <button
            onClick={() => {
              setShowMergePicker(!showMergePicker);
              setShowRetarget(null);
            }}
            className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
              showMergePicker
                ? "bg-amber-100 text-amber-700"
                : "bg-amber-50 text-amber-600 hover:bg-amber-100"
            }`}
          >
            Merge ({edge.duplicates.length} duplicate{edge.duplicates.length > 1 ? "s" : ""})
          </button>
        )}
        <button
          onClick={() => setShowEvidence(!showEvidence)}
          className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
            showEvidence
              ? "bg-gray-200 text-gray-700"
              : "bg-gray-100 text-gray-500 hover:bg-gray-200"
          }`}
        >
          Evidence
        </button>
        <button
          onClick={handleDelete}
          disabled={deleteEdge.isLoading}
          className="rounded px-2 py-0.5 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
        >
          Delete
        </button>
      </div>

      {/* Re-target panel */}
      {showRetarget && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-2">
          <input
            type="text"
            value={retargetSearch}
            onChange={(e) => setRetargetSearch(e.target.value)}
            placeholder={`Search ${showRetarget === "source" ? edge.source_node_type_name : edge.target_node_type_name}...`}
            className="mb-1.5 w-full rounded border border-gray-200 bg-white px-2 py-1 text-[12px] placeholder:text-gray-400 focus:border-primary/40 focus:outline-none"
            autoFocus
          />
          <div className="max-h-32 overflow-y-auto">
            {retargetCandidates?.map((c) => (
              <button
                key={c.id}
                onClick={() => handleRetarget(c.id)}
                disabled={updateEdgeTarget.isLoading}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-gray-700 hover:bg-gray-100 disabled:opacity-50"
              >
                <NodeIcon
                  nodeTypeId={retargetNodeTypeId!}
                  iconSvg={
                    ontology?.nodeTypes.find((n) => n.id === retargetNodeTypeId)
                      ?.icon_svg ?? null
                  }
                  size={12}
                  className="text-gray-400"
                />
                {c.display_value ?? c.id.slice(0, 8)}
              </button>
            ))}
            {retargetCandidates?.length === 0 && (
              <p className="px-2 py-1 text-[11px] italic text-gray-400">
                No matches
              </p>
            )}
          </div>
        </div>
      )}

      {/* Merge picker */}
      {showMergePicker && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2">
          <p className="mb-1.5 text-[11px] text-amber-700">
            Merge a duplicate edge into this one (properties & evidence will be combined):
          </p>
          {edge.duplicates.map((dup) => (
            <button
              key={dup.id}
              onClick={() => handleMerge(dup.id)}
              disabled={mergeEdgeMut.isLoading}
              className="flex w-full items-center justify-between rounded px-2 py-1 text-[12px] text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            >
              <span>Edge {dup.id.slice(0, 8)}</span>
              <span className="text-[11px] text-amber-600">
                {formatDate(dup.created_at)}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Evidence */}
      {showEvidence && (
        <div className="space-y-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
            Evidence
          </span>
          {edgeEvidence && edgeEvidence.length > 0 ? (
            edgeEvidence.map((ev) => (
              <div
                key={ev.id}
                className="rounded border border-gray-100 bg-gray-50/50 px-2 py-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-gray-600">
                    {ev.type}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {formatDate(ev.created_at)}
                  </span>
                </div>
                {ev.description && (
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    {ev.description}
                  </p>
                )}
                {ev.excerpt && (
                  <p className="mt-0.5 text-[11px] italic text-gray-400">
                    {ev.excerpt}
                  </p>
                )}
              </div>
            ))
          ) : (
            <p className="text-[11px] italic text-gray-400">No evidence</p>
          )}
        </div>
      )}
    </div>
  );
}

const COLLAPSE_THRESHOLD = 5;

type EdgeGroup = {
  key: string;
  label: string;
  edges: Array<{
    edge_id: string;
    node_id: string;
    node_type_id: string;
    node_type_name: string;
    display_value: string | null;
    edgeProps: any[];
  }>;
};

function groupEdges(
  outgoing: any[],
  incoming: any[],
  edgeProperties: any[] | undefined,
): EdgeGroup[] {
  const groups = new Map<string, EdgeGroup>();

  for (const edge of outgoing) {
    const key = `out:${edge.edge_type_outbound_name}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: edge.edge_type_outbound_name, edges: [] };
      groups.set(key, group);
    }
    group.edges.push({
      edge_id: edge.edge_id,
      node_id: edge.target_node_id,
      node_type_id: edge.target_node_type_id,
      node_type_name: edge.target_node_type_name,
      display_value: edge.target_display_value,
      edgeProps:
        edgeProperties?.filter((ep: any) => ep.edge_id === edge.edge_id) ?? [],
    });
  }

  for (const edge of incoming) {
    const key = `in:${edge.edge_type_inbound_name}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: edge.edge_type_inbound_name, edges: [] };
      groups.set(key, group);
    }
    group.edges.push({
      edge_id: edge.edge_id,
      node_id: edge.source_node_id,
      node_type_id: edge.source_node_type_id,
      node_type_name: edge.source_node_type_name,
      display_value: edge.source_display_value,
      edgeProps:
        edgeProperties?.filter((ep: any) => ep.edge_id === edge.edge_id) ?? [],
    });
  }

  return Array.from(groups.values());
}

function RelationshipsSection({
  node,
  ontology,
  showAddEdge,
  setShowAddEdge,
  collapsedGroups,
  setCollapsedGroups,
  onNavigate,
  onEdgeChanged,
}: {
  node: any;
  ontology:
    | {
        nodeTypes: Array<{ id: string; name: string; icon_svg: string | null }>;
      }
    | undefined;
  showAddEdge: boolean;
  setShowAddEdge: (v: boolean) => void;
  collapsedGroups: Record<string, boolean>;
  setCollapsedGroups: (v: Record<string, boolean>) => void;
  onNavigate: (nodeId: string) => void;
  onEdgeChanged: () => void;
}) {
  const [expandedEdgeId, setExpandedEdgeId] = useState<string | null>(null);

  const edgeGroups = useMemo(
    () =>
      groupEdges(node.outgoingEdges, node.incomingEdges, node.edgeProperties),
    [node.outgoingEdges, node.incomingEdges, node.edgeProperties],
  );

  const toggleGroup = (key: string) => {
    setCollapsedGroups({ ...collapsedGroups, [key]: !collapsedGroups[key] });
  };

  const isCollapsed = (group: EdgeGroup) => {
    if (group.key in collapsedGroups) return collapsedGroups[group.key];
    return group.edges.length > COLLAPSE_THRESHOLD;
  };

  return (
    <div className="border-b border-gray-100 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
          Relationships
        </h3>
        {!showAddEdge && (
          <button
            onClick={() => setShowAddEdge(true)}
            className="text-[11px] text-gray-400 transition-colors hover:text-gray-600"
          >
            + Add
          </button>
        )}
      </div>
      {edgeGroups.length === 0 && !showAddEdge && (
        <p className="text-[12px] italic text-gray-300">No relationships</p>
      )}
      <div className="space-y-2">
        {edgeGroups.map((group) => {
          const collapsed = isCollapsed(group);
          return (
            <div key={group.key}>
              <button
                onClick={() => toggleGroup(group.key)}
                className="flex w-full items-center gap-1.5 py-1 text-left"
              >
                <svg
                  className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${collapsed ? "" : "rotate-90"}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                <span className="text-[12px] font-medium text-gray-500">
                  {group.label}
                </span>
                <span className="text-[11px] text-gray-300">
                  {group.edges.length}
                </span>
              </button>
              {!collapsed && (
                <div className="space-y-1 pl-1">
                  {group.edges.map((edge) => {
                    const isExpanded = expandedEdgeId === edge.edge_id;
                    return (
                      <div key={edge.edge_id}>
                        <div className="group flex items-center gap-1">
                          <button
                            onClick={() => onNavigate(edge.node_id)}
                            className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                              isExpanded ? "bg-primary/5" : "hover:bg-gray-50"
                            }`}
                          >
                            <NodeIcon
                              nodeTypeId={edge.node_type_id}
                              iconSvg={
                                ontology?.nodeTypes.find(
                                  (n) => n.id === edge.node_type_id,
                                )?.icon_svg ?? null
                              }
                              size={14}
                              className="text-gray-400"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13px] text-gray-800">
                                {edge.display_value ??
                                  edge.node_id.slice(0, 8)}
                              </div>
                              <div className="text-[11px] text-gray-400">
                                {edge.node_type_name}
                              </div>
                            </div>
                          </button>
                          <button
                            onClick={() =>
                              setExpandedEdgeId(
                                isExpanded ? null : edge.edge_id,
                              )
                            }
                            className="shrink-0 rounded p-1 text-gray-300 opacity-0 transition-all hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100"
                            title="Edit edge"
                          >
                            <svg
                              className="h-3 w-3"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                            </svg>
                          </button>
                        </div>
                        {!isExpanded && edge.edgeProps.length > 0 && (
                          <div className="ml-8 mb-1 flex flex-wrap gap-x-3 gap-y-0.5">
                            {edge.edgeProps.map((ep: any) => (
                              <span
                                key={ep.property_id}
                                className="text-[11px] text-gray-400"
                              >
                                {ep.property_name}:{" "}
                                <span className="text-gray-600">
                                  {ep.value_text ??
                                    ep.value_number ??
                                    ep.value_date ??
                                    (ep.value_boolean != null
                                      ? ep.value_boolean
                                        ? "Yes"
                                        : "No"
                                      : "—")}
                                </span>
                              </span>
                            ))}
                          </div>
                        )}
                        {isExpanded && (
                          <ExpandedEdgeDetail
                            edgeId={edge.edge_id}
                            nodeId={node.id}
                            ontology={ontology}
                            onClose={() => setExpandedEdgeId(null)}
                            onNavigate={onNavigate}
                            onEdgeChanged={onEdgeChanged}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type PropertyTypeColumn = {
  id: string;
  name: string;
  value_type: string;
  identity: string;
  enum_values: string[] | null;
};

// linked objects panel

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
  // If external_id looks like a UUID, show object type or "Linked record" instead
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(lo.external_id)) {
    return lo.external_object_type ?? "Linked record";
  }
  return lo.external_id;
}

const ADAPTER_LABELS: Record<string, string> = {
  "native-valuations": "TARS Valuations",
  "kg": "TARS",
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
  const stripped =
    adapterType && externalObjectType.startsWith(`${adapterType}:`)
      ? externalObjectType.slice(adapterType.length + 1)
      : externalObjectType;
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

const LINKABLE_SERVICE_TYPES = new Set(["ATTIO", "AFFINITY"]);

function AddLinkedObjectForm({
  nodeId,
  onDone,
}: {
  nodeId: string;
  onDone: () => void;
}) {
  const utils = trpc.useUtils();
  const { data: credentials } =
    trpc.views.credentials.getCredentials.useQuery();
  const createMutation =
    trpc.views.knowledge.graph.createManualLinkedObject.useMutation({
      onSuccess: () => {
        utils.views.knowledge.graph.getLinkedObjects.invalidate({ nodeId });
        onDone();
      },
    });

  const [selectedCredId, setSelectedCredId] = useState("");
  const [selectedObjectType, setSelectedObjectType] = useState("");
  const [externalId, setExternalId] = useState("");

  const linkableCredentials = (credentials ?? []).filter((c) =>
    LINKABLE_SERVICE_TYPES.has(c.type),
  );
  const selectedCred = linkableCredentials.find((c) => c.id === selectedCredId);

  const { data: attioObjects } =
    trpc.views.credentials.attioListObjects.useQuery(
      { credentialsId: selectedCredId },
      { enabled: selectedCred?.type === "ATTIO" },
    );

  const objectTypeOptions =
    selectedCred?.type === "ATTIO"
      ? (attioObjects ?? []).map((o) => ({ value: o.name, id: o.id }))
      : [];

  return (
    <div className="mb-3 space-y-2 rounded border border-gray-200 bg-gray-50 p-2">
      <select
        className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-[12px]"
        value={selectedCredId}
        onChange={(e) => {
          setSelectedCredId(e.target.value);
          setSelectedObjectType("");
        }}
      >
        <option value="">Select system...</option>
        {linkableCredentials.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.type})
          </option>
        ))}
      </select>

      {selectedCred && objectTypeOptions.length > 0 && (
        <select
          className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-[12px]"
          value={selectedObjectType}
          onChange={(e) => setSelectedObjectType(e.target.value)}
        >
          <option value="">Select object type...</option>
          {objectTypeOptions.map((o) => (
            <option key={o.id} value={o.value}>
              {o.value}
            </option>
          ))}
        </select>
      )}

      <input
        className="w-full rounded border border-gray-200 px-2 py-1 text-[12px]"
        placeholder="External Record ID"
        value={externalId}
        onChange={(e) => setExternalId(e.target.value)}
      />
      <button
        className="rounded bg-blue-500 px-2 py-1 text-[11px] text-white hover:bg-blue-600 disabled:opacity-50"
        disabled={!selectedCred || !externalId}
        onClick={() =>
          createMutation.mutate({
            nodeId,
            adapterType: selectedCred!.type,
            externalId,
            externalObjectType: selectedObjectType || undefined,
          })
        }
      >
        Link
      </button>
    </div>
  );
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  URL: "Link",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  SLACK: "Slack",
  TEXT: "Text",
};

type ResourcePayload = {
  title?: string;
  content?: string;
  subject?: string;
  links?: Array<{ url: string }>;
  attachments?: Array<{ name?: string; filename?: string; key?: string; url?: string }>;
  "body-html"?: string;
  "stripped-text"?: string;
};

function parseResourcePayload(data: unknown): ResourcePayload {
  if (!data) return {};
  if (typeof data === "string") {
    try { return JSON.parse(data) as ResourcePayload; } catch { return {}; }
  }
  return data as ResourcePayload;
}

function coerceArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch { /* ignore */ }
  }
  return [];
}

function ResourceContentPreview({ data }: { data: unknown }) {
  const [showHtml, setShowHtml] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const payload = parseResourcePayload(data);

  const title = payload.title ?? payload.subject;
  const textContent = payload.content ?? payload["stripped-text"];
  const htmlContent = payload["body-html"];
  const links = coerceArray<{ url: string }>(payload.links);
  const attachments = coerceArray<{ name?: string; filename?: string; key?: string; url?: string }>(payload.attachments);
  const hasKnownContent = !!(title || textContent || htmlContent || links.length || attachments.length);

  if (!hasKnownContent) {
    return (
      <pre className="max-h-40 overflow-auto rounded-md bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-500">
        {JSON.stringify(data, null, 2)}
      </pre>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-gray-100 bg-white px-3 py-2">
      {title && (
        <h4 className="mb-1.5 text-[12px] font-medium text-gray-900">{title}</h4>
      )}

      {htmlContent && (
        <button
          onClick={() => setShowHtml(!showHtml)}
          className={`mb-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            showHtml
              ? "bg-primary/10 text-primary"
              : "bg-gray-50 text-gray-400 hover:bg-gray-100"
          }`}
        >
          {showHtml ? "Text" : "HTML"}
        </button>
      )}

      {showHtml && htmlContent ? (
        <iframe
          ref={iframeRef}
          srcDoc={htmlContent}
          sandbox="allow-same-origin"
          className="h-60 w-full rounded border border-gray-100 bg-white"
          title="Content preview"
          onLoad={() => {
            const iframe = iframeRef.current;
            if (iframe?.contentDocument?.body) {
              const height = iframe.contentDocument.body.scrollHeight;
              iframe.style.height = `${Math.min(height + 20, 400)}px`;
            }
          }}
        />
      ) : textContent ? (
        <div className="max-h-48 overflow-y-auto text-[12px] leading-relaxed text-gray-600 whitespace-pre-wrap">
          {textContent}
        </div>
      ) : null}

      {links.length > 0 && (
        <div className="mt-2 border-t border-gray-50 pt-2">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
            Links ({links.length})
          </span>
          <div className="flex flex-col gap-1">
            {links.map((link, i) => (
              <a
                key={i}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-[11px] text-primary hover:underline"
              >
                <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                <span className="truncate">{link.url}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="mt-2 border-t border-gray-50 pt-2">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
            Attachments ({attachments.length})
          </span>
          <div className="flex flex-col gap-1">
            {attachments.map((att, i) => (
              <DownloadableAttachment key={i} attachment={att} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DownloadableAttachment({
  attachment,
}: {
  attachment: { name?: string; filename?: string; key?: string; url?: string; documentId?: string };
}) {
  const documentId = attachment.documentId ?? attachment.key;
  const downloadLink = trpc.views.attachments.getDownloadLinkByDocumentId.useQuery(
    { documentId: documentId! },
    { enabled: !!documentId },
  );

  const handleClick = () => {
    if (downloadLink.data?.url) {
      window.open(downloadLink.data.url, "_blank");
    }
  };

  const displayName = attachment.name ?? attachment.filename ?? "Unnamed attachment";

  if (documentId) {
    return (
      <button
        onClick={handleClick}
        disabled={downloadLink.isLoading}
        className="flex items-center gap-1.5 text-left text-[11px] text-primary hover:underline disabled:text-gray-400"
      >
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span className="truncate">{displayName}</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-gray-600">
      <svg className="h-3 w-3 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="truncate">{displayName}</span>
    </div>
  );
}

function PdfFullscreenModal({
  fileUrl,
  label,
  onClose,
  onDownload,
}: {
  fileUrl: string;
  label: string;
  onClose: () => void;
  onDownload?: () => void;
}) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80" onClick={onClose}>
      <div className="flex items-center justify-between px-4 py-2" onClick={(e) => e.stopPropagation()}>
        <span className="text-[13px] font-medium text-white">{label}</span>
        <div className="flex items-center gap-2">
          {onDownload && (
            <button
              onClick={onDownload}
              className="rounded px-2.5 py-1 text-[11px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              Download
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <div className="flex-1 px-4 pb-4" onClick={(e) => e.stopPropagation()}>
        <object
          data={`${fileUrl}#view=fitH`}
          type="application/pdf"
          className="h-full w-full rounded-lg"
        >
          <p className="p-6 text-center text-white/60">
            PDF preview not supported in this browser.
          </p>
        </object>
      </div>
    </div>
  );
}

// The preview and the download button now share ONE source of bytes: the
// authenticated tRPC link, which proves the viewer's team owns the document.
// The preview used to fetch the public by-id route instead, which authorises
// nobody — and now authorises only a signed link this component cannot mint.
function DocumentPreview({ documentId, label }: { documentId: string; label: string }) {
  const downloadLink = trpc.views.attachments.getDownloadLinkByDocumentId.useQuery(
    { documentId },
  );
  const isPdf = label.toLowerCase().endsWith(".pdf");
  const [fullscreen, setFullscreen] = useState(false);
  const pdfUrl = isPdf ? downloadLink.data?.url : undefined;

  return (
    <div className="mt-1 space-y-1.5">
      {pdfUrl && (
        <div className="group relative overflow-hidden rounded-md border border-gray-200">
          <object
            data={`${pdfUrl}#view=fitH&toolbar=0&navpanes=0`}
            type="application/pdf"
            className="h-[400px] w-full"
          >
            <p className="p-3 text-[11px] text-gray-400">
              PDF preview not supported in this browser.
            </p>
          </object>
          <button
            onClick={() => setFullscreen(true)}
            className="absolute right-2 top-2 rounded-md bg-black/60 px-2 py-1 text-[10px] font-medium text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
          >
            Expand
          </button>
        </div>
      )}
      {isPdf && !pdfUrl && (
        <div className="flex h-20 items-center justify-center rounded-md border border-gray-200 bg-gray-50">
          <span className="text-[11px] text-gray-400">Loading PDF...</span>
        </div>
      )}
      <button
        onClick={() => downloadLink.data?.url && window.open(downloadLink.data.url, "_blank")}
        disabled={downloadLink.isLoading}
        className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-[11px] text-gray-700 transition-colors hover:bg-gray-100 disabled:text-gray-400"
      >
        <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span className="truncate">{label}</span>
        <svg className="ml-auto h-3 w-3 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
      {fullscreen && pdfUrl && (
        <PdfFullscreenModal
          fileUrl={pdfUrl}
          label={label}
          onClose={() => setFullscreen(false)}
          onDownload={downloadLink.data?.url ? () => window.open(downloadLink.data!.url, "_blank") : undefined}
        />
      )}
    </div>
  );
}

function LinkedResourcesSection({ nodeId }: { nodeId: string }) {
  const { data: resources } =
    trpc.views.knowledge.graph.getLinkedResources.useQuery({ nodeId });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!resources || resources.length === 0) return null;

  return (
    <div className="border-b border-gray-100 px-4 py-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
        Sources
      </h3>
      <div className="space-y-1">
        {resources.map((r) => {
          const isExpanded = expandedId === r.id;
          const hasExpandableContent = r.payload_data != null || r.document_id != null || r.raw_text != null;
          return (
            <div key={r.id}>
              <div
                className={`flex items-center gap-2 rounded px-1.5 py-1 text-[12px] transition-colors ${
                  hasExpandableContent ? "cursor-pointer" : ""
                } ${isExpanded ? "bg-gray-50" : hasExpandableContent ? "hover:bg-gray-50/50" : ""}`}
                onClick={() => hasExpandableContent && setExpandedId(isExpanded ? null : r.id)}
              >
                {hasExpandableContent && (
                  <svg
                    className={`h-3 w-3 shrink-0 text-gray-300 transition-transform ${
                      isExpanded ? "rotate-90" : ""
                    }`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                )}
                <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                  {RESOURCE_TYPE_LABELS[r.type] ?? r.type}
                </span>
                <span className="truncate text-gray-700">{r.name}</span>
                {r.url && (
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto shrink-0 text-[10px] text-primary hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    open
                  </a>
                )}
              </div>
              {isExpanded && r.payload_data != null ? (
                <ResourceContentPreview data={r.payload_data} />
              ) : isExpanded && r.document_id ? (
                <div className="px-6">
                  <DocumentPreview documentId={r.document_id} label={r.name} />
                </div>
              ) : isExpanded && r.raw_text ? (
                <div className="mt-1 rounded-md border border-gray-100 bg-white px-3 py-2">
                  <div className="max-h-48 overflow-y-auto text-[12px] leading-relaxed text-gray-600 whitespace-pre-wrap">
                    {r.raw_text}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LinkedObjectsSection({ nodeId }: { nodeId: string }) {
  const utils = trpc.useUtils();
  const { data: linkedObjects } =
    trpc.views.knowledge.graph.getLinkedObjects.useQuery({ nodeId });
  const deleteMutation =
    trpc.views.knowledge.graph.deleteLinkedObject.useMutation({
      onSuccess: () =>
        utils.views.knowledge.graph.getLinkedObjects.invalidate({ nodeId }),
    });

  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (!linkedObjects) return null;

  return (
    <div className="border-b border-gray-100 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
          Linked Objects
        </h3>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="text-[11px] text-blue-500 hover:text-blue-700"
        >
          {showAdd ? "Cancel" : "+ Link"}
        </button>
      </div>

      {showAdd && (
        <AddLinkedObjectForm
          nodeId={nodeId}
          onDone={() => setShowAdd(false)}
        />
      )}

      {linkedObjects.length === 0 && (
        <p className="text-[12px] text-gray-400">No linked objects</p>
      )}

      <div className="space-y-2">
        {linkedObjects.map((lo) => {
          const displayName = getLinkedObjectDisplayName(lo);
          const url = getLinkedObjectUrl(lo);
          const systemLabel = [
            prettyAdapterLabel(lo.adapter_type),
            prettyObjectType(lo.adapter_type, lo.external_object_type),
          ].filter(Boolean).join(" · ");
          const data = (lo.data ?? {}) as Record<string, unknown>;
          const dataEntries = Object.entries(data).filter(
            ([key]) => key !== "url",
          );
          const hasData = dataEntries.length > 0;
          const dateStr = new Date(lo.updated_at).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });

          return (
            <div
              key={lo.id}
              className="rounded border border-gray-200 bg-white p-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-gray-500">
                  {systemLabel}
                </span>
                <button
                  onClick={() => deleteMutation.mutate({ id: lo.id })}
                  className="text-[11px] text-gray-400 hover:text-red-500"
                  title="Unlink"
                >
                  ×
                </button>
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
              <div className="mt-1 flex items-center gap-1 text-[10px] text-gray-400">
                {hasData ? (
                  <button
                    onClick={() =>
                      setExpanded((e) => ({ ...e, [lo.id]: !e[lo.id] }))
                    }
                    className="hover:text-gray-600"
                  >
                    {expanded[lo.id]
                      ? "Hide fields"
                      : `${dataEntries.length} field${dataEntries.length !== 1 ? "s" : ""}`}
                  </button>
                ) : null}
                {hasData && <span>·</span>}
                <span>{dateStr}</span>
              </div>
              {expanded[lo.id] && hasData ? (
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
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function NodeDetailDrawer({
  nodeId,
  onClose,
  onNavigate,
  onDeleted,
  onPropertyChanged,
  ontology,
}: {
  nodeId: string;
  onClose: () => void;
  onNavigate: (nodeId: string) => void;
  onDeleted?: () => void;
  onPropertyChanged?: () => void;
  ontology:
    | {
        nodeTypes: Array<{ id: string; name: string; icon_svg: string | null }>;
        propertyTypes?: Array<{
          id: string;
          node_type_id: string | null;
          name: string;
          value_type: string;
          identity: string;
          enum_values: string[] | null;
        }>;
      }
    | undefined;
}) {
  const utils = trpc.useUtils();
  const router = useRouter();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [showAddEdge, setShowAddEdge] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({});

  const { data: node, isLoading } = trpc.views.knowledge.graph.getNode.useQuery(
    { id: nodeId },
  );
  const editProperty = trpc.views.knowledge.graph.createUserEdit.useMutation();
  const createProperty =
    trpc.views.knowledge.graph.createProperty.useMutation();
  const deleteNode = trpc.views.knowledge.graph.deleteNode.useMutation();

  // Derive property types for this node's type from the ontology
  const propertyTypes = node
    ? ontology?.propertyTypes?.filter(
        (pt) => pt.node_type_id === node.node_type_id,
      )
    : undefined;

  const handlePropertySave = async (
    propertyId: string,
    value: {
      valueText?: string | null;
      valueNumber?: string | null;
      valueDate?: string | null;
      valueBoolean?: boolean | null;
    },
  ) => {
    await editProperty.mutateAsync({
      propertyId,
      description: "Edited from UI",
      ...value,
    });
    utils.views.knowledge.graph.getNode.invalidate({ id: nodeId });
    onPropertyChanged?.();
  };

  const handleDelete = async () => {
    await deleteNode.mutateAsync({ id: nodeId });
    utils.views.knowledge.graph.getNodesTable.invalidate();
    onDeleted?.();
    onClose();
  };

  const handleEdgeChanged = () => {
    utils.views.knowledge.graph.getNode.invalidate({ id: nodeId });
  };

  if (isLoading) {
    return (
      <div className="flex h-full flex-col bg-white">
        <div className="flex h-12 items-center justify-between border-b border-gray-200 px-4">
          <div className="h-4 w-32 animate-pulse rounded bg-gray-100" />
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
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
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="space-y-3 p-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-gray-50" />
          ))}
        </div>
      </div>
    );
  }

  if (!node) return null;

  const displayName =
    node.display_value ??
    node.properties.find((p) => {
      const pt = propertyTypes?.find((col) => col.id === p.property_type_id);
      return pt?.identity === "unique" || pt?.identity === "fuzzy";
    })?.value_text ??
    node.properties[0]?.value_text ??
    node.id.slice(0, 8);

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Header */}
      <div className="flex h-14 items-center justify-between border-b border-gray-100 px-4">
        <div className="flex items-center gap-2.5 truncate">
          <NodeIcon
            nodeTypeId={node.node_type_id}
            iconSvg={
              ontology?.nodeTypes.find((n) => n.id === node.node_type_id)
                ?.icon_svg ?? null
            }
            className="text-gray-500"
          />
          <span className="truncate text-[15px] font-semibold text-gray-900">
            {displayName}
          </span>
        </div>
        <div className="ml-2 flex shrink-0 items-center gap-1">
          <button
            onClick={() => router.push(`/nodes/${nodeId}`)}
            className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            title="Open full page"
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
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
          <button
            onClick={() => {
              setShowMerge(true);
              setShowDeleteConfirm(false);
            }}
            className="rounded p-1 text-gray-400 transition-colors hover:bg-amber-50 hover:text-amber-600"
            title="Merge another node into this one"
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
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 15V8a2 2 0 0 0-2-2H9" />
              <path d="M6 9v6" />
            </svg>
          </button>
          <button
            onClick={() => {
              setShowDeleteConfirm(true);
              setShowMerge(false);
            }}
            className="rounded p-1 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
            title="Delete node"
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
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 transition-colors hover:text-gray-600"
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
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-3">
          <p className="mb-2 text-[12px] text-red-700">
            Delete this node and all its properties, edges, and evidence?
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleDelete}
              disabled={deleteNode.isLoading}
              className="rounded-md bg-red-600 px-3 py-1 text-[12px] font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
            >
              {deleteNode.isLoading ? "Deleting..." : "Delete"}
            </button>
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="rounded-md bg-white px-3 py-1 text-[12px] text-gray-600 transition-colors hover:bg-gray-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Merge panel */}
      {showMerge && (
        <MergePanel
          nodeId={nodeId}
          nodeTypeId={node.node_type_id}
          displayName={displayName}
          ontology={ontology}
          onClose={() => setShowMerge(false)}
          onMerged={() => {
            utils.views.knowledge.graph.getNode.invalidate({ id: nodeId });
            utils.views.knowledge.graph.getNodesTable.invalidate();
            setShowMerge(false);
            onPropertyChanged?.();
          }}
        />
      )}

      <div className="flex-1 overflow-y-auto">
        {/* Properties */}
        <div className="border-b border-gray-100 px-4 py-3">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
            Properties
          </h3>
          <div className="space-y-1">
            {propertyTypes && propertyTypes.length > 0
              ? propertyTypes.map((pt) => {
                  const prop = node.properties.find(
                    (p) => p.property_type_id === pt.id,
                  );
                  return prop ? (
                    <EditableProperty
                      key={pt.id}
                      prop={prop}
                      enumValues={pt.enum_values}
                      onSave={handlePropertySave}
                    />
                  ) : (
                    <EmptyPropertyRow
                      key={pt.id}
                      propertyType={pt}
                      nodeId={nodeId}
                      onCreated={() => {
                        utils.views.knowledge.graph.getNode.invalidate({
                          id: nodeId,
                        });
                        onPropertyChanged?.();
                      }}
                    />
                  );
                })
              : node.properties.length > 0
                ? node.properties.map((prop) => (
                    <EditableProperty
                      key={prop.property_id}
                      prop={prop}
                      onSave={handlePropertySave}
                    />
                  ))
                : (
                <p className="text-[12px] italic text-gray-300">
                  No properties
                </p>
              )}
          </div>
        </div>

        {/* Relationships */}
        <RelationshipsSection
          node={node}
          ontology={ontology}
          showAddEdge={showAddEdge}
          setShowAddEdge={setShowAddEdge}
          collapsedGroups={collapsedGroups}
          setCollapsedGroups={setCollapsedGroups}
          onNavigate={onNavigate}
          onEdgeChanged={handleEdgeChanged}
        />

        {/* Add edge dialog */}
        {showAddEdge && (
          <AddEdgeDialog
            nodeId={nodeId}
            nodeTypeId={node.node_type_id}
            ontology={ontology}
            onClose={() => setShowAddEdge(false)}
            onAdded={() =>
              utils.views.knowledge.graph.getNode.invalidate({ id: nodeId })
            }
          />
        )}

        {/* Linked Objects */}
        <LinkedObjectsSection nodeId={nodeId} />

        {/* Metadata */}
        <div className="px-4 py-3">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
            Metadata
          </h3>
          <div className="space-y-1.5 text-[12px]">
            <div className="flex justify-between">
              <span className="text-gray-500">Type</span>
              <span className="text-gray-700">{node.node_type_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Created</span>
              <span className="text-gray-700">
                {formatDate(node.created_at)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Updated</span>
              <span className="text-gray-700">
                {formatDate(node.updated_at)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
