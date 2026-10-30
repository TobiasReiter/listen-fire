"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Modal } from "@/components/ontology/modal";
import { ExternalServiceType } from "#trpc";
import { Select } from "@/components/select";
import { ServiceIcon } from "@/components/service-icon";
import { openDriveSpreadsheetPicker } from "@/components/movements/connect-actions/google-drive-picker";
import { GMAIL_UNAVAILABLE_NOTE, gmailConnectControls } from "@/lib/gmail-connect";

const inputClass =
  "w-full rounded-md border border-gray-200 px-3 py-2 text-[13px] focus:border-gray-400 focus:outline-none";

function typeIcon(type: string) {
  return <ServiceIcon type={type} className="h-3.5 w-3.5 text-gray-400" />;
}

const CREDENTIAL_TYPE_OPTIONS = [
  { label: "Affinity", value: ExternalServiceType.AFFINITY, icon: typeIcon(ExternalServiceType.AFFINITY) },
  { label: "Airtable", value: ExternalServiceType.AIRTABLE, icon: typeIcon(ExternalServiceType.AIRTABLE) },
  { label: "Attio", value: ExternalServiceType.ATTIO, icon: typeIcon(ExternalServiceType.ATTIO) },
  { label: "KIPP Valuations", value: ExternalServiceType.NATIVE_VALUATIONS, icon: typeIcon(ExternalServiceType.NATIVE_VALUATIONS) },
  { label: "Dealroom", value: ExternalServiceType.DEALROOM, icon: typeIcon(ExternalServiceType.DEALROOM) },
  { label: "Dropbox", value: ExternalServiceType.DROPBOX, icon: typeIcon(ExternalServiceType.DROPBOX) },
  { label: "Evertrace", value: ExternalServiceType.EVERTRACE, icon: typeIcon(ExternalServiceType.EVERTRACE) },
  { label: "Gmail", value: ExternalServiceType.GOOGLE_GMAIL, icon: typeIcon(ExternalServiceType.GOOGLE_GMAIL) },
  { label: "Google Drive", value: ExternalServiceType.GOOGLE, icon: typeIcon(ExternalServiceType.GOOGLE) },
  { label: "Granola", value: ExternalServiceType.GRANOLA, icon: typeIcon(ExternalServiceType.GRANOLA) },
  { label: "Slack", value: ExternalServiceType.SLACK, icon: typeIcon(ExternalServiceType.SLACK) },
];

const OAUTH_TYPES = new Set([
  ExternalServiceType.SLACK,
  ExternalServiceType.AIRTABLE,
  ExternalServiceType.ATTIO,
  ExternalServiceType.GOOGLE,
  ExternalServiceType.DROPBOX,
]);

const OAUTH_LABELS: Partial<Record<ExternalServiceType, string>> = {
  [ExternalServiceType.SLACK]: "Slack",
  [ExternalServiceType.AIRTABLE]: "Airtable",
  [ExternalServiceType.ATTIO]: "Attio",
  [ExternalServiceType.GOOGLE]: "Google Drive",
  [ExternalServiceType.GOOGLE_GMAIL]: "Gmail",
  [ExternalServiceType.DROPBOX]: "Dropbox",
};

