"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";

import { Card } from "../card";

const AVAILABLE_SCOPES = ["ingest", "automation", "knowledge", "valuations"] as const;
const DEFAULT_SCOPES = ["ingest", "knowledge"];

const inputClass =
  "w-full rounded-md border border-gray-200 px-3 py-2 text-[13px] focus:border-gray-400 focus:outline-none";
const btnPrimary =
  "rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50";
const btnSecondary =
  "rounded-md border border-gray-200 px-3 py-1.5 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50";
const scopeBadge =
  "rounded-full px-2 py-0.5 text-[11px] font-medium";

export default function ApiKeysPage() {
  const utils = trpc.useUtils();
  const { data: keys, isLoading } = trpc.views.apiKeys.list.useQuery();
  const { mutateAsync: createKey, isLoading: isCreating } =
    trpc.views.apiKeys.create.useMutation();
  const { mutateAsync: revokeKey } = trpc.views.apiKeys.revoke.useMutation();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([...DEFAULT_SCOPES]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const toggleScope = (scope: string) => {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  const handleCreate = async () => {
    if (!name.trim() || scopes.length === 0) return;
    const result = await createKey({ name: name.trim(), scopes });
    setNewKey(result.key);
    setName("");
    setScopes([...DEFAULT_SCOPES]);
    setShowCreate(false);
    utils.views.apiKeys.list.invalidate();
  };

  const handleRevoke = async (id: string) => {
    await revokeKey({ id });
    setConfirmRevokeId(null);
    utils.views.apiKeys.list.invalidate();
  };

  const copyKey = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card>
      <p className="text-[12px] text-gray-400">
        API keys allow external applications to authenticate with the KIPP API.
        Keep your keys secure and never share them publicly.
      </p>

      {/* New key reveal */}
      {newKey && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4">
          <p className="text-[13px] font-medium text-amber-700">
            Copy your API key now — it won&apos;t be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-white px-3 py-2 text-[12px] font-mono text-gray-800 border border-amber-200">
              {newKey}
            </code>
            <button onClick={() => copyKey(newKey)} className={btnSecondary}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => setNewKey(null)}
            className="mt-2 text-[12px] text-amber-600 hover:text-amber-800"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      <div className="mt-4">
        {showCreate ? (
          <div className="rounded-md border border-gray-200 p-4">
            <input
              className={inputClass}
              placeholder="Key name (e.g. Production, Staging)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <div className="mt-3">
              <label className="text-[12px] font-medium text-gray-500">
                Scopes
              </label>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {AVAILABLE_SCOPES.map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => toggleScope(scope)}
                    className={`rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                      scopes.includes(scope)
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-500"
                    }`}
                  >
                    {scope}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={handleCreate}
                disabled={!name.trim() || scopes.length === 0 || isCreating}
                className={btnPrimary}
              >
                Create
              </button>
              <button
                onClick={() => {
                  setShowCreate(false);
                  setName("");
                  setScopes([...DEFAULT_SCOPES]);
                }}
                className={btnSecondary}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowCreate(true)} className={btnPrimary}>
            Create API Key
          </button>
        )}
      </div>

      {/* Key list */}
      <div className="mt-6">
        {isLoading && (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-md bg-gray-100"
              />
            ))}
          </div>
        )}
        {keys && keys.length === 0 && (
          <p className="text-[12px] text-gray-400">
            No API keys yet. Create one to get started.
          </p>
        )}
        {keys?.map((key) => (
          <div
            key={key.id}
            className="group flex items-center gap-3 border-b border-gray-100 py-3 last:border-0"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-gray-900">
                  {key.name}
                </span>
                <code className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-mono text-gray-500">
                  {key.keyPrefix}...
                </code>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {key.scopes?.map((scope: string) => (
                  <span
                    key={scope}
                    className={`${scopeBadge} bg-gray-100 text-gray-500`}
                  >
                    {scope}
                  </span>
                ))}
              </div>
              <div className="mt-0.5 flex gap-3 text-[11px] text-gray-400">
                <span>
                  Created{" "}
                  {new Date(key.createdAt).toLocaleDateString()}
                </span>
                {key.lastUsedAt && (
                  <span>
                    Last used{" "}
                    {new Date(key.lastUsedAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
              {confirmRevokeId === key.id ? (
                <>
                  <button
                    onClick={() => handleRevoke(key.id)}
                    className="rounded px-2 py-1 text-[12px] text-red-600 hover:bg-red-50"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setConfirmRevokeId(null)}
                    className="rounded px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-100"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmRevokeId(key.id)}
                  className="rounded px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-100"
                >
                  Revoke
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
