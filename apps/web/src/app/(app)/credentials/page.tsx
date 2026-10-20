"use client";

/**
 * `/credentials` — the Credentials page (user-facing name: "Credentials",
 * matching the movement language's `credentials` import namespace). Merges
 * the previous `/integrations`, `/sources`, and `/destinations` pages into
 * one scrollable page:
 *
 *   1. Credentials — connected accounts, each showing the import name a
 *      movement uses (`import { dev_loop_attio } from credentials`) plus
 *      derived read/write badges and automation counts
 *   2. Source channels — built-in receivers (inbound Email,
 *      WhatsApp, Web upload) with usage counts
 *   3. Custom — any trigger configuration that isn't a first-class
 *      channel or credentialled account
 *
 * The read/write derivation AND the import names live server-side in
 * `connections.getAll` (the import names come from the movement catalog's
 * own projection) so the page renders from a single payload and stays a
 * dumb list.
 *
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import { usePublishPageContext } from "@/components/page-context";
import {
  CONNECTABLE_CREDENTIAL_TYPES,
  IntegrationModal,
} from "@/components/integrations/integration-modal";
import { ImportSnippet } from "@/components/import-snippet";
import { ServiceIcon } from "@/components/service-icon";
import { Modal } from "@/components/ontology/modal";
import {
  Badge,
  Button,
  CardList,
  ListRow,
  PageBody,
  PageHeader,
  SectionHeader,
} from "@/components/ui";

const TYPE_LABELS: Record<string, string> = {
  AFFINITY: "Affinity",
  AIRTABLE: "Airtable",
  ATTIO: "Attio",
  NATIVE_VALUATIONS: "TARS Valuations",
  DEALROOM: "Dealroom",
  DROPBOX: "Dropbox",
  EVERTRACE: "Evertrace",
  GOOGLE: "Google Drive",
  GOOGLE_GMAIL: "Gmail",
  GRANOLA: "Granola",
  MAILGUN: "Mailgun",
  SLACK: "Slack",
  TWILIO: "Twilio",
};

function automationCountLabel(n: number): string {
  if (n === 0) return "Not used yet";
  if (n === 1) return "Used by 1 automation";
  return `Used by ${n} automations`;
}

function ReadWriteBadges({
  reads,
  writes,
}: {
  reads: boolean;
  writes: boolean;
}) {
  if (!reads && !writes) {
    return <Badge tone="gray">Not connected</Badge>;
  }
  return (
    <div className="flex shrink-0 items-center gap-1">
      {reads && (
        <Badge
          tone="blue"
          title="An automation listens to this service for inbound events"
        >
          Reads from
        </Badge>
      )}
      {writes && (
        <Badge
          tone="emerald"
          title="An automation writes records into this service"
        >
          Writes to
        </Badge>
      )}
    </div>
  );
}

export default function ConnectionsPage() {
  usePageTitle("Credentials — TARS");

  const { data } = trpc.views.connections.getAll.useQuery();
  const [modalOpen, setModalOpen] = useState(false);
  const [reconnectTarget, setReconnectTarget] = useState<{
    id: string;
    name: string;
    type: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const integrations = data?.integrations ?? [];
  const sourceChannels = data?.sourceChannels ?? [];
  const custom = data?.custom ?? [];

  // Tell the global assistant which credentials and channels are on screen.
  usePublishPageContext(
    useMemo(
      () => ({
        page: "Credentials",
        entities: [
          ...integrations.map((i) => ({
            kind: "credential",
            id: i.id,
            name: i.name,
          })),
          ...sourceChannels.map((c) => ({
            kind: "channel",
            id: c.kind,
            name: c.name,
          })),
        ].slice(0, 40),
      }),
      [integrations, sourceChannels],
    ),
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Credentials" />

      <PageBody>
        <div className="space-y-10">
          {/* ─── Connected integrations ─── */}
          <section id="integrations">
            <SectionHeader
              title="Connected accounts"
              subtitle="authorised by your team — movements import each one by name from credentials"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setModalOpen(true)}
                >
                  Add credential
                </Button>
              }
            />

            {!data ? (
              <SkeletonRows count={3} />
            ) : integrations.length === 0 ? (
              <EmptyRow text="No accounts connected yet." />
            ) : (
              <CardList>
                {integrations.map((integration) => (
                  <ListRow key={integration.id} className="group">
                    <ServiceIcon
                      type={integration.type}
                      className="h-4 w-4 shrink-0 text-gray-400 opacity-45"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-gray-900">
                          {integration.name}
                        </span>
                        <Badge tone="gray">
                          {TYPE_LABELS[integration.type] ?? integration.type}
                        </Badge>
                      </div>
                      <div className="mt-0.5 text-[12px] text-gray-400">
                        {automationCountLabel(integration.automationCount)}
                      </div>
                      {integration.importNames.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {integration.importNames.map((importName) => (
                            <ImportSnippet
                              key={importName}
                              name={importName}
                              from="credentials"
                            />
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Hover-revealed on pointer devices; always visible on
                        touch, where there is no hover to reveal them. */}
                    <div className="flex shrink-0 items-center gap-1 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      {CONNECTABLE_CREDENTIAL_TYPES.has(integration.type) && (
                        <button
                          onClick={() => setReconnectTarget(integration)}
                          title="Sign in to this account again — fixes expired or revoked access"
                          className="cursor-pointer rounded-md px-2 py-1 text-[12px] font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                        >
                          Reconnect
                        </button>
                      )}
                      <button
                        onClick={() => setDeleteTarget(integration)}
                        title="Remove this account"
                        className="cursor-pointer rounded-md px-2 py-1 text-[12px] font-medium text-gray-500 hover:bg-red-50 hover:text-red-600"
                      >
                        Delete
                      </button>
                    </div>
                    <ReadWriteBadges
                      reads={integration.reads}
                      writes={integration.writes}
                    />
                  </ListRow>
                ))}
              </CardList>
            )}
          </section>

          {/* ─── Personal channels ─── */}
          <section id="personal-channels">
            <SectionHeader
              title="Your messaging accounts"
              subtitle="link a personal account so messages you send reach the system as you"
            />
            <CardList>
              <ConnectTelegramRow />
            </CardList>
          </section>

          {/* ─── Source channels ─── */}
          <section id="receivers">
            <SectionHeader
              title="Where data comes in"
              subtitle="the addresses and numbers you hand out so messages can reach the system"
            />

            {!data ? (
              <SkeletonRows count={3} />
            ) : (
              <CardList>
                {sourceChannels.map((channel) => (
                  <ListRow key={channel.kind}>
                    <ServiceIcon
                      type={channel.kind}
                      className="h-4 w-4 shrink-0 text-gray-400 opacity-45"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-gray-900">
                        {channel.name}
                      </div>
                      <div className="mt-0.5 truncate text-[12px] text-gray-400">
                        {channel.identifier} ·{" "}
                        {automationCountLabel(channel.automationCount)}
                      </div>
                    </div>
                  </ListRow>
                ))}
              </CardList>
            )}
          </section>

          {/* ─── Custom ─── */}
          <section id="custom">
            <SectionHeader
              title="Custom"
              subtitle="one-off automation sources outside the standard channels"
            />

            {!data ? (
              <SkeletonRows count={2} />
            ) : custom.length === 0 ? (
              <EmptyRow text="No custom sources." />
            ) : (
              <CardList>
                {custom.map((row) => (
                  <ListRow key={row.id}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-gray-900">
                          {row.name}
                        </span>
                        <Badge tone="gray">{row.kindLabel}</Badge>
                      </div>
                      {row.configSummary && (
                        <div className="mt-0.5 text-[12px] text-gray-400">
                          {row.configSummary}
                        </div>
                      )}
                    </div>
                  </ListRow>
                ))}
              </CardList>
            )}
          </section>
        </div>
      </PageBody>

      <IntegrationModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
      />
      <IntegrationModal
        isOpen={reconnectTarget !== null}
        onClose={() => setReconnectTarget(null)}
        existing={reconnectTarget ?? undefined}
      />
      <DeleteCredentialDialog
        credential={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}

const MOVEMENT_VALIDITY_LABELS: Record<string, string> = {
  valid: "live",
  invalid: "has problems",
  unverified: "couldn't verify",
};

/**
 * Confirm-before-delete for one credential. Lists everything the
 * deletion would affect — fetched live from `credentialDependents`
 * (movements importing the account, automations receiving events
 * through it, webhook registrations, older configuration) — so the
 * confirmation is informed, never a blind "are you sure?". Deleting
 * with dependents is allowed; the dialog's job is honesty, not
 * prevention.
 */
function DeleteCredentialDialog({
  credential,
  onClose,
}: {
  credential: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: dependents } = trpc.views.connections.credentialDependents.useQuery(
    { id: credential?.id ?? "" },
    { enabled: credential !== null },
  );
  const { mutateAsync: deleteCredential } =
    trpc.views.credentials.deleteCredential.useMutation();

  if (credential === null) return null;

  const movements = dependents?.movements ?? [];
  const automations = dependents?.automations ?? [];
  const olderConfigCount = dependents ? dependents.remoteAdapterCount : 0;
  const hasDependents =
    dependents !== undefined &&
    (movements.length > 0 ||
      automations.length > 0 ||
      dependents.webhookSubscriptionCount > 0 ||
      olderConfigCount > 0);

  const handleDelete = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await deleteCredential({ id: credential.id });
      utils.views.connections.getAll.invalidate();
      utils.views.credentials.getCredentials.invalidate();
      onClose();
    } catch {
      setError("Couldn't delete this credential. Please try again.");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Delete credential">
      <div className="flex flex-col gap-3 p-5">
        <p className="text-[13px] text-gray-700">
          This permanently removes{" "}
          <span className="font-medium">{credential.name}</span> and the
          access it grants.
        </p>

        {!dependents ? (
          <p className="text-[12px] text-gray-400">
            Checking what uses this account…
          </p>
        ) : !hasDependents ? (
          <p className="text-[12px] text-gray-500">
            Nothing currently uses this account.
          </p>
        ) : (
          <div className="flex flex-col gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
            {movements.length > 0 && (
              <div>
                <p className="text-[12px] font-medium text-amber-800">
                  {movements.length === 1
                    ? "1 movement imports this account — it will stop checking and running:"
                    : `${movements.length} movements import this account — they will stop checking and running:`}
                </p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {movements.map((movement) => (
                    <li key={movement.id}>
                      <Link
                        href={`/movements/${movement.id}`}
                        className="text-[12px] text-amber-900 underline decoration-amber-300 hover:decoration-amber-600"
                      >
                        {movement.name}
                      </Link>{" "}
                      <span className="text-[11px] text-amber-700">
                        (
                        {movement.validityStatus
                          ? MOVEMENT_VALIDITY_LABELS[movement.validityStatus] ??
                            movement.validityStatus
                          : "not checked yet"}
                        )
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {automations.length > 0 && (
              <div>
                <p className="text-[12px] font-medium text-amber-800">
                  {automations.length === 1
                    ? "1 automation receives events through this account — it will stop running:"
                    : `${automations.length} automations receive events through this account — they will stop running:`}
                </p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {automations.map((automation) => (
                    <li key={automation.id}>
                      <Link
                        href={`/automations/${automation.id}`}
                        className="text-[12px] text-amber-900 underline decoration-amber-300 hover:decoration-amber-600"
                      >
                        {automation.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {dependents.webhookSubscriptionCount > 0 && (
              <p className="text-[12px] text-amber-800">
                {dependents.webhookSubscriptionCount === 1
                  ? "1 event subscription on the connected service will be removed."
                  : `${dependents.webhookSubscriptionCount} event subscriptions on the connected service will be removed.`}
              </p>
            )}
            {olderConfigCount > 0 && (
              <p className="text-[12px] text-amber-800">
                {olderConfigCount === 1
                  ? "1 item of older configuration references this account and will lose access."
                  : `${olderConfigCount} items of older configuration reference this account and will lose access.`}
              </p>
            )}
          </div>
        )}

        {error && <p className="text-[12px] text-red-600">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3.5">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={handleDelete}
          disabled={!dependents || isDeleting}
        >
          {isDeleting ? "Deleting…" : "Delete credential"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * "Connect Telegram" — two distinct gestures behind one row:
 *
 *   1. Connect the TEAM to the shared Listen-Fire bot. The first click calls
 *      `connections.connectTelegramTeam`, which creates the team's (secret-less)
 *      Telegram credential — the row a movement imports as
 *      `import { … } from credentials` and constructs with
 *      `telegram(credentials: …)`. Idempotent: re-connecting is a no-op.
 *   2. Link YOUR identity. With the team connected, the same click also mints a
 *      one-time deep-link via `connections.connectTelegram` and shows the
 *      `t.me/<bot>?start=<token>` link. Pressing Start in Telegram completes the
 *      bind server-side (the `/start` webhook → `bindTelegramFromStart`) so
 *      messages you send reach the system AS you.
 *
 * The link is single-use and expires (~10 min), so the copy is explicit about
 * opening it now.
 */
function ConnectTelegramRow() {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(
    null,
  );
  const [teamConnected, setTeamConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const utils = trpc.useUtils();
  const { mutateAsync: connectTelegram, isLoading } =
    trpc.views.connections.connectTelegram.useMutation();
  const { mutateAsync: connectTelegramTeam } =
    trpc.views.connections.connectTelegramTeam.useMutation();

  const handleConnect = async () => {
    setError(null);
    setCopied(false);
    try {
      // 1. Connect the team to the shared bot (creates the team credential).
      //    Idempotent — safe to call on every "New link" too.
      await connectTelegramTeam();
      setTeamConnected(true);
      // Refresh the connected-accounts list so the new Telegram credential
      // shows up immediately.
      utils.views.connections.getAll.invalidate();
      // 2. Mint this user's personal deep-link.
      const res = await connectTelegram();
      setLink({ url: res.url, expiresAt: String(res.expiresAt) });
    } catch (e) {
      setError(
        e instanceof Error && /not configured/i.test(e.message)
          ? "Telegram linking isn't set up for this workspace yet."
          : "Couldn't create a Telegram link. Please try again.",
      );
    }
  };

  const handleCopy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      /* clipboard may be unavailable; the link is still shown to copy by hand */
    }
  };

  return (
    <ListRow>
      <ServiceIcon
        type="TELEGRAM"
        className="h-4 w-4 shrink-0 text-gray-400 opacity-45"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-gray-900">
            Telegram
          </span>
          <Badge tone="gray">Personal</Badge>
        </div>
        {!link ? (
          <div className="mt-0.5 text-[12px] text-gray-400">
            Connect your team to the shared TARS bot, then link your Telegram
            account to message TARS directly.
          </div>
        ) : (
          <div className="mt-1 flex flex-col gap-1">
            {teamConnected && (
              <div className="text-[12px] text-emerald-600">
                Your team is connected to the shared TARS bot.
              </div>
            )}
            <div className="text-[12px] text-gray-500">
              Now open Telegram and press{" "}
              <span className="font-medium">Start</span> to link your account:
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate text-[12px] font-medium text-primary underline decoration-primary/30 hover:decoration-primary"
              >
                {link.url}
              </a>
              <button
                onClick={handleCopy}
                className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800"
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
            <div className="mt-1 flex items-center gap-3">
              <div className="rounded-lg border border-gray-200 bg-white p-2">
                <QRCodeSVG value={link.url} size={176} level="M" />
              </div>
              <div className="text-[11px] text-gray-400">
                On your phone? Scan this with your camera to open the bot, then
                press Start.
              </div>
            </div>
            <div className="text-[11px] text-gray-400">
              This link is single-use and expires soon (~10 min) — open it now.
            </div>
          </div>
        )}
        {error && (
          <div className="mt-0.5 text-[12px] text-red-600">{error}</div>
        )}
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={handleConnect}
        disabled={isLoading}
        className="shrink-0"
      >
        {isLoading
          ? "Creating link…"
          : link
            ? "New link"
            : "Connect Telegram"}
      </Button>
    </ListRow>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <CardList>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <div
            className="h-4 w-4 shrink-0 animate-pulse rounded bg-gray-100"
            style={{ animationDelay: `${i * 60}ms` }}
          />
          <div className="flex-1 space-y-1.5">
            <div
              className="h-3.5 w-32 animate-pulse rounded bg-gray-100"
              style={{ animationDelay: `${i * 60}ms` }}
            />
            <div
              className="h-3 w-20 animate-pulse rounded bg-gray-50"
              style={{ animationDelay: `${i * 60 + 30}ms` }}
            />
          </div>
        </div>
      ))}
    </CardList>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-200 px-4 py-4 text-[13px] text-gray-400">
      {text}
    </div>
  );
}
