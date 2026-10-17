// A team member creating their own provider credential for an installed
// remote module: one of the credentials its manifest declares
// (`credentials[]`), named so a movement can import it
// (`connect hubspot using alice_hubspot`).
//
//   static — the member types the declared fields; validated against the
//     declaration and minted.
//   oauth2 — the member signs in at the provider through the install's host
//     OAuth app for that declaration. The attempt waits by its state, as the
//     platform's other OAuth connects do (the user bound in `oauthFlows`, the
//     attempt itself here); the callback exchanges the code and mints the
//     tokens as the credential's fields.
//
// Every write goes through `mintRemoteModuleCredential`, so the row is bound
// to the module (`app_id`) and to the declaration it fills.

import {
  beginOAuth2Connect,
  createPendingStates,
  exchangeOAuth2Code,
  UnknownConnectAttempt,
  type OAuth2Attempt,
} from 'movement-engine/public/secrets';

import type { WireCredentialDeclarationShape } from 'engine-contracts';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';


import { getAutomationsQb } from '../../lib/kysely';
import { oauthRedirectBaseUrl } from '../../lib/api_base_url';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { getRemoteAdapter, parseStoredManifest, type RemoteAdapterRow } from '../translation_graph/adapters/remote/store';
import { loadRemoteInstallPayload } from '../translation_graph/adapters/resolve';
import { mintRemoteModuleCredential } from './remote_credential';

/** Why a request was refused, in the member's terms; `code` is how the caller
 *  reports it. */
export class RemoteModuleCredentialRefused extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'RemoteModuleCredentialRefused';
  }
}

// A movement imports a credential by name (`import { alice_hubspot } from
// credentials`), so the name is held to the module's own declared-name rule:
// it imports bare, never needing backticks.
const CREDENTIAL_NAME = /^[a-z][a-z0-9_]*$/;

function refuseInvalidName(name: string): void {
  if (!CREDENTIAL_NAME.test(name)) {
    throw new RemoteModuleCredentialRefused(
      'BAD_REQUEST',
      `"${name}" is not a credential name a movement can import: use ASCII lower case, a letter, then letters, digits or underscores (e.g. alice_hubspot).`,
    );
  }
}

// Asked before a sign-in is sent to the provider, so a taken name is refused
// before the member consents rather than after. The insert still enforces it.
async function refuseTakenName(input: { teamId: TeamId; name: string }): Promise<void> {
  const taken = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', input.teamId)
    .where('name', '=', input.name)
    .select(['id'])
    .executeTakeFirst();
  if (taken !== undefined) {
    throw new RemoteModuleCredentialRefused('CONFLICT', `A credential named "${input.name}" already exists for this team.`);
  }
}

/** The page the provider sends the member back to: the web app's callback
 *  page, which hands the query to the API's callback route. */
export function remoteModuleSignInRedirectUri(): string {
  return `${oauthRedirectBaseUrl().replace(/\/$/, '')}/remote-adapters/callback`;
}

/** Where the member lands once a sign-in is complete or refused. */
export function remoteModuleSettingsUrl(outcome: { connected: string } | { error: string }): string {
  const url = new URL(`${oauthRedirectBaseUrl().replace(/\/$/, '')}/settings/remote-adapters`);
  if ('connected' in outcome) url.searchParams.set('connected', outcome.connected);
  else url.searchParams.set('error', outcome.error);
  return url.toString();
}

// ── The install and what it declares ────────────────────────────────────────

interface Install {
  row: RemoteAdapterRow;
  declarations: WireCredentialDeclarationShape[];
}

async function loadInstall(input: { teamId: TeamId; adapterType: string }): Promise<Install> {
  const row = await getRemoteAdapter(input);
  if (row === null) {
    throw new RemoteModuleCredentialRefused('NOT_FOUND', `No remote module "${input.adapterType}" is installed on this team.`);
  }
  const stored = parseStoredManifest(row);
  if (!stored.ok) {
    throw new RemoteModuleCredentialRefused(
      'BAD_REQUEST',
      `The stored manifest for "${input.adapterType}" is no longer valid: ${stored.reason}`,
    );
  }
  return { row, declarations: stored.manifest.credentials ?? [] };
}

