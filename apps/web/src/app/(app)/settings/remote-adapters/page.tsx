"use client";

import { useState } from "react";
import { trpc, type RouterInputs } from "@/lib/trpc";

import { Card } from "../card";

type RuntimeCapabilitiesInput =
  RouterInputs["views"]["remoteAdapter"]["upsertFromManifest"]["runtimeCapabilities"];

const btnPrimary =
  "rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50";
const btnSecondary =
  "rounded-md border border-gray-200 px-3 py-1.5 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50";
const inputClass =
  "w-full rounded-md border border-gray-200 px-3 py-2 text-[13px] focus:border-gray-400 focus:outline-none";
const labelClass = "text-[12px] font-medium text-gray-500";

type AuthKind = "bearer" | "shared_secret";

type FormState = {
  adapterType: string;
  baseUrl: string;
  authKind: AuthKind;
  authHeader: string;
  /** The existing credential FK (edit mode). Round-tripped so editing other
   *  fields without entering a new secret preserves the stored credential. */
  credentialsId: string;
  /** A newly-entered secret. When set, the server mints an encrypted REMOTE
   *  credential bound to this adapter and links it. Never populated from the
   *  server — the stored secret never travels back. */
  secret: string;
  supportedTriggers: string;
  capabilitiesJson: string;
  methods: string;
};

const EMPTY_CAPABILITIES = JSON.stringify(
  {
    traversal: { incoming: false, edgeProperties: false },
    resources: false,
  },
  null,
  2,
);

const blankForm = (): FormState => ({
  adapterType: "",
  baseUrl: "",
  authKind: "bearer",
  authHeader: "",
  credentialsId: "",
  secret: "",
  supportedTriggers: "",
  capabilitiesJson: EMPTY_CAPABILITIES,
  methods: "",
});

const splitList = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

function authLabel(authStrategy: unknown): string {
  if (
    authStrategy &&
    typeof authStrategy === "object" &&
    "kind" in authStrategy
  ) {
    const kind = (authStrategy as { kind: unknown }).kind;
    if (kind === "bearer") return "Bearer token";
    if (kind === "shared_secret") return "Shared secret";
  }
  return "—";
}