function useOAuthConnect(options: {
  type: ExternalServiceType | "";
  onConnected: (claimToken: string) => void;
}) {
  const { mutateAsync: getSlackUrl, isLoading: slackLoading } =
    trpc.views.credentials.slackConnectUrl.useMutation();
  const { mutateAsync: getAirtableUrl, isLoading: airtableLoading } =
    trpc.views.credentials.airtableConnectUrl.useMutation();
  const { mutateAsync: getAttioUrl, isLoading: attioLoading } =
    trpc.views.credentials.attioConnectUrl.useMutation();
  const { mutateAsync: getGoogleUrl, isLoading: googleLoading } =
    trpc.views.credentials.googleConnectUrl.useMutation();
  const { mutateAsync: getGmailUrl, isLoading: gmailLoading } =
    trpc.views.credentials.gmailConnectUrl.useMutation();
  const { mutateAsync: getDropboxUrl, isLoading: dropboxLoading } =
    trpc.views.credentials.dropboxConnectUrl.useMutation();

  const isLoading =
    slackLoading ||
    airtableLoading ||
    attioLoading ||
    googleLoading ||
    gmailLoading ||
    dropboxLoading;

  const urlGetters: Partial<Record<ExternalServiceType, () => Promise<string | undefined>>> = {
    [ExternalServiceType.SLACK]: getSlackUrl,
    [ExternalServiceType.AIRTABLE]: getAirtableUrl,
    [ExternalServiceType.ATTIO]: getAttioUrl,
    [ExternalServiceType.GOOGLE]: getGoogleUrl,
    [ExternalServiceType.GOOGLE_GMAIL]: getGmailUrl,
    [ExternalServiceType.DROPBOX]: getDropboxUrl,
  };

  const connect = async () => {
    if (!options.type) return;
    const getUrl = urlGetters[options.type];
    if (!getUrl) return;

    const url = await getUrl();
    if (!url) return;
    window.open(url, "_blank");

    const ch = new BroadcastChannel("listen-fire-oauth");
    ch.onmessage = (event) => {
      const claimToken = event.data?.claimToken;
      if (claimToken) {
        ch.close();
        options.onConnected(claimToken);
      }
    };
  };

  return { connect, isLoading };
}

/** Credential types this modal has a working connect flow for (OAuth or
 *  API key). Pages offering a "Connect" affordance for a specific service
 *  should gate on this so they never open a dead-end form. */
export const CONNECTABLE_CREDENTIAL_TYPES: ReadonlySet<string> = new Set(
  CREDENTIAL_TYPE_OPTIONS.map((o) => o.value as string),
);

/**
 * Manage which spreadsheets a Google credential has been granted access to.
 * Under `drive.file` scope this is the only way to add/list/remove the files
 * the credential can reach; the granted set feeds the Sheets adapter's
 * catalog. Shown when reconnecting a Google Drive credential.
 */
