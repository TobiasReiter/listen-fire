"use client";

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";

import { Card } from "../card";

const btnPrimary =
  "rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50";
const btnSecondary =
  "rounded-md border border-gray-200 px-3 py-1.5 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50";
const inputClass =
  "w-full rounded-md border border-gray-200 px-3 py-2 text-[13px] focus:border-gray-400 focus:outline-none";

type StatusKind = "active" | "not-registered" | "pending" | "disabled";

function statusFor(sub: {
  status: string;
  external_webhook_id: string | null;
  canRegisterViaApi: boolean;
}): { kind: StatusKind; label: string; tone: string } {
  if (sub.status === "pending") {
    return { kind: "pending", label: "pending", tone: "bg-amber-100 text-amber-700" };
  }
  if (sub.status === "disabled") {
    return { kind: "disabled", label: "disabled", tone: "bg-gray-100 text-gray-500" };
  }
  if (sub.canRegisterViaApi && !sub.external_webhook_id) {
    return {
      kind: "not-registered",
      label: "not registered",
      tone: "bg-red-100 text-red-700",
    };
  }
  return { kind: "active", label: "active", tone: "bg-green-100 text-green-700" };
}

export default function WebhooksPage() {
  const utils = trpc.useUtils();
  const subs = trpc.views.webhookSubscriptions.list.useQuery();
  const providers = trpc.views.webhookSubscriptions.listProviders.useQuery();
  const credentials = trpc.views.credentials.getCredentials.useQuery();

  const subscribableCreds = useMemo(() => {
    const supported = new Set((providers.data ?? []).map((p) => p.provider));
    return (credentials.data ?? []).filter((c) => supported.has(c.type));
  }, [providers.data, credentials.data]);

  const { mutateAsync: createSub, isLoading: isCreating } =
    trpc.views.webhookSubscriptions.create.useMutation();
  const { mutateAsync: deleteSub } =
    trpc.views.webhookSubscriptions.delete.useMutation();

  const [showCreate, setShowCreate] = useState(false);
  const [credentialsId, setCredentialsId] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCreate = async () => {
    setCreateError(null);
    const cred = subscribableCreds.find((c) => c.id === credentialsId);
    if (!cred) {
      setCreateError("Pick an integration first.");
      return;
    }
    try {
      await createSub({ credentialsId: cred.id, provider: cred.type });
      setShowCreate(false);
      setCredentialsId("");
      utils.views.webhookSubscriptions.list.invalidate();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: string) => {
    await deleteSub({ id });
    setConfirmDeleteId(null);
    utils.views.webhookSubscriptions.list.invalidate();
  };

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const rows = subs.data ?? [];

  return (
    <Card>
      <p className="text-[12px] text-gray-400">
        Inbound webhook subscriptions. Each row tells an integration where to deliver change events. KIPP auto-registers
        with providers that support it (Attio, Valuations); manual providers (Affinity) need the secret pasted into the
        source system.
      </p>

      {/* Create form */}
      <div className="mt-4">
        {showCreate ? (
          <div className="rounded-md border border-gray-200 p-4">
            <label className="text-[12px] font-medium text-gray-500">
              Integration
            </label>
            <select
              className={`${inputClass} mt-1.5`}
              value={credentialsId}
              onChange={(e) => setCredentialsId(e.target.value)}
            >
              <option value="">Select integration…</option>
              {subscribableCreds.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.type})
                </option>
              ))}
            </select>
            {subscribableCreds.length === 0 && (
              <p className="mt-2 text-[12px] text-gray-400">
                No supported integrations are connected yet. Connect one in{" "}
                <a className="text-primary hover:underline" href="/integrations">
                  Integrations
                </a>{" "}
                first.
              </p>
            )}
            {createError && (
              <p className="mt-2 text-[12px] text-red-600">{createError}</p>
            )}
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={handleCreate}
                disabled={!credentialsId || isCreating}
                className={btnPrimary}
              >
                Create
              </button>
              <button
                onClick={() => {
                  setShowCreate(false);
                  setCredentialsId("");
                  setCreateError(null);
                }}
                className={btnSecondary}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowCreate(true)} className={btnPrimary}>
            Create Subscription
          </button>
        )}
      </div>

      {/* Subscription list */}
      <div className="mt-6">
        {subs.isLoading && (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-md bg-gray-100"
              />
            ))}
          </div>
        )}
        {rows.length === 0 && !subs.isLoading && (
          <p className="text-[12px] text-gray-400">No subscriptions yet.</p>
        )}
        {rows.map((sub) => {
          const status = statusFor(sub);
          return (
            <div
              key={sub.id}
              className="group flex items-start gap-3 border-b border-gray-100 py-3 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-mono text-gray-500">
                    {sub.provider}
                  </code>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${status.tone}`}
                    title={
                      status.kind === "not-registered"
                        ? "Subscription row exists locally but no external_webhook_id is set — the registration call to the source likely failed. Delete and recreate."
                        : undefined
                    }
                  >
                    {status.label}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="truncate rounded bg-gray-50 px-2 py-1 text-[11px] font-mono text-gray-600">
                    {sub.targetUrl}
                  </code>
                  <button
                    onClick={() => copy(sub.targetUrl, `url-${sub.id}`)}
                    className="text-[11px] text-gray-500 hover:text-gray-700"
                  >
                    {copiedId === `url-${sub.id}` ? "Copied" : "Copy"}
                  </button>
                </div>
                {sub.webhook_secret && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-[11px] text-gray-400">Secret</span>
                    <code className="truncate rounded bg-gray-50 px-2 py-1 text-[11px] font-mono text-gray-600">
                      {sub.webhook_secret}
                    </code>
                    <button
                      onClick={() => copy(sub.webhook_secret ?? "", `sec-${sub.id}`)}
                      className="text-[11px] text-gray-500 hover:text-gray-700"
                    >
                      {copiedId === `sec-${sub.id}` ? "Copied" : "Copy"}
                    </button>
                  </div>
                )}
                <div className="mt-0.5 text-[11px] text-gray-400">
                  Created {new Date(sub.created_at).toLocaleDateString()}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
                {confirmDeleteId === sub.id ? (
                  <>
                    <button
                      onClick={() => handleDelete(sub.id)}
                      className="rounded px-2 py-1 text-[12px] text-red-600 hover:bg-red-50"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="rounded px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-100"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(sub.id)}
                    className="rounded px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-100"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