export default function RemoteAdaptersPage() {
  const utils = trpc.useUtils();
  const adapters = trpc.views.remoteAdapter.list.useQuery();

  const { mutateAsync: upsertAdapter, isLoading: isSaving } =
    trpc.views.remoteAdapter.upsertFromManifest.useMutation();
  const { mutateAsync: deleteAdapter } =
    trpc.views.remoteAdapter.delete.useMutation();

  const [editing, setEditing] = useState<FormState | null>(null);
  const [isEdit, setIsEdit] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [loadingSlug, setLoadingSlug] = useState<string | null>(null);
  const [confirmDeleteSlug, setConfirmDeleteSlug] = useState<string | null>(
    null,
  );

  const openAdd = () => {
    setIsEdit(false);
    setFormError(null);
    setEditing(blankForm());
  };

  const openEdit = async (adapterType: string) => {
    setFormError(null);
    setLoadingSlug(adapterType);
    try {
      const manifest = await utils.views.remoteAdapter.get.fetch({
        adapterType,
      });
      if (!manifest) {
        setFormError("That adapter could not be loaded.");
        return;
      }
      setIsEdit(true);
      setEditing({
        adapterType: manifest.adapterType,
        baseUrl: manifest.baseUrl,
        authKind: manifest.authStrategy.kind,
        authHeader:
          manifest.authStrategy.kind === "shared_secret"
            ? manifest.authStrategy.header ?? ""
            : "",
        credentialsId: manifest.credentialsId ?? "",
        secret: "",
        supportedTriggers: manifest.supportedTriggers.join(", "),
        capabilitiesJson: JSON.stringify(manifest.runtimeCapabilities, null, 2),
        methods: manifest.methods.join(", "),
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSlug(null);
    }
  };

  const closeForm = () => {
    setEditing(null);
    setFormError(null);
  };

  const setField = <K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ) => {
    setEditing((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const importManifestText = (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setFormError("That file is not valid JSON.");
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      setFormError("The manifest file should be a JSON object.");
      return;
    }
    const m = parsed as Record<string, unknown>;
    const auth =
      m.authStrategy && typeof m.authStrategy === "object"
        ? (m.authStrategy as Record<string, unknown>)
        : {};
    const authKind: AuthKind = auth.kind === "shared_secret" ? "shared_secret" : "bearer";
    setFormError(null);
    setEditing({
      adapterType: typeof m.adapterType === "string" ? m.adapterType : "",
      baseUrl: typeof m.baseUrl === "string" ? m.baseUrl : "",
      authKind,
      authHeader: typeof auth.header === "string" ? auth.header : "",
      credentialsId:
        typeof m.credentialsId === "string" ? m.credentialsId : "",
      secret: "",
      supportedTriggers: Array.isArray(m.supportedTriggers)
        ? m.supportedTriggers.filter((t) => typeof t === "string").join(", ")
        : "",
      capabilitiesJson:
        m.runtimeCapabilities !== undefined
          ? JSON.stringify(m.runtimeCapabilities, null, 2)
          : EMPTY_CAPABILITIES,
      methods: Array.isArray(m.methods)
        ? m.methods.filter((t) => typeof t === "string").join(", ")
        : "",
    });
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    importManifestText(text);
  };

  const handleSave = async () => {
    if (!editing) return;
    setFormError(null);

    if (!editing.adapterType.trim()) {
      setFormError("Give the adapter a name.");
      return;
    }
    if (!editing.baseUrl.trim()) {
      setFormError("Set the adapter address.");
      return;
    }
    if (!isEdit && !editing.secret.trim()) {
      setFormError("Enter the secret Listen-Fire authenticates to the adapter with.");
      return;
    }

    let runtimeCapabilities: RuntimeCapabilitiesInput;
    try {
      // Admin JSON editor: the textarea content is the manifest's
      // runtimeCapabilities. Validated server-side by the upsert input
      // schema; the boundary cast just hands the parsed blob to the
      // structured field.
      runtimeCapabilities = JSON.parse(
        editing.capabilitiesJson,
      ) as RuntimeCapabilitiesInput;
    } catch {
      setFormError("Capabilities must be valid JSON.");
      return;
    }

    const authStrategy =
      editing.authKind === "shared_secret"
        ? editing.authHeader.trim()
          ? { kind: "shared_secret" as const, header: editing.authHeader.trim() }
          : { kind: "shared_secret" as const }
        : { kind: "bearer" as const };

    const trimmedSecret = editing.secret.trim();
    try {
      await upsertAdapter({
        adapterType: editing.adapterType.trim(),
        baseUrl: editing.baseUrl.trim(),
        authStrategy,
        // A newly-entered secret mints a fresh REMOTE credential bound to this
        // adapter (rotation on edit). With no new secret, round-trip the
        // existing FK so editing other fields keeps the stored credential —
        // the upsert would otherwise null it out.
        ...(trimmedSecret ? { secret: trimmedSecret } : {}),
        ...(editing.credentialsId.trim()
          ? { credentialsId: editing.credentialsId.trim() }
          : {}),
        supportedTriggers: splitList(editing.supportedTriggers),
        runtimeCapabilities,
        methods: splitList(editing.methods),
      });
      closeForm();
      utils.views.remoteAdapter.list.invalidate();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (adapterType: string) => {
    await deleteAdapter({ adapterType });
    setConfirmDeleteSlug(null);
    utils.views.remoteAdapter.list.invalidate();
  };

  const rows = adapters.data ?? [];

  return (
    <Card>
      <p className="text-[12px] text-gray-400">
        Remote adapters let Listen-Fire talk to a system we don&rsquo;t host
        ourselves — you point Listen-Fire at the adapter&rsquo;s address and it
        handles reading and writing data there. Install one from a manifest
        file, then edit its details here.
      </p>

      {editing ? (
        <div className="mt-4 rounded-md border border-gray-200 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-medium text-gray-900">
              {isEdit ? "Edit adapter" : "Add adapter"}
            </h2>
          </div>

          {/* Install from a manifest file */}
          <div className="mt-3 rounded-md bg-gray-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className={labelClass}>Install from file</span>
              <label className={`${btnSecondary} cursor-pointer`}>
                Choose manifest file
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    void handleFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <p className="mt-1.5 text-[11px] text-gray-400">
              Paste the manifest below or choose a file to fill in the form.
              You can still edit every field afterwards.
            </p>
            <textarea
              className={`${inputClass} mt-2 font-mono text-[11px]`}
              rows={4}
              placeholder='{ "adapterType": "...", "baseUrl": "...", ... }'
              onChange={(e) => {
                if (e.target.value.trim()) importManifestText(e.target.value);
              }}
            />
          </div>

          {/* Parsed fields */}
          <div className="mt-4 space-y-4">
            <div>
              <label className={labelClass}>Name</label>
              <input
                className={`${inputClass} mt-1.5`}
                value={editing.adapterType}
                onChange={(e) => setField("adapterType", e.target.value)}
                placeholder="my-crm"
              />
              <p className="mt-1 text-[11px] text-gray-400">
                A short slug Listen-Fire uses to refer to this adapter.
              </p>
            </div>

            <div>
              <label className={labelClass}>Adapter address</label>
              <input
                className={`${inputClass} mt-1.5`}
                value={editing.baseUrl}
                onChange={(e) => setField("baseUrl", e.target.value)}
                placeholder="https://adapter.example.com"
              />
            </div>

            <div>
              <label className={labelClass}>Authentication</label>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-2">
                <label className="flex items-center gap-1.5 text-[13px] text-gray-700">
                  <input
                    type="radio"
                    checked={editing.authKind === "bearer"}
                    onChange={() => setField("authKind", "bearer")}
                  />
                  Bearer token
                </label>
                <label className="flex items-center gap-1.5 text-[13px] text-gray-700">
                  <input
                    type="radio"
                    checked={editing.authKind === "shared_secret"}
                    onChange={() => setField("authKind", "shared_secret")}
                  />
                  Shared secret
                </label>
              </div>
              {editing.authKind === "shared_secret" && (
                <input
                  className={`${inputClass} mt-2`}
                  value={editing.authHeader}
                  onChange={(e) => setField("authHeader", e.target.value)}
                  placeholder="Header name (optional, e.g. X-Adapter-Secret)"
                />
              )}
            </div>

            <div>
              <label className={labelClass}>
                {editing.authKind === "bearer" ? "Bearer token" : "Secret"}
              </label>
              <input
                type="password"
                autoComplete="new-password"
                className={`${inputClass} mt-1.5 font-mono`}
                value={editing.secret}
                onChange={(e) => setField("secret", e.target.value)}
                placeholder={
                  editing.credentialsId
                    ? "Enter a new secret to replace the stored one"
                    : "Paste the adapter's secret"
                }
              />
              <p className="mt-1 text-[11px] text-gray-400">
                {editing.credentialsId
                  ? "A secret is already stored for this adapter. Leave blank to keep it, or enter a new one to replace it."
                  : "Listen-Fire encrypts this and uses it to authenticate to the adapter. It is stored bound to this adapter and never leaves the server."}
              </p>
            </div>

            <div>
              <label className={labelClass}>Supported triggers</label>
              <input
                className={`${inputClass} mt-1.5`}
                value={editing.supportedTriggers}
                onChange={(e) =>
                  setField("supportedTriggers", e.target.value)
                }
                placeholder="record.created, record.updated"
              />
              <p className="mt-1 text-[11px] text-gray-400">
                Comma-separated.
              </p>
            </div>

            <div>
              <label className={labelClass}>Methods</label>
              <input
                className={`${inputClass} mt-1.5`}
                value={editing.methods}
                onChange={(e) => setField("methods", e.target.value)}
                placeholder="manifest, listEntryPoints, getFieldValue"
              />
              <p className="mt-1 text-[11px] text-gray-400">
                Comma-separated list of operations the adapter implements.
              </p>
            </div>

            <div>
              <label className={labelClass}>Capabilities</label>
              <textarea
                className={`${inputClass} mt-1.5 font-mono text-[11px]`}
                rows={8}
                value={editing.capabilitiesJson}
                onChange={(e) =>
                  setField("capabilitiesJson", e.target.value)
                }
              />
              <p className="mt-1 text-[11px] text-gray-400">
                What the adapter can do, as JSON.
              </p>
            </div>
          </div>

          {formError && (
            <p className="mt-3 text-[12px] text-red-600">{formError}</p>
          )}

          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className={btnPrimary}
            >
              {isEdit ? "Save changes" : "Add adapter"}
            </button>
            <button onClick={closeForm} className={btnSecondary}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <button onClick={openAdd} className={btnPrimary}>
            Add adapter
          </button>
        </div>
      )}

      {/* Adapter list */}
      {!editing && (
        <div className="mt-6">
          {adapters.isLoading && (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div
                  key={i}
                  className="h-12 animate-pulse rounded-md bg-gray-100"
                />
              ))}
            </div>
          )}

          {!adapters.isLoading && rows.length === 0 && (
            <div className="rounded-md border border-dashed border-gray-200 px-4 py-8 text-center">
              <p className="text-[13px] font-semibold text-gray-900">
                No remote adapters yet
              </p>
              <p className="mx-auto mt-1 max-w-sm text-[12px] text-gray-400">
                A remote adapter connects Listen-Fire to a system you host yourself.
                Install one from its manifest file to get started.
              </p>
              <button onClick={openAdd} className={`${btnPrimary} mt-4`}>
                Add adapter
              </button>
            </div>
          )}

          {!adapters.isLoading &&
            rows.map((adapter) => (
              <div
                key={adapter.id}
                className="group flex items-start gap-3 border-b border-gray-100 py-3 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-gray-900">
                      {adapter.adapterType}
                    </span>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                      {authLabel(adapter.authStrategy)}
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <code className="truncate rounded bg-gray-50 px-2 py-1 text-[11px] font-mono text-gray-600">
                      {adapter.baseUrl}
                    </code>
                  </div>
                  <div className="mt-0.5 text-[11px] text-gray-400">
                    Updated{" "}
                    {new Date(adapter.updatedAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
                  {confirmDeleteSlug === adapter.adapterType ? (
                    <>
                      <button
                        onClick={() => handleDelete(adapter.adapterType)}
                        className="rounded px-2 py-1 text-[12px] text-red-600 hover:bg-red-50"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmDeleteSlug(null)}
                        className="rounded px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-100"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => void openEdit(adapter.adapterType)}
                        disabled={loadingSlug === adapter.adapterType}
                        className="rounded px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                      >
                        {loadingSlug === adapter.adapterType
                          ? "Loading…"
                          : "Edit"}
                      </button>
                      <button
                        onClick={() =>
                          setConfirmDeleteSlug(adapter.adapterType)
                        }
                        className="rounded px-2 py-1 text-[12px] text-gray-500 hover:bg-gray-100"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