function declarationOf(install: Install, declaredCredential: string): WireCredentialDeclarationShape {
  const declaration = install.declarations.find((declared) => declared.name === declaredCredential);
  if (declaration === undefined) {
    const declared = install.declarations.map((d) => `"${d.name}"`).join(', ');
    throw new RemoteModuleCredentialRefused(
      'BAD_REQUEST',
      `"${install.row.adapter_type}" declares no credential "${declaredCredential}" (it declares ${declared.length > 0 ? declared : 'none'}).`,
    );
  }
  return declaration;
}

/** The host's OAuth app for one declaration, from the install's encrypted
 *  payload; undefined when the install holds none for it. */
async function oauthClientOf(input: { teamId: TeamId; install: Install; declaredCredential: string }) {
  const credentialsId = input.install.row.credentials_id as unknown as string | null;
  if (credentialsId === null) return undefined;
  const payload = await loadRemoteInstallPayload(credentialsId, input.teamId, input.install.row.adapter_type);
  return payload.oauthClients?.[input.declaredCredential];
}

// What the sign-in itself stores on an oauth2 credential. A declaration may
// list them among its fields too; the member never types them.
const OAUTH2_TOKEN_FIELDS: ReadonlySet<string> = new Set(['access_token', 'refresh_token', 'expires_at']);

/** The fields a member fills for a declaration. */
function fillableFields(declaration: WireCredentialDeclarationShape) {
  return declaration.kind === 'oauth2'
    ? declaration.fields.filter((field) => !OAUTH2_TOKEN_FIELDS.has(field.name))
    : declaration.fields;
}

/**
 * The fields the member entered, checked against what the declaration lists:
 * each required field present, nothing it does not list. An empty value is
 * treated as not entered.
 */
function validatedFields(
  declaration: WireCredentialDeclarationShape,
  entered: Record<string, string>,
): Record<string, string> {
  const fillable = fillableFields(declaration);
  const listed = new Set(fillable.map((field) => field.name));
  const undeclared = Object.keys(entered).filter((name) => !listed.has(name));
  if (undeclared.length > 0) {
    throw new RemoteModuleCredentialRefused(
      'BAD_REQUEST',
      `"${declaration.name}" does not declare ${undeclared.map((n) => `"${n}"`).join(', ')}.`,
    );
  }
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(entered)) if (value !== '') fields[name] = value;
  const missing = fillable.filter((field) => field.optional !== true && fields[field.name] === undefined);
  if (missing.length > 0) {
    throw new RemoteModuleCredentialRefused(
      'BAD_REQUEST',
      `"${declaration.name}" needs ${missing.map((field) => `"${field.label ?? field.name}"`).join(', ')}.`,
    );
  }
  return fields;
}

// ── Listing ─────────────────────────────────────────────────────────────────

/**
 * What one installed module declares and the credentials already created for
 * each declaration. Never a secret value: a field says only whether it is
 * secret, and an oauth2 declaration only whether the install holds an OAuth
 * app to sign in with.
 */
export async function listRemoteModuleCredentials(input: { teamId: TeamId; adapterType: string }) {
  const install = await loadInstall(input);
  const rows = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', input.teamId)
    .where('type', '=', ExternalServiceType.REMOTE)
    .where('app_id', '=', install.row.adapter_type)
    .where('declared_credential', 'is not', null)
    .select(['id', 'name', 'declared_credential'])
    .orderBy('created_at', 'asc')
    .execute();

  const declarations = await Promise.all(
    install.declarations.map(async (declaration) => ({
      name: declaration.name,
      fields: fillableFields(declaration).map((field) => ({
        name: field.name,
        label: field.label ?? field.name,
        secret: field.secret !== false,
        optional: field.optional === true,
      })),
      credentials: rows
        .filter((row) => row.declared_credential === declaration.name)
        .map((row) => ({ id: row.id as unknown as string, name: row.name })),
      ...(declaration.kind === 'oauth2'
        ? {
            kind: 'oauth2' as const,
            signInAvailable:
              (await oauthClientOf({ teamId: input.teamId, install, declaredCredential: declaration.name })) !== undefined,
          }
        : { kind: 'static' as const }),
    })),
  );
  return { adapterType: install.row.adapter_type, redirectUri: remoteModuleSignInRedirectUri(), declarations };
}

// ── Static: entered once ────────────────────────────────────────────────────

export interface RemoteModuleCredentialTarget {
  teamId: TeamId;
  /** The member creating it; null for a harness flow, as the mint allows. */
  userId: UserId | null;
  adapterType: string;
  declaredCredential: string;
  name: string;
}