function GoogleSheetsGrants({ credentialsId }: { credentialsId: string }) {
  const utils = trpc.useUtils();
  const ref = { credentialsId };
  const grants = trpc.views.googleSheets.listGrants.useQuery(ref);
  const grant = trpc.views.googleSheets.grant.useMutation();
  const revoke = trpc.views.googleSheets.revoke.useMutation();
  const [picking, setPicking] = useState(false);

  const invalidate = () => utils.views.googleSheets.listGrants.invalidate(ref);

  const addSheet = useCallback(async () => {
    setPicking(true);
    try {
      const token = await utils.client.views.googleSheets.pickerToken.query(ref);
      const picked = await openDriveSpreadsheetPicker(token);
      for (const sheet of picked) {
        await grant.mutateAsync({ credentialsId, spreadsheetId: sheet.id, name: sheet.name });
      }
      if (picked.length > 0) await invalidate();
    } catch (err) {
      console.error("Failed to connect a Google Sheet:", err);
    } finally {
      setPicking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialsId]);

  const removeSheet = useCallback(
    async (spreadsheetId: string) => {
      await revoke.mutateAsync({ credentialsId, spreadsheetId });
      await invalidate();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [credentialsId],
  );

  return (
    <div className="rounded-md border border-gray-100 bg-gray-50/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-medium text-gray-600">Connected spreadsheets</span>
        <button
          type="button"
          onClick={() => void addSheet()}
          disabled={picking}
          className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[12px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {picking ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          Connect a sheet
        </button>
      </div>
      {grants.isLoading ? (
        <div className="flex items-center gap-1.5 text-[12px] text-gray-400">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : (grants.data?.length ?? 0) === 0 ? (
        <p className="text-[12px] text-gray-400">
          No spreadsheets connected yet. Connect one so movements can write to its tables.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {grants.data!.map((g) => (
            <li
              key={g.spreadsheetId}
              className="flex items-center justify-between rounded-md bg-white px-2.5 py-1.5"
            >
              <span className="truncate text-[12px] text-gray-700">
                {g.name ?? g.spreadsheetId}
              </span>
              <button
                type="button"
                onClick={() => void removeSheet(g.spreadsheetId)}
                aria-label="Remove spreadsheet"
                className="ml-2 shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-gray-400">
        Google grants access one spreadsheet at a time. Connect the ones your movements
        write to; the rest stay private.
      </p>
    </div>
  );
}

export function IntegrationModal({
  isOpen,
  onClose,
  existing,
  initialType,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Reconnect mode: re-run the auth flow for this credential and save
   *  the fresh tokens onto the SAME row. The name (and therefore the
   *  import name movements reference) is locked — reconnecting must
   *  never break `import { … } from credentials`. */
  existing?: { id: string; name: string; type: string };
  /** Preselect the credential type (e.g. the Adapters page's Connect
   *  button). Ignored when editing an existing credential. */
  initialType?: ExternalServiceType;
}) {
  const utils = trpc.useUtils();
  const connectMethods = trpc.views.credentials.connectMethods.useQuery();
  const gmailPolicy = trpc.views.credentials.gmailConnectPolicy.useQuery();
  const { mutateAsync: addCredential } =
    trpc.views.credentials.addCredential.useMutation();
  const { mutateAsync: updateCredential } =
    trpc.views.credentials.updateCredential.useMutation();

  const [name, setName] = useState("");
  const [type, setType] = useState<ExternalServiceType | "">("");
  const [isSaving, setIsSaving] = useState(false);
  const nameManuallyEdited = useRef(false);

  // API key credentials
  const [affinityApiKey, setAffinityApiKey] = useState("");
  const [granolaApiKey, setGranolaApiKey] = useState("");
  const [evertraceApiKey, setEvertraceApiKey] = useState("");
  const [dealroomApiKey, setDealroomApiKey] = useState("");
  const [attioAccessToken, setAttioAccessToken] = useState("");
  // Gmail, under the delegated method: the deployment's service account acts as
  // the mailbox, so the address is the whole credential.
  const [gmailMailbox, setGmailMailbox] = useState("");
  // Gmail, under the sign-in method, for an admin who authorised the mailbox
  // themselves. The address and the scopes come back from Google, never from
  // here.
  const [gmailRefreshToken, setGmailRefreshToken] = useState("");
  // Listen-Fire Valuations auto-mints its api-key server-side. The user only
  // provides an optional Base URL override (empty = use env default).
  const [valuationsBaseUrl, setValuationsBaseUrl] = useState("");

  // OAuth claim token (replaces per-type credential state)
  const [claimToken, setClaimToken] = useState<string | null>(null);

  const { connect: oauthConnect, isLoading: oauthLoading } = useOAuthConnect({
    type,
    onConnected: setClaimToken,
  });

  useEffect(() => {
    if (!isOpen) return;
    if (existing) {
      setName(existing.name);
      setType(existing.type as ExternalServiceType);
      nameManuallyEdited.current = true;
    } else if (initialType) {
      const option = CREDENTIAL_TYPE_OPTIONS.find((o) => o.value === initialType);
      setType(initialType);
      setName(option?.label ?? "");
      nameManuallyEdited.current = false;
    } else {
      setName("");
      setType("");
      nameManuallyEdited.current = false;
    }
    setAffinityApiKey("");
    setGranolaApiKey("");
    setEvertraceApiKey("");
    setDealroomApiKey("");
    setAttioAccessToken("");
    setGmailMailbox("");
    setGmailRefreshToken("");
    setValuationsBaseUrl("");
    setClaimToken(null);
  }, [isOpen, existing, initialType]);

  // A deployment that registered no Attio OAuth app connects Attio with a
  // pasted workspace access token instead. The server owns that decision (it
  // is the same one the connect link and the movement catalog make); we only
  // render what it reports.
  const attioKeyEntry =
    type === ExternalServiceType.ATTIO &&
    connectMethods.data?.[ExternalServiceType.ATTIO] === "key-entry";

  // Gmail is connected one of three ways depending on the installation: a
  // Google sign-in AS the mailbox, a refresh token the mailbox already granted,
  // or a mailbox address the deployment already has access to. Same
  // server-owned derivation as Attio's above.
  const isGmail = type === ExternalServiceType.GOOGLE_GMAIL;
  const gmail = gmailConnectControls(isGmail ? gmailPolicy.data : undefined);
  const gmailSignIn = gmail.signIn;
  const gmailMailboxEntry = gmail.mailbox;
  const gmailUnavailable =
    isGmail && !gmail.signIn && !gmail.refreshToken && !gmail.mailbox && gmailPolicy.isFetched;

  const isOAuthType = !!type && ((OAUTH_TYPES.has(type) && !attioKeyEntry) || gmailSignIn);
  const oauthConnected = isOAuthType && !!claimToken;

  const hasCredentials =
    (type === ExternalServiceType.AFFINITY && !!affinityApiKey) ||
    (type === ExternalServiceType.GRANOLA && !!granolaApiKey) ||
    (type === ExternalServiceType.EVERTRACE && !!evertraceApiKey) ||
    (type === ExternalServiceType.DEALROOM && !!dealroomApiKey) ||
    (attioKeyEntry && !!attioAccessToken) ||
    (gmailMailboxEntry && !!gmailMailbox.trim()) ||
    (gmail.refreshToken && !!gmailRefreshToken.trim()) ||
    // Valuations needs no user-supplied credential — clicking save mints one.
    type === ExternalServiceType.NATIVE_VALUATIONS ||
    oauthConnected;

  const handleSave = async () => {
    if (!name.trim() || !type) return;
    setIsSaving(true);

    try {
      if (type === ExternalServiceType.AFFINITY) {
        if (!affinityApiKey) return;
        if (existing) {
          await updateCredential({ id: existing.id, name: name.trim(), type, credentials: { apiKey: affinityApiKey } });
        } else {
          await addCredential({ name: name.trim(), type, credentials: { apiKey: affinityApiKey } });
        }
      } else if (type === ExternalServiceType.GRANOLA) {
        if (!granolaApiKey) return;
        if (existing) {
          await updateCredential({ id: existing.id, name: name.trim(), type, credentials: { apiKey: granolaApiKey } });
        } else {
          await addCredential({ name: name.trim(), type, credentials: { apiKey: granolaApiKey } });
        }
      } else if (type === ExternalServiceType.EVERTRACE) {
        if (!evertraceApiKey) return;
        if (existing) {
          await updateCredential({ id: existing.id, name: name.trim(), type, credentials: { apiKey: evertraceApiKey } });
        } else {
          await addCredential({ name: name.trim(), type, credentials: { apiKey: evertraceApiKey } });
        }
      } else if (type === ExternalServiceType.DEALROOM) {
        if (!dealroomApiKey) return;
        if (existing) {
          await updateCredential({ id: existing.id, name: name.trim(), type, credentials: { apiKey: dealroomApiKey } });
        } else {
          await addCredential({ name: name.trim(), type, credentials: { apiKey: dealroomApiKey } });
        }
      } else if (gmailMailboxEntry) {
        const mailbox = gmailMailbox.trim();
        if (!mailbox) return;
        const gmailType = ExternalServiceType.GOOGLE_GMAIL;
        if (existing) {
          await updateCredential({ id: existing.id, name: name.trim(), type: gmailType, credentials: { mailbox } });
        } else {
          await addCredential({ name: name.trim(), type: gmailType, credentials: { mailbox } });
        }
      } else if (gmail.refreshToken && gmailRefreshToken.trim() && !claimToken) {
        // Only when the user actually pasted one — the sign-in button is right
        // beside this field, and a finished sign-in wins.
        const refreshToken = gmailRefreshToken.trim();
        const gmailType = ExternalServiceType.GOOGLE_GMAIL;
        if (existing) {
          await updateCredential({ id: existing.id, name: name.trim(), type: gmailType, credentials: { refreshToken } });
        } else {
          await addCredential({ name: name.trim(), type: gmailType, credentials: { refreshToken } });
        }
      } else if (attioKeyEntry) {
        if (!attioAccessToken) return;
        const credentials = { accessToken: attioAccessToken };
        if (existing) {
          await updateCredential({ id: existing.id, name: name.trim(), type: ExternalServiceType.ATTIO, credentials });
        } else {
          await addCredential({ name: name.trim(), type: ExternalServiceType.ATTIO, credentials });
        }
      } else if (type === ExternalServiceType.NATIVE_VALUATIONS) {
        // Server auto-mints the api-key and registers it for echo
        // suppression. We only send the optional baseUrl override.
        const baseUrl = valuationsBaseUrl.trim() || undefined;
        if (existing) {
          await updateCredential({ id: existing.id, name: name.trim(), type, baseUrl });
        } else {
          await addCredential({ name: name.trim(), type, baseUrl });
        }
      } else if (claimToken) {
        const params = { name: name.trim(), type: type as ExternalServiceType, claimToken };
        if (existing) {
          await updateCredential({ id: existing.id, ...params });
        } else {
          await addCredential(params);
        }
      }
      utils.views.credentials.getCredentials.invalidate();
      utils.views.connections.getAll.invalidate();
      onClose();
    } catch (error) {
      console.error("Failed to save integration:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const oauthLabel = type ? OAUTH_LABELS[type] ?? "" : "";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={existing ? "Reconnect account" : "Add credential"}
    >
      <div className="flex flex-col gap-3 p-5">
        {/* Type + Name row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-gray-600">
              Type
            </label>
            <Select
              value={type}
              onChange={(v) => {
                setType(v as ExternalServiceType);
                if (!nameManuallyEdited.current) {
                  const option = CREDENTIAL_TYPE_OPTIONS.find((o) => o.value === v);
                  if (option) setName(option.label);
                }
              }}
              disabled={!!existing}
              options={CREDENTIAL_TYPE_OPTIONS}
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-gray-600">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                nameManuallyEdited.current = true;
              }}
              placeholder="Credential name..."
              disabled={!!existing}
              className={`${inputClass} disabled:bg-gray-50 disabled:text-gray-500`}
            />
            <p className="mt-1 text-[11px] text-gray-400">
              {existing
                ? "The name stays the same, so anything referring to this account keeps working."
                : "Movements refer to this account by a simplified form of this name."}
            </p>
          </div>
        </div>

        {/* Affinity — API key input */}
        {type === ExternalServiceType.AFFINITY && (
          <div>
            <label className="mb-1 block text-[12px] font-medium text-gray-600">
              API Key
            </label>
            <input
              type="text"
              value={affinityApiKey}
              onChange={(e) => setAffinityApiKey(e.target.value)}
              placeholder="API Key..."
              className={inputClass}
            />
          </div>
        )}

        {/* Granola — API key input */}
        {type === ExternalServiceType.GRANOLA && (
          <div>
            <label className="mb-1 block text-[12px] font-medium text-gray-600">
              API Key
            </label>
            <input
              type="text"
              value={granolaApiKey}
              onChange={(e) => setGranolaApiKey(e.target.value)}
              placeholder="API Key..."
              className={inputClass}
            />
          </div>
        )}

        {/* Evertrace — API key input */}
        {type === ExternalServiceType.EVERTRACE && (
          <div>
            <label className="mb-1 block text-[12px] font-medium text-gray-600">
              API Key
            </label>
            <input
              type="text"
              value={evertraceApiKey}
              onChange={(e) => setEvertraceApiKey(e.target.value)}
              placeholder="API Key..."
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-gray-400">
              Evertrace → API access → your key
            </p>
          </div>
        )}

        {/* Dealroom — API key input */}
        {type === ExternalServiceType.DEALROOM && (
          <div>
            <label className="mb-1 block text-[12px] font-medium text-gray-600">
              API Key
            </label>
            <input
              type="text"
              value={dealroomApiKey}
              onChange={(e) => setDealroomApiKey(e.target.value)}
              placeholder="API Key..."
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-gray-400">
              Dealroom → account settings → API
            </p>
          </div>
        )}

        {/* Attio — access token input, on a deployment with no Attio OAuth app */}
        {attioKeyEntry && (
          <div>
            <label className="mb-1 block text-[12px] font-medium text-gray-600">
              Access token
            </label>
            <input
              type="text"
              value={attioAccessToken}
              onChange={(e) => setAttioAccessToken(e.target.value)}
              placeholder="Access token..."
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-gray-400">
              In Attio: Workspace settings → Developers → New access token. Grant it
              record_permission:read-write, object_configuration:read, list_entry:read-write,
              list_configuration:read, note:read-write, task:read-write, comment:read-write,
              file:read-write, webhook:read-write and user_management:read.
            </p>
          </div>
        )}

        {gmailMailboxEntry && (
          <div>
            <label className="mb-1 block text-[12px] font-medium text-gray-600">
              Mailbox address
            </label>
            <input
              type="email"
              value={gmailMailbox}
              onChange={(e) => setGmailMailbox(e.target.value)}
              placeholder="deals@yourcompany.com"
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-gray-400">
              A real user or shared mailbox in your Google Workspace — a group
              address has no inbox to read. Nobody signs in: a Workspace admin
              grants this deployment access to the mailbox once, and it can then
              read and send as that address and nothing else.
            </p>
          </div>
        )}

        {/* Beside the sign-in button, for a Workspace admin who authorised the
            mailbox themselves rather than handing the browser over. */}
        {gmail.refreshToken && (
          <div>
            <label className="mb-1 block text-[12px] font-medium text-gray-600">
              Or paste a refresh token
            </label>
            <input
              type="password"
              value={gmailRefreshToken}
              onChange={(e) => setGmailRefreshToken(e.target.value)}
              placeholder="Refresh token..."
              autoComplete="off"
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-gray-400">
              For an admin who already authorised the mailbox. It has to come from
              the same Google OAuth client this server is set up with. Which
              mailbox it is, and what it may do, are read from Google.
            </p>
          </div>
        )}

        {gmailUnavailable && (
          <p className="text-[12px] text-gray-500">{GMAIL_UNAVAILABLE_NOTE}</p>
        )}

        {/* Listen-Fire Valuations is intrinsic — we own both sides of the auth.
            On save we mint an api-key with the `valuations` scope, register
            it for echo suppression, and store it server-side. The user only
            optionally overrides the Base URL. */}
        {type === ExternalServiceType.NATIVE_VALUATIONS && (
          <>
            <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-[12px] text-blue-800">
              An integration api-key will be minted automatically when you
              save — no manual key creation needed.
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-gray-600">
                Base URL (optional)
              </label>
              <input
                type="text"
                value={valuationsBaseUrl}
                onChange={(e) => setValuationsBaseUrl(e.target.value)}
                placeholder="http://localhost:3000/api/v1"
                className={inputClass}
              />
              <p className="mt-1 text-[11px] text-gray-400">
                Leave blank to use the default for this environment.
              </p>
            </div>
          </>
        )}

        {/* OAuth types — Connect button or connected indicator */}
        {isOAuthType && (
          <div className="pt-1">
            {oauthConnected ? (
              <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2">
                <svg
                  className="h-4 w-4 text-green-600"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span className="text-[13px] font-medium text-green-700">
                  Connected
                </span>
                <button
                  onClick={oauthConnect}
                  className="ml-auto cursor-pointer text-[12px] text-green-600 hover:text-green-800"
                >
                  Start over
                </button>
              </div>
            ) : (
              <button
                onClick={oauthConnect}
                disabled={oauthLoading}
                className="w-full cursor-pointer rounded-md border border-gray-200 px-4 py-2.5 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-default disabled:opacity-50"
              >
                {oauthLoading
                  ? "Connecting..."
                  : `${existing ? "Reconnect" : "Connect"} ${oauthLabel}`}
              </button>
            )}
            {type === ExternalServiceType.SLACK && (
              <p className="mt-2 text-[11px] text-gray-400">
                TARS joins a public channel automatically the first time it posts there. For it
                to post in (or react to messages in) a{" "}
                <span className="font-medium text-gray-500">private</span> channel, add it first:
                open the channel, then Integrations → Add apps (or type{" "}
                <code className="rounded bg-gray-100 px-1 text-gray-600">/invite</code> and pick
                the TARS app). Bots cannot self-join private channels, so this is required once
                per private channel.
              </p>
            )}
            {gmailSignIn && (
              <p className="mt-2 text-[11px] text-gray-400">
                Sign in as the mailbox itself, not as yourself — the account you
                pick here is the mailbox automations will read and answer. Google
                confines this connection to that one address.
              </p>
            )}
          </div>
        )}

        {/* Google Drive: manage which spreadsheets this credential can reach
            (drive.file grants files one at a time via the Picker). Shown when
            reconnecting an existing Google credential. */}
        {existing && type === ExternalServiceType.GOOGLE && (
          <GoogleSheetsGrants credentialsId={existing.id} />
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3.5">
        <button
          onClick={onClose}
          className="cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-gray-500 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || !type || !hasCredentials || isSaving}
          className="cursor-pointer rounded-md bg-primary px-4 py-1.5 text-[13px] font-medium text-white hover:bg-primary-600 disabled:cursor-default disabled:opacity-40"
        >
          {isSaving ? "Saving..." : existing ? "Save" : "Add credential"}
        </button>
      </div>
    </Modal>
  );
}
