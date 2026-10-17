"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";

import { btnPrimary, btnSecondary, inputClass, labelClass } from "./styles";

type Declaration =
  RouterOutputs["views"]["remoteAdapter"]["credentials"]["declarations"][number];

/**
 * The provider credentials one installed module declares, the ones the team
 * has created for each, and a form to add one: the declared fields for a
 * static credential, or a name and a sign-in at the provider for an OAuth one.
 * Renders nothing for a module that declares none.
 */
export function ModuleCredentials({
  adapterType,
  displayName,
}: {
  adapterType: string;
  displayName: string;
}) {
  const listed = trpc.views.remoteAdapter.credentials.useQuery({ adapterType });

  if (listed.isLoading) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[12px] text-gray-400">
        <Loader2 size={12} className="animate-spin" /> Loading credentials…
      </div>
    );
  }
  if (listed.error) {
    return <p className="mt-2 text-[12px] text-red-600">{listed.error.message}</p>;
  }
  const declarations = listed.data?.declarations ?? [];
  if (declarations.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {declarations.map((declaration) => (
        <DeclarationRow
          key={declaration.name}
          adapterType={adapterType}
          displayName={displayName}
          redirectUri={listed.data?.redirectUri ?? ""}
          declaration={declaration}
        />
      ))}
    </div>
  );
}

function DeclarationRow({
  adapterType,
  displayName,
  redirectUri,
  declaration,
}: {
  adapterType: string;
  displayName: string;
  redirectUri: string;
  declaration: Declaration;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="rounded-md border border-gray-100 bg-gray-50/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-gray-600">
            {declaration.name}
          </span>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
            {declaration.kind === "oauth2" ? "Sign in" : "Key entry"}
          </span>
        </div>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[12px] font-medium text-gray-700 hover:bg-gray-50"
          >
            <Plus size={12} /> Add credential
          </button>
        )}
      </div>

      {declaration.credentials.length === 0 ? (
        <p className="mt-1.5 text-[12px] text-gray-400">No credentials yet.</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1">
          {declaration.credentials.map((credential) => (
            <li key={credential.id}>
              <code className="rounded bg-white px-2 py-1 font-mono text-[11px] text-gray-600">
                {credential.name}
              </code>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <AddCredentialForm
          adapterType={adapterType}
          displayName={displayName}
          redirectUri={redirectUri}
          declaration={declaration}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function AddCredentialForm({
  adapterType,
  displayName,
  redirectUri,
  declaration,
  onClose,
}: {
  adapterType: string;
  displayName: string;
  redirectUri: string;
  declaration: Declaration;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const { mutateAsync: createStatic, isLoading: isSaving } =
    trpc.views.remoteAdapter.createStaticCredential.useMutation();
  const { mutateAsync: beginOAuth, isLoading: isConnecting } =
    trpc.views.remoteAdapter.beginOAuthCredential.useMutation();

  const [name, setName] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const target = {
    adapterType,
    declaredCredential: declaration.name,
    name: name.trim(),
    fields,
  };

  const handleAdd = async () => {
    setError(null);
    try {
      await createStatic(target);
      await utils.views.remoteAdapter.credentials.invalidate({ adapterType });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // The whole page goes to the provider; the callback brings the member back
  // to this settings page, which says what was connected.
  const handleConnect = async () => {
    setError(null);
    try {
      const { url } = await beginOAuth(target);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
      <div>
        <label className={labelClass}>Name</label>
        <input
          className={`${inputClass} mt-1.5 bg-white font-mono`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`alice_${adapterType}`}
        />
        <p className="mt-1 text-[11px] text-gray-400">
          Movements refer to this account by this name (
          <code className="rounded bg-gray-100 px-1 text-gray-600">
            connect {adapterType} using {name.trim() || `alice_${adapterType}`}
          </code>
          ). Lower case letters, digits and underscores.
        </p>
      </div>

      {declaration.fields.map((field) => (
        <div key={field.name}>
          <label className={labelClass}>
            {field.label}
            {field.optional && (
              <span className="font-normal text-gray-400"> (optional)</span>
            )}
          </label>
          <input
            type={field.secret ? "password" : "text"}
            autoComplete={field.secret ? "new-password" : "off"}
            className={`${inputClass} mt-1.5 bg-white ${field.secret ? "font-mono" : ""}`}
            value={fields[field.name] ?? ""}
            onChange={(e) =>
              setFields((prev) => ({ ...prev, [field.name]: e.target.value }))
            }
            placeholder={`${field.label}...`}
          />
        </div>
      ))}

      {declaration.kind === "oauth2" &&
        (declaration.signInAvailable ? (
          <p className="text-[11px] text-gray-400">
            You sign in at the provider as the account this credential acts as.
            The provider&rsquo;s OAuth app must list{" "}
            <code className="rounded bg-gray-100 px-1 text-gray-600">{redirectUri}</code>{" "}
            as a redirect URL.
          </p>
        ) : (
          <p className="text-[12px] text-gray-500">
            This install has no OAuth app for {declaration.name}, so nobody can
            sign in to it yet. Reinstall {displayName} with the OAuth app&rsquo;s
            client id (and secret) for {declaration.name}.
          </p>
        ))}

      {error && <p className="text-[12px] text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        {declaration.kind === "oauth2" ? (
          <button
            onClick={handleConnect}
            disabled={!name.trim() || !declaration.signInAvailable || isConnecting}
            className={btnPrimary}
          >
            {isConnecting ? "Connecting..." : `Connect ${displayName}`}
          </button>
        ) : (
          <button
            onClick={handleAdd}
            disabled={!name.trim() || isSaving}
            className={btnPrimary}
          >
            {isSaving ? "Saving..." : "Add credential"}
          </button>
        )}
        <button onClick={onClose} className={btnSecondary}>
          Cancel
        </button>
      </div>
    </div>
  );
}