export async function createStaticRemoteModuleCredential(
  input: RemoteModuleCredentialTarget & { fields: Record<string, string> },
): Promise<{ credentialsId: string }> {
  refuseInvalidName(input.name);
  const install = await loadInstall(input);
  const declaration = declarationOf(install, input.declaredCredential);
  if (declaration.kind !== 'static') {
    throw new RemoteModuleCredentialRefused(
      'BAD_REQUEST',
      `"${declaration.name}" is connected by signing in at the provider, not by entering its fields.`,
    );
  }
  return mintRemoteModuleCredential({
    teamId: input.teamId,
    userId: input.userId,
    adapterType: install.row.adapter_type,
    declaredCredential: declaration.name,
    name: input.name,
    fields: validatedFields(declaration, input.fields),
  });
}

// ── OAuth 2: signed in at the provider ──────────────────────────────────────

interface PendingSignIn extends RemoteModuleCredentialTarget {
  attempt: OAuth2Attempt;
  /** The declaration's own fields, entered before signing in; the tokens are
   *  added beside them. */
  fields: Record<string, string>;
}

const pendingSignIns = createPendingStates<PendingSignIn>();

/**
 * The provider's authorize URL for one member's sign-in, through the install's
 * OAuth app for the declaration. The attempt is remembered by its state until
 * the provider sends the member back.
 */
export async function beginRemoteModuleSignIn(
  input: RemoteModuleCredentialTarget & { fields?: Record<string, string> },
): Promise<{ url: string; state: string }> {
  refuseInvalidName(input.name);
  const install = await loadInstall(input);
  const declaration = declarationOf(install, input.declaredCredential);
  if (declaration.kind !== 'oauth2') {
    throw new RemoteModuleCredentialRefused('BAD_REQUEST', `"${declaration.name}" is entered as fields, not signed in to.`);
  }
  const client = await oauthClientOf({ teamId: input.teamId, install, declaredCredential: declaration.name });
  if (client === undefined) {
    throw new RemoteModuleCredentialRefused(
      'BAD_REQUEST',
      `"${install.row.adapter_type}" has no OAuth app for "${declaration.name}", so nobody can sign in to it yet. Reinstall the module with the OAuth app's client id (and secret) for "${declaration.name}".`,
    );
  }
  const fields = validatedFields(declaration, input.fields ?? {});
  await refuseTakenName(input);
  const { url, attempt } = beginOAuth2Connect({
    oauth2: declaration.oauth2,
    clientId: client.clientId,
    redirectUri: remoteModuleSignInRedirectUri(),
  });
  pendingSignIns.put(attempt.state, {
    teamId: input.teamId,
    userId: input.userId,
    adapterType: install.row.adapter_type,
    declaredCredential: declaration.name,
    name: input.name,
    attempt,
    fields,
  });
  return { url, state: attempt.state };
}

/**
 * Complete the sign-in this state began, once: exchange the code with the
 * install's OAuth app as it stands now, and mint the tokens as the
 * credential's fields. Throws `UnknownConnectAttempt` for a state that is
 * unknown, expired or already used.
 */
export async function completeRemoteModuleSignIn(input: { state: string; code: string }): Promise<{ credentialsId: string; name: string }> {
  const pending = pendingSignIns.take(input.state);
  if (pending === undefined) throw new UnknownConnectAttempt();
  const install = await loadInstall(pending);
  const declaration = declarationOf(install, pending.declaredCredential);
  if (declaration.kind !== 'oauth2') {
    throw new RemoteModuleCredentialRefused('BAD_REQUEST', `"${declaration.name}" is no longer signed in to.`);
  }
  const client = await oauthClientOf({ teamId: pending.teamId, install, declaredCredential: declaration.name });
  if (client === undefined) {
    throw new RemoteModuleCredentialRefused('BAD_REQUEST', `"${install.row.adapter_type}" no longer holds an OAuth app for "${declaration.name}".`);
  }
  const grant = await exchangeOAuth2Code({ oauth2: declaration.oauth2, client, attempt: pending.attempt, code: input.code });
  const { credentialsId } = await mintRemoteModuleCredential({
    teamId: pending.teamId,
    userId: pending.userId,
    adapterType: pending.adapterType,
    declaredCredential: declaration.name,
    name: pending.name,
    fields: { ...pending.fields, ...grant.fields },
  });
  return { credentialsId, name: pending.name };
}
