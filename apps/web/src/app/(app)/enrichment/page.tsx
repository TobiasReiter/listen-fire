"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";

type PluginStage = "content" | "entity";
type AuthType = "none" | "bearer" | "basic" | "api_key";
type HttpMethod = "POST" | "PUT" | "PATCH";

interface HeaderEntry {
  key: string;
  value: string;
}

const AUTH_TYPE_LABELS: Record<AuthType, string> = {
  none: "None",
  bearer: "Bearer Token",
  basic: "Basic Auth",
  api_key: "API Key Header",
};

const inputClass =
  "w-full rounded border border-gray-200 px-2.5 py-1.5 text-[12px] placeholder:text-gray-300 focus:border-gray-400 focus:outline-none";

function PluginRow({
  plugin,
  onDelete,
}: {
  plugin: {
    id: string;
    name: string;
    description: string | null;
    type: string;
    endpoint: string | null;
    method: string;
    auth?: unknown;
    headers?: unknown;
    stages: string[];
  };
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const auth = plugin.auth as { type: string } | null;
  const hasEndpoint = !!plugin.endpoint;

  return (
    <div className="group flex items-center gap-4 border-b border-gray-100 px-5 py-3 transition-colors hover:bg-gray-50/50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-gray-900">
            {plugin.name}
          </span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              plugin.type === "bundled"
                ? "bg-violet-50 text-violet-600"
                : "bg-teal-50 text-teal-600"
            }`}
          >
            {plugin.type}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[12px] text-gray-400">
          {plugin.description && (
            <span className="truncate">{plugin.description}</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {plugin.stages.map((stage) => (
            <span
              key={stage}
              className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500"
            >
              {stage}
            </span>
          ))}
          {hasEndpoint && (
            <>
              <span className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-[10px] text-blue-500">
                {plugin.method}
              </span>
              <span className="truncate font-mono text-[10px] text-gray-400">
                {plugin.endpoint}
              </span>
            </>
          )}
          {auth && auth.type !== "none" && (
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
              {AUTH_TYPE_LABELS[auth.type as AuthType] ?? auth.type}
            </span>
          )}
        </div>
      </div>

      {plugin.type !== "bundled" && (
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  onDelete();
                  setConfirmDelete(false);
                }}
                className="rounded px-1.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded px-1.5 py-0.5 text-[11px] text-gray-400 hover:bg-gray-100"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="rounded p-1 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
              title="Delete"
            >
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function HeadersEditor({
  headers,
  onAdd,
  onUpdate,
  onRemove,
}: {
  headers: HeaderEntry[];
  onAdd: () => void;
  onUpdate: (index: number, field: "key" | "value", value: string) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
          Custom Headers
        </label>
        <button
          onClick={onAdd}
          className="text-[11px] font-medium text-violet-600 hover:underline"
        >
          + Add
        </button>
      </div>
      {headers.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {headers.map((h, idx) => (
            <div key={idx} className="group/header flex items-center gap-1.5">
              <input
                placeholder="Header name"
                value={h.key}
                onChange={(e) => onUpdate(idx, "key", e.target.value)}
                className={inputClass}
              />
              <input
                placeholder="Value"
                value={h.value}
                onChange={(e) => onUpdate(idx, "value", e.target.value)}
                className={inputClass}
              />
              <button
                onClick={() => onRemove(idx)}
                className="shrink-0 px-1 text-[14px] text-gray-300 transition-colors hover:text-red-400"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-gray-400">No custom headers</p>
      )}
    </div>
  );
}

export default function PluginsPage() {
  usePageTitle("Enrichment — KIPP");

  const { data: plugins, isLoading } =
    trpc.views.knowledge.extractionGraph.getPlugins.useQuery();
  const { mutateAsync: createPlugin, isLoading: isCreating } =
    trpc.views.knowledge.extractionGraph.createPlugin.useMutation({
      onSuccess: () =>
        utils.views.knowledge.extractionGraph.getPlugins.invalidate(),
    });
  const { mutateAsync: deletePlugin } =
    trpc.views.knowledge.extractionGraph.deletePlugin.useMutation({
      onSuccess: () =>
        utils.views.knowledge.extractionGraph.getPlugins.invalidate(),
    });
  const utils = trpc.useUtils();

  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formEndpoint, setFormEndpoint] = useState("");
  const [formMethod, setFormMethod] = useState<HttpMethod>("POST");
  const [formAuthType, setFormAuthType] = useState<AuthType>("none");
  const [formBearerToken, setFormBearerToken] = useState("");
  const [formBasicUsername, setFormBasicUsername] = useState("");
  const [formBasicPassword, setFormBasicPassword] = useState("");
  const [formApiKeyHeader, setFormApiKeyHeader] = useState("X-API-Key");
  const [formApiKey, setFormApiKey] = useState("");
  const [formHeaders, setFormHeaders] = useState<HeaderEntry[]>([]);
  const [formStages, setFormStages] = useState<PluginStage[]>(["content"]);
  const [showDocs, setShowDocs] = useState(false);

  const bundledPlugins = plugins?.filter((p) => p.type === "bundled") ?? [];
  const teamPlugins = plugins?.filter((p) => p.type !== "bundled") ?? [];

  const toggleStage = (stage: PluginStage) => {
    if (formStages.includes(stage)) {
      const next = formStages.filter((s) => s !== stage);
      if (next.length > 0) setFormStages(next);
    } else {
      setFormStages([...formStages, stage]);
    }
  };

  const resetForm = () => {
    setShowForm(false);
    setFormName("");
    setFormDescription("");
    setFormEndpoint("");
    setFormMethod("POST");
    setFormAuthType("none");
    setFormBearerToken("");
    setFormBasicUsername("");
    setFormBasicPassword("");
    setFormApiKeyHeader("X-API-Key");
    setFormApiKey("");
    setFormHeaders([]);
    setFormStages(["content"]);
  };

  const buildAuth = () => {
    if (formAuthType === "none") return undefined;
    if (formAuthType === "bearer")
      return { type: "bearer" as const, token: formBearerToken };
    if (formAuthType === "basic")
      return {
        type: "basic" as const,
        username: formBasicUsername,
        password: formBasicPassword,
      };
    return {
      type: "api_key" as const,
      headerName: formApiKeyHeader,
      apiKey: formApiKey,
    };
  };

  const buildHeaders = () => {
    const filtered = formHeaders.filter((h) => h.key && h.value);
    if (filtered.length === 0) return undefined;
    return Object.fromEntries(filtered.map((h) => [h.key, h.value]));
  };

  const handleCreate = async () => {
    await createPlugin({
      name: formName.trim(),
      description: formDescription.trim() || undefined,
      type: "external",
      endpoint: formEndpoint.trim() || null,
      method: formMethod,
      auth: buildAuth(),
      headers: buildHeaders(),
      stages: formStages,
    });
    resetForm();
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 px-5">
        <h1 className="text-base font-semibold text-gray-900">
          Enrichment
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowDocs((d) => !d)}
            className="rounded-md border border-gray-200 px-2.5 py-1.5 text-[12px] text-gray-500 transition-colors hover:bg-gray-50"
          >
            {showDocs ? "Hide" : "How to"} build a plugin
          </button>
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-primary-600"
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Plugin
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl">
          {/* How to build a plugin */}
          {showDocs && (
            <div className="border-b border-gray-200 bg-gray-50/30 px-5 py-4">
              <h3 className="mb-2 text-[13px] font-semibold text-gray-900">
                Building an Extraction Plugin
              </h3>
              <p className="mb-2 text-[12px] leading-relaxed text-gray-500">
                A plugin is an HTTP endpoint that enriches content during extraction.
                Plugins run at two stages:
              </p>
              <div className="mb-3 flex gap-4">
                <div className="flex-1 rounded-md border border-gray-200 bg-white p-3">
                  <div className="mb-1 text-[11px] font-semibold text-violet-600">
                    Content plugin
                  </div>
                  <p className="text-[11px] leading-relaxed text-gray-500">
                    Runs on raw input before any extraction. No entity context needed.
                    Use to fetch URLs, parse attachments, or clean content.
                  </p>
                </div>
                <div className="flex-1 rounded-md border border-gray-200 bg-white p-3">
                  <div className="mb-1 text-[11px] font-semibold text-cyan-600">
                    Entity plugin
                  </div>
                  <p className="text-[11px] leading-relaxed text-gray-500">
                    Runs after a lightweight identification pass, before full property
                    extraction. Per-entity enrichment — fetch URLs scoped to the right
                    entity, API lookups by name.
                  </p>
                </div>
              </div>
              <h4 className="mb-1 text-[12px] font-semibold text-gray-700">
                Request payload
              </h4>
              <p className="mb-1.5 text-[11px] text-gray-500">
                Your endpoint receives a POST (configurable) with a JSON body:
              </p>
              <pre className="mb-3 overflow-x-auto rounded-md bg-gray-900 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-gray-300">
{`{
  "stage": "content" | "entity",
  "pluginId": "...",
  "extractionGraphId": "...",
  "nodeTypeId": "...",
  "messageId": "...",
  "content": "...",             // the text to transform
  "entityContext": { ... }      // entity: identified entity info
}`}
              </pre>
              <h4 className="mb-1 text-[12px] font-semibold text-gray-700">
                Expected response
              </h4>
              <pre className="overflow-x-auto rounded-md bg-gray-900 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-gray-300">
{`{
  "content": "..."              // enriched content for extraction
}`}
              </pre>
            </div>
          )}

          {isLoading ? (
            <div className="space-y-px">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-5 py-3">
                  <div
                    className="h-4 w-28 animate-pulse rounded bg-gray-100"
                    style={{ animationDelay: `${i * 60}ms` }}
                  />
                  <div
                    className="h-4 w-16 animate-pulse rounded bg-gray-50"
                    style={{ animationDelay: `${i * 60 + 30}ms` }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div>
              {/* Bundled plugins */}
              <div className="border-b border-gray-200 bg-gray-50/50 px-5 py-2">
                <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
                  Bundled
                </span>
              </div>
              {bundledPlugins.length === 0 ? (
                <div className="px-5 py-4 text-[13px] text-gray-400">
                  No bundled plugins
                </div>
              ) : (
                bundledPlugins.map((p) => (
                  <PluginRow
                    key={p.id}
                    plugin={p}
                    onDelete={() => deletePlugin({ id: p.id })}
                  />
                ))
              )}

              {/* Team plugins */}
              <div className="border-b border-gray-200 bg-gray-50/50 px-5 py-2">
                <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
                  Custom
                </span>
              </div>
              {teamPlugins.length === 0 ? (
                <div className="px-5 py-4 text-[13px] text-gray-400">
                  No custom plugins
                </div>
              ) : (
                teamPlugins.map((p) => (
                  <PluginRow
                    key={p.id}
                    plugin={p}
                    onDelete={() => deletePlugin({ id: p.id })}
                  />
                ))
              )}
            </div>
          )}

          {/* Create form */}
          {showForm && (
            <div className="border-t border-gray-200 px-5 py-4">
              <h3 className="mb-3 text-[13px] font-semibold text-gray-900">
                Register Plugin
              </h3>
              <div className="flex flex-col gap-3">
                {/* Name */}
                <div>
                  <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
                    Name
                  </label>
                  <input
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="My Plugin"
                    className={inputClass}
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
                    Description
                  </label>
                  <input
                    type="text"
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                    placeholder="What this plugin does"
                    className={inputClass}
                  />
                </div>

                {/* Endpoint URL */}
                <div>
                  <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
                    Endpoint URL
                  </label>
                  <input
                    type="text"
                    value={formEndpoint}
                    onChange={(e) => setFormEndpoint(e.target.value)}
                    placeholder="https://your-server.com/plugin"
                    className={`${inputClass} font-mono`}
                  />
                </div>

                {/* HTTP Method */}
                <div>
                  <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
                    HTTP Method
                  </label>
                  <div className="flex gap-1.5">
                    {(["POST", "PUT", "PATCH"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setFormMethod(m)}
                        className={`rounded-md border px-3 py-1 font-mono text-[11px] font-medium transition-colors ${
                          formMethod === m
                            ? "border-blue-300 bg-blue-50 text-blue-700"
                            : "border-gray-200 text-gray-400 hover:bg-gray-50"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Authentication */}
                <div>
                  <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
                    Authentication
                  </label>
                  <select
                    value={formAuthType}
                    onChange={(e) =>
                      setFormAuthType(e.target.value as AuthType)
                    }
                    className={inputClass}
                  >
                    {(
                      Object.entries(AUTH_TYPE_LABELS) as [AuthType, string][]
                    ).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Auth-specific fields */}
                {formAuthType === "bearer" && (
                  <div>
                    <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
                      Bearer Token
                    </label>
                    <input
                      type="password"
                      value={formBearerToken}
                      onChange={(e) => setFormBearerToken(e.target.value)}
                      placeholder="Enter token..."
                      className={inputClass}
                    />
                  </div>
                )}
                {formAuthType === "basic" && (
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
                        Username
                      </label>
                      <input
                        type="text"
                        value={formBasicUsername}
                        onChange={(e) => setFormBasicUsername(e.target.value)}
                        placeholder="Username"
                        className={inputClass}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
                        Password
                      </label>
                      <input
                        type="password"
                        value={formBasicPassword}
                        onChange={(e) => setFormBasicPassword(e.target.value)}
                        placeholder="Password"
                        className={inputClass}
                      />
                    </div>
                  </div>
                )}
                {formAuthType === "api_key" && (
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
                        Header Name
                      </label>
                      <input
                        type="text"
                        value={formApiKeyHeader}
                        onChange={(e) => setFormApiKeyHeader(e.target.value)}
                        placeholder="X-API-Key"
                        className={inputClass}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
                        API Key
                      </label>
                      <input
                        type="password"
                        value={formApiKey}
                        onChange={(e) => setFormApiKey(e.target.value)}
                        placeholder="Enter API key..."
                        className={inputClass}
                      />
                    </div>
                  </div>
                )}

                {/* Custom Headers */}
                <HeadersEditor
                  headers={formHeaders}
                  onAdd={() =>
                    setFormHeaders((prev) => [...prev, { key: "", value: "" }])
                  }
                  onUpdate={(idx, field, value) =>
                    setFormHeaders((prev) =>
                      prev.map((h, i) =>
                        i === idx ? { ...h, [field]: value } : h,
                      ),
                    )
                  }
                  onRemove={(idx) =>
                    setFormHeaders((prev) => prev.filter((_, i) => i !== idx))
                  }
                />

                {/* Stages */}
                <div>
                  <label className="mb-0.5 block text-[10px] font-medium uppercase tracking-wider text-gray-400">
                    Stages
                  </label>
                  <div className="flex gap-1.5">
                    {(["content", "entity"] as const).map((stage) => (
                      <button
                        key={stage}
                        onClick={() => toggleStage(stage)}
                        className={`rounded-md border px-3 py-1 text-[11px] font-medium transition-colors ${
                          formStages.includes(stage)
                            ? "border-violet-300 bg-violet-50 text-violet-700"
                            : "border-gray-200 text-gray-400 hover:bg-gray-50"
                        }`}
                      >
                        {stage}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    onClick={resetForm}
                    className="rounded-md border border-gray-200 px-3 py-1.5 text-[12px] text-gray-500 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreate}
                    disabled={!formName.trim() || isCreating}
                    className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-30"
                  >
                    {isCreating ? "Creating..." : "Create Plugin"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
