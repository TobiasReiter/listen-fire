// Author-time credential-connect LINK.
//
// An MCP authoring agent (an external Claude) that finds a system a movement
// needs is NOT yet connected mints one of these and hands the URL to the user.
// The user opens it in ANY browser and the credential lands in Listen-Fire — no
// popup, no BroadcastChannel (those are the in-app chat-panel mechanism the
// external agent can't drive). Two adapter kinds are connectable this way:
//   - OAuth adapters → the link redirects to the provider's real sign-in.
//   - API-key adapters → the link renders a browser FORM where the user pastes
//     (or replaces, on reconnect) the key, which is then persisted.
//   - Intrinsic adapters → no external auth at all; the link renders a confirm
//     page and the server mints + provisions an Listen-Fire-owned credential on submit.
//   - Handshake adapters (Telegram) → the link renders a confirm page; the
//     submit connects the TEAM (the empty shared-bot credential) and hands the
//     user into the adapter's own identity handshake (the `t.me` deep link).
// All mint the same single-use token + URL; the landing route branches on the
// adapter's credential kind.
//
// This is an AUTHOR-TIME precondition resolver, NOT the runtime ask engine. A
// running movement must never park to ask for a connection. It deliberately
// mirrors the single-use-token → landing-page shape of `interaction_token` /
// `/api/asks/:token`, but with its own `connect_token` store and its own
// landing route — it does not overload either.
//
// Flow:
//   1. mintConnectLink()  → inserts a connect_token row, returns the URL.
//   2. GET /api/connect/:token (the landing route) → validates the token,
//      starts the adapter's real OAuth, binding the OAuth flow to BOTH the
//      token's user (so the existing connector callback recovers the user) AND
//      the connect token (so the callback knows to route back here, not to the
//      popup's web BroadcastChannel page).
//   3. provider → connector.handleCallback → stores pending creds → redirects
//      to GET /api/connect/:token/complete?claimToken=… (see resolveOAuthRedirect).
//   4. the complete route claims the pending creds, persists the credential
//      team-bound under the desired name, consumes the token, shows a clean
//      confirmation page.

import { randomBytes } from 'node:crypto';

import type { PickerActionKind } from './picker_spec';
import type { ConnectTokenId } from '../../generated/kysely/automations/ConnectToken';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import { getAutomationsQb, getCoreQb } from '../../lib/kysely';
import { getEnvVar } from '../../lib/utils/environment';
import { services } from '../../adapters/registry';
import {
  getAdapterManifest,
  adapterRequiredCredentialType,
  resolveAdapterSlug,
} from '../translation_graph/adapters/registry';
import { getRemoteAdapter, rowToManifest } from '../translation_graph/adapters/remote/store';
import { isKeyEntryConnectable } from './connect_form_spec';
import { isIntrinsicProvisionable } from './intrinsic_provision';
import {
  builtInBotUsername,
  SHARED_TELEGRAM_CREDENTIAL_NAME,
} from '../translation_graph/adapters/telegram/handshake';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';


// ---------------------------------------------------------------------------
// Human-readable credential naming
// ---------------------------------------------------------------------------

/**
 * Format a self-connected credential's display name from the member's label
 * and the adapter's display name. Capitalises the member label so that
 * "alice" → "Alice's Granola". The output never contains underscores.
 */
export function humanCredentialName({
  memberLabel,
  adapterDisplayName,
}: {
  memberLabel: string;
  adapterDisplayName: string;
}): string {
  const label = memberLabel.charAt(0).toUpperCase() + memberLabel.slice(1);
  return `${label}'s ${adapterDisplayName}`;
}

/**
 * Return `baseName` if not in `takenNames`, otherwise append a counter
 * suffix until a free slot is found. Pure — the caller resolves `takenNames`
 * from the DB.
 */
export function uniquifyCredentialName(baseName: string, takenNames: Set<string>): string {
  if (!takenNames.has(baseName)) return baseName;
  for (let i = 2; ; i++) {
    const candidate = `${baseName} (${i})`;
    if (!takenNames.has(candidate)) return candidate;
  }
}

async function resolveMemberLabel(userId: UserId): Promise<string> {
  const userRow = await getCoreQb(['user'])
    .selectFrom('user')
    .where('id', '=', userId)
    .select(['username'])
    .executeTakeFirst();
  if (userRow?.username) return userRow.username;

  const emailRow = await getCoreQb(['user_email'])
    .selectFrom('user_email')
    .where('user_id', '=', userId)
    .where('is_primary', '=', true)
    .select(['email'])
    .executeTakeFirst();
  const email = emailRow?.email ?? '';
  return email.split('@')[0] || 'user';
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h — author-time, opened once by the user

// ---------------------------------------------------------------------------
// OAuth-service map — the single source of truth for which credential types are
// connectable via an OAuth LINK, and which `services.*` connector drives each.
// A type is link-connectable iff it appears here (i.e. it has a connector that
// exposes `generateInstallUrl`). API-key adapters (Affinity, Granola, Mailgun,
// Twilio, …) and the Telegram handshake are intentionally absent — there's no
// OAuth dance to run.
// ---------------------------------------------------------------------------

interface OAuthConnector {
  generateInstallUrl(): Promise<string> | string | undefined;
}

// The OAuth type → connector map. Its KEYS name which types connect via OAuth;
// the VALUES are lazy getters onto the runtime `services.*` singletons
// (registered at app boot, only when that adapter's client-id/secret is set).
// Both the advertisement (`connectMethodForType`) and the mint
// (`oauthConnectorForType`) read through the SAME live getter — so an adapter is
// surfaced as OAuth-connectable only when its connector is actually wired, and
// the catalog can never advertise a link the mint would then refuse.
const OAUTH_CONNECTOR_BY_TYPE: Partial<
  Record<ExternalServiceType, () => OAuthConnector | undefined>
> = {
  [ExternalServiceType.SLACK]: () => services.slack,
  [ExternalServiceType.ATTIO]: () => services.attio,
  [ExternalServiceType.AIRTABLE]: () => services.airtable,
  [ExternalServiceType.GOOGLE]: () => services.google,
  // Gmail connects by SIGNING IN AS THE MAILBOX under the default method, and
  // `services.gmail` is registered only then — so under the delegated method
  // this getter is empty and the key-entry form below is what a connect
  // resolves to. Not the retired per-user sign-in: this credential is the
  // connected mailbox itself.
  [ExternalServiceType.GOOGLE_GMAIL]: () => services.gmail,
  [ExternalServiceType.DROPBOX]: () => services.dropbox,
};

/** Whether a credential type connects via OAuth — STATIC membership, true even
 *  before the connector singleton is registered (advertising, not minting). */
function isOAuthConnectableType(type: ExternalServiceType): boolean {
  return type in OAUTH_CONNECTOR_BY_TYPE;
}

function oauthConnectorForType(type: ExternalServiceType): OAuthConnector | undefined {
  return OAUTH_CONNECTOR_BY_TYPE[type]?.();
}

/** Whether an adapter slug can be connected via the OAuth-link flow. */
export function isOAuthLinkConnectable(adapterSlug: string): boolean {
  const type = adapterRequiredCredentialType(adapterSlug);
  return type !== null && isOAuthConnectableType(type);
}

/**
 * How a credential type is connected through the link, or null if it can't be.
 *   - 'oauth'      → the landing route redirects to the provider's sign-in.
 *   - 'key-entry'  → the landing route renders a browser form for the key.
 *   - 'intrinsic'  → no external auth; the user confirms and the server mints +
 *                    provisions the Listen-Fire-owned credential (e.g. Listen-Fire Valuations).
 *   - 'handshake'  → the credential is secret-less; the submit connects the team
 *                    and hands the user into the adapter's own identity handshake
 *                    (Telegram's `t.me/<bot>?start=<token>` deep link).
 */
export type ConnectKind = 'oauth' | 'key-entry' | 'intrinsic' | 'handshake' | 'item-picker';

/** Whether a credential type connects via an adapter-owned identity handshake.
 *  Only Telegram today: the "credential" is the empty shared-bot row, and the
 *  real linking act is the `/start <token>` exchange inside Telegram itself. */
function isHandshakeConnectable(type: ExternalServiceType): boolean {
  return type === ExternalServiceType.TELEGRAM;
}

/**
 * The connect method the catalog advertises for a type — the SAME live
 * derivation a real connect attempt takes (`connectKindForType`), so the
 * advertisement can never disagree with what `mintConnectLink` will actually
 * do. Falls back to 'app-only' when no link can be minted: either the type
 * genuinely connects in-app, or its OAuth connector isn't wired on this server
 * (missing client-id/secret). In both cases connectSystem can't mint a link, so
 * we must not advertise it as link-connectable — an author must never author
 * toward a connect that would then fail.
 */
export type ConnectMethod = Exclude<ConnectKind, 'item-picker'> | 'app-only';

export function connectMethodForType(type: ExternalServiceType): ConnectMethod {
  return connectKindForType(type) ?? 'app-only';
}

export function connectKindForType(
  type: ExternalServiceType,
): Exclude<ConnectKind, 'item-picker'> | null {
  if (oauthConnectorForType(type)) return 'oauth';
  if (isKeyEntryConnectable(type)) return 'key-entry';
  if (isIntrinsicProvisionable(type)) return 'intrinsic';
  if (isHandshakeConnectable(type)) return 'handshake';
  return null;
}

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

function connectBaseUrl(): string {
  // The link lands on the API host (the landing route lives in apps/api),
  // mirroring asks (park_sink.asksBaseUrl). API_BASE_URL is the agent-stack
  // host; the dev-loop sets it per-profile.
  return getEnvVar('API_BASE_URL', { devDefault: 'http://localhost:3000' }).replace(/\/$/, '');
}

export interface MintConnectLinkInput {
  teamId: TeamId;
  userId: UserId;
  adapterSlug: string;
  /** Name to store the credential under (defaults to the adapter slug). */
  credentialName?: string;
}

export interface MintConnectLinkResult {
  url: string;
  adapter: string;
  displayName: string;
  serviceType: ExternalServiceType;
  connectKind: ConnectKind;
  credentialName: string;
  expiresAt: Date;
}

/**
 * Mint a single-use, TTL'd connect link for an adapter. Returns the URL the
 * authoring agent relays to the user, or an `{ error }` describing why the
 * adapter can't be connected this way (unknown adapter / needs no credential /
 * neither OAuth nor key-entry connectable). The result's `connectKind` tells
 * the agent whether the user will see a browser sign-in or a key-entry form.
 */
export async function mintConnectLink(
  input: MintConnectLinkInput,
): Promise<MintConnectLinkResult | { error: string }> {
  // Resolve the adapter's display name + credential type from EITHER the static
  // registry OR a team-scoped remote install. A remote adapter has no static
  // manifest and carries no `requiredCredentialType` (its construction is
  // credential-free); its secret is a REMOTE credential entered out-of-band via
  // this link, so we classify it directly.
  const slug = resolveAdapterSlug(input.adapterSlug);
  const staticManifest = getAdapterManifest(input.adapterSlug);
  let displayName: string;
  let serviceType: ExternalServiceType | null;
  if (staticManifest) {
    displayName = staticManifest.displayName;
    serviceType = adapterRequiredCredentialType(input.adapterSlug);
    if (!serviceType) {
      return { error: `${displayName} needs no credential — nothing to connect.` };
    }
  } else {
    const remoteRow = await getRemoteAdapter({ teamId: input.teamId, adapterType: slug });
    if (!remoteRow) {
      return { error: `No adapter '${input.adapterSlug}'. It is not an available integration.` };
    }
    displayName = rowToManifest(remoteRow).displayName ?? slug;
    serviceType = ExternalServiceType.REMOTE;
  }
  const connectKind = connectKindForType(serviceType);
  if (!connectKind) {
    // An OAuth type with no live connector isn't "connect in-app" — it's a
    // server that's missing this integration's client id/secret, so neither the
    // link NOR the app can connect it. Say that, rather than sending the user to
    // an app flow that will also fail.
    return {
      error: isOAuthConnectableType(serviceType)
        ? `${displayName} isn't available to connect right now — its integration ` +
          `isn't configured on this server.`
        : `${displayName} can't be connected through a browser link. ` +
          `Connect it from the app instead.`,
    };
  }
  // Handshake (Telegram): fail at MINT time if the shared bot isn't configured,
  // so the agent gets a clear error instead of the user landing on a dead page.
  if (connectKind === 'handshake' && !builtInBotUsername()) {
    return {
      error:
        `${displayName} linking isn't available right now — the shared ` +
        `bot is not configured on this server.`,
    };
  }

  let credentialName: string;
  if (connectKind === 'handshake') {
    // The handshake credential is TEAM-level (the shared-bot opt-in row), not a
    // personal key. The landing route's idempotent ensure reuses any EXISTING
    // TELEGRAM credential — under its existing name — so the name we promise
    // here must be that one when it exists; a requested/default name applies
    // only when the connect will actually create the row. Otherwise the agent
    // polls listCatalog for a name that will never appear.
    const existing = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('team_id', '=', input.teamId)
      .where('type', '=', serviceType)
      .select(['name'])
      .executeTakeFirst();
    credentialName =
      existing?.name ?? (input.credentialName?.trim() || SHARED_TELEGRAM_CREDENTIAL_NAME);
  } else if (input.credentialName?.trim()) {
    credentialName = input.credentialName.trim();
  } else {
    const memberLabel = await resolveMemberLabel(input.userId);
    const baseName = humanCredentialName({ memberLabel, adapterDisplayName: displayName });
    const existing = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('team_id', '=', input.teamId)
      .select(['name'])
      .execute();
    const takenNames = new Set(existing.map((r) => r.name));
    credentialName = uniquifyCredentialName(baseName, takenNames);
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await getAutomationsQb(['connect_token'])
    .insertInto('connect_token')
    .values({
      token,
      team_id: input.teamId,
      user_id: input.userId,
      adapter_slug: slug,
      credential_name: credentialName,
      expires_at: expiresAt,
    })
    .execute();

  return {
    url: `${connectBaseUrl()}/api/connect/${token}`,
    adapter: slug,
    displayName: displayName,
    serviceType,
    connectKind,
    credentialName,
    expiresAt,
  };
}

/**
 * Mint a single-use PICKER link for a Google adapter: the page hosts the Drive
 * Picker against an EXISTING Google credential, and picking grants those items
 * to it (`google_granted_item`). Under drive.file a human pick is the only way
 * to reach a pre-existing file/folder. Credential resolution: an explicit name
 * wins; otherwise the team's single GOOGLE credential; several → a clear error.
 */
export async function mintItemPickerLink(input: {
  teamId: TeamId;
  userId: UserId;
  actionKind: PickerActionKind;
  credentialName?: string;
}): Promise<MintConnectLinkResult | { error: string }> {
  const rows = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', input.teamId)
    .where('type', '=', ExternalServiceType.GOOGLE)
    .select(['id', 'name'])
    .execute();
  const wanted = input.credentialName?.trim();
  const matches = wanted ? rows.filter((r) => r.name === wanted) : rows;
  if (matches.length === 0) {
    return {
      error: wanted
        ? `No Google credential named "${wanted}" on this team — connect Google first.`
        : 'No Google credential on this team — connect Google first.',
    };
  }
  if (matches.length > 1) {
    return {
      error:
        `Several Google credentials on this team (${matches.map((r) => `"${r.name}"`).join(', ')}) — ` +
        'pass a connection name to say which one the items should be granted to.',
    };
  }
  const credential = matches[0];
  const slug = input.actionKind === 'google-sheets-picker' ? 'google_sheets' : 'google_drive';
  const displayName = getAdapterManifest(slug)?.displayName ?? slug;

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await getAutomationsQb(['connect_token'])
    .insertInto('connect_token')
    .values({
      token,
      team_id: input.teamId,
      user_id: input.userId,
      adapter_slug: slug,
      credential_name: credential.name,
      credentials_id: credential.id,
      expires_at: expiresAt,
    })
    .execute();

  return {
    url: `${connectBaseUrl()}/api/connect/${token}`,
    adapter: slug,
    displayName,
    serviceType: ExternalServiceType.GOOGLE,
    connectKind: 'item-picker',
    credentialName: credential.name,
    expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Token lookup — TTL + single-use, mirroring interaction lookupToken.
// ---------------------------------------------------------------------------

export interface ConnectTokenRow {
  id: string;
  teamId: TeamId;
  userId: UserId;
  adapterSlug: string;
  credentialName: string;
  /** Set on GRANT links only (kind 'item-picker') — the existing credential
   *  the grant lands against. */
  credentialsId?: string;
  serviceType: ExternalServiceType;
  connectKind: ConnectKind;
}

export type ConnectTokenLookup =
  | { ok: true; row: ConnectTokenRow }
  | { ok: false; reason: 'not_found' | 'expired' | 'consumed' | 'misconfigured' };

export async function lookupConnectToken(token: string): Promise<ConnectTokenLookup> {
  const row = await getAutomationsQb(['connect_token'])
    .selectFrom('connect_token')
    .where('token', '=', token)
    .select(['id', 'team_id', 'user_id', 'adapter_slug', 'credential_name', 'credentials_id', 'expires_at', 'consumed_at'])
    .executeTakeFirst();

  if (!row) return { ok: false, reason: 'not_found' };
  if (row.consumed_at !== null) return { ok: false, reason: 'consumed' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  const serviceType = adapterRequiredCredentialType(row.adapter_slug);
  // A token bound to an EXISTING credential is a GRANT link (the item
  // picker), not a credential-connect link — the kind derives from that
  // binding, not from the credential type's connect method.
  const connectKind =
    row.credentials_id !== null
      ? ('item-picker' as const)
      : serviceType
        ? connectKindForType(serviceType)
        : null;
  if (!serviceType || !connectKind) {
    return { ok: false, reason: 'misconfigured' };
  }

  return {
    ok: true,
    row: {
      id: row.id,
      // The vault's tenant/user columns are opaque uuids now (D3); this is the
      // boundary where they re-enter the core-shaped call surface.
      teamId: row.team_id as TeamId,
      userId: row.user_id as UserId,
      adapterSlug: row.adapter_slug,
      credentialName: row.credential_name,
      ...(row.credentials_id !== null ? { credentialsId: row.credentials_id as string } : {}),
      serviceType,
      connectKind,
    },
  };
}

/** Generate the adapter's OAuth install URL (returns undefined if unavailable). */
export async function startConnectOAuth(serviceType: ExternalServiceType): Promise<string | undefined> {
  const connector = oauthConnectorForType(serviceType);
  if (!connector) return undefined;
  return (await connector.generateInstallUrl()) ?? undefined;
}

/**
 * Atomically consume a connect token (single-use). Returns true if THIS call
 * consumed it; false if it was already consumed (concurrent / replay).
 */
export async function consumeConnectToken(tokenId: string): Promise<boolean> {
  const result = await getAutomationsQb(['connect_token'])
    .updateTable('connect_token')
    .set({ consumed_at: new Date() })
    .where('id', '=', tokenId as ConnectTokenId)
    .where('consumed_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}
