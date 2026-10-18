// Async adapter resolution seam — the single entry point for obtaining an
// Adapter instance when the type may be either LOCAL (static factory map) or
// REMOTE (a team-scoped `remote_adapter` install resolved over the wire).
//
// Local resolution is unchanged: `resolveAdapter` tries the static registry
// first and returns exactly what `getAdapter` would, with no DB hit. Only on a
// registry miss does it fall back to the remote path — load the install row,
// decrypt the auth secret, and construct a `RemoteAdapter` from the stored
// manifest plus a freshly-minted `cacheScopeId`.
//
// All resolution — RUNTIME (dispatch / engine) AND author-time (editor /
// translation agent / setup agent / simulate) — flows through this seam, so
// every caller is remote-capable. The synchronous `getAdapter` is the
// local-only inner step: it builds an Adapter from the static factory map and
// is invoked only here, after the local-first `hasAdapter` check.
//
// Resolution seam (async)

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import type { Adapter } from 'movement-engine/public/adapter';
import type { TriggerType } from 'movement-engine/public/adapter';

import { getAutomationsQb } from '../../../lib/kysely';
import {
  getAdapter,
  hasAdapter,
  listAdapterTypes,
  resolveAdapterSlug,
} from './registry';
import { getRemoteAdapter, rowToManifest } from './remote/store';
import { hostedDocumentStore } from '../engine/files/retrieve';
import { RemoteAdapterCredentialPayload, type RemoteAdapterManifestFile } from './remote/manifest';
import {
  createRemoteAdapter,
  type RemoteAdapterConfig,
  type RemoteCredentialBinding,
  type RemoteManifest,
} from 'movement-engine/public/modules';
import { createSecretsFamily } from 'movement-engine/public/secrets';

/**
 * Resolve an adapter for the given type. Local-first (static registry, no DB),
 * remote fallback (`remote_adapter` install row → decrypt → `RemoteAdapter`).
 *
 * Used by both runtime and author-time callers — see the file header.
 */
export async function resolveAdapter(input: {
  adapterType: string;
  teamId: TeamId;
  credentialsId?: string;
  /** Non-credential construction args (e.g. Sheets' `spreadsheet:` entry
   *  position). Local adapters read theirs from here; remote installs ignore
   *  it (no entry-position concept over the wire yet). */
  constructionArgs?: Record<string, string>;
}): Promise<Adapter> {
  // Canonical slug — the trigger-kind aliasing the local registry already
  // applies (`ATTIO` → `attio`). Both branches below key off this slug so a
  // remote install stored under the canonical slug is reachable from ANY of
  // its kind-aliases. That indirection is what lets existing inputs/outputs
  // keep their adapterType strings and still resolve to a remote install.
  const slug = resolveAdapterSlug(input.adapterType);

  // 1. Local first — unchanged behavior, no DB round-trip.
  if (hasAdapter(input.adapterType)) {
    return getAdapter(input);
  }
  // (Remote installs below ignore constructionArgs — no entry position over
  //  the wire yet — so they read `input` without it.)

  // 2. Remote fallback — a team-scoped install, keyed by the canonical slug.
  const row = await getRemoteAdapter({
    teamId: input.teamId,
    adapterType: slug,
  });
  if (!row) {
    throw new Error(
      `Unknown adapter type: ${input.adapterType} (slug: ${slug}). Registered: ${listAdapterTypes().join(', ')} (and no remote_adapter install for this team).`,
    );
  }
  if (!row.credentials_id) {
    throw new Error(
      `Remote adapter "${input.adapterType}" has no credential configured (credentials_id is null).`,
    );
  }

  const manifestFile = rowToManifest(row);
  // The install's server secret signs every call. The credential must belong
  // to THIS adapter: its app_id is bound to the install's slug at mint time,
  // so a secret provisioned for another remote adapter can never drive this one.
  const install = await loadRemoteInstallPayload(row.credentials_id, input.teamId, row.adapter_type);

  // The connection's credential, when it names one other than the install's
  // own: the provider credential the calls act as (`connect hs_alice using
  // alice_hubspot`). Naming the install's own row is how a connection read
  // before modules declared credentials, so it still means "no provider
  // credential".
  const providerCredentialsId =
    input.credentialsId !== undefined && input.credentialsId !== row.credentials_id ? input.credentialsId : undefined;
  const credential =
    providerCredentialsId !== undefined
      ? await providerCredentialBinding({
          credentialsId: providerCredentialsId,
          teamId: input.teamId,
          manifest: manifestFile,
          install,
        })
      : undefined;

  const config: RemoteAdapterConfig = {
    adapterType: manifestFile.adapterType,
    teamId: input.teamId,
    baseUrl: manifestFile.baseUrl,
    authStrategy: manifestFile.authStrategy,
    // What a file handle re-resolves this instance by: the connection's own
    // credential, so a redeemed handle acts as the same account.
    credentialsId: providerCredentialsId ?? row.credentials_id,
  };

  const manifest: RemoteManifest = {
    adapterType: manifestFile.adapterType,
    // Sanctioned boundary cast: validated manifest value → branded domain.
    supportedTriggers: manifestFile.supportedTriggers as readonly TriggerType[],
    // Validated structurally by the manifest-file schema — no boundary `as`.
    runtimeCapabilities: manifestFile.runtimeCapabilities,
    methods: manifestFile.methods,
    ...(manifestFile.credentials !== undefined ? { credentials: manifestFile.credentials } : {}),
    ...(manifestFile.limits !== undefined ? { limits: manifestFile.limits } : {}),
  };

  // One cache scope per resolved instance = per evaluation / role (P2). Minting
  // it here (rather than threading it from the engine) keeps the scope explicit
  // and groupable: every fetch this RemoteAdapter makes shares one logical unit
  // of work, and a new evaluation gets a fresh scope.
  const cacheScopeId = randomUUID();

  return createRemoteAdapter({
    config,
    secret: install.secret,
    cacheScopeId,
    manifest,
    documents: hostedDocumentStore,
    ...(credential !== undefined ? { credential } : {}),
  });
}

/**
 * A connection's provider credential, as the remote adapter sends it: a
 * `REMOTE` row minted for this module (`app_id` = its slug) and for one of the
 * credentials its manifest declares (`declared_credential`). Refreshed by the
 * host with the install's OAuth app, and a rotated token written back to this
 * same row (compare-and-swap) through the platform's secrets store. The
 * checker refuses a connection naming any other credential; this refuses it
 * again at run time, before anything is sent.
 */
async function providerCredentialBinding(input: {
  credentialsId: string;
  teamId: TeamId;
  manifest: RemoteAdapterManifestFile;
  install: RemoteAdapterCredentialPayload;
}): Promise<RemoteCredentialBinding> {
  const { credentialsId, manifest } = input;
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', input.teamId)
    .select(['app_id', 'declared_credential'])
    .executeTakeFirst();
  if (!row) {
    throw new Error(`Remote adapter "${manifest.adapterType}": the connection's credential ${credentialsId} does not exist on this team.`);
  }
  const declared = (manifest.credentials ?? []).map((credential) => credential.name);
  if (row.app_id !== manifest.adapterType || row.declared_credential === null) {
    throw new Error(
      `Remote adapter "${manifest.adapterType}": the connection's credential ${credentialsId} is not a ${manifest.adapterType} credential; it is not sent.`,
    );
  }
  if (!declared.includes(row.declared_credential)) {
    throw new Error(
      `Remote adapter "${manifest.adapterType}": the connection's credential ${credentialsId} fills "${row.declared_credential}", which the module does not declare (it declares ${declared.length > 0 ? declared.map((d) => `"${d}"`).join(', ') : 'none'}); it is not sent.`,
    );
  }
  const client = input.install.oauthClients?.[row.declared_credential];
  // Lazy for the reason `loadRemoteInstallPayload` imports the cipher lazily.
  const { postgresSecrets } = await import('../../credentials/secrets_postgres');
  return {
    name: row.declared_credential,
    secrets: createSecretsFamily({ backend: postgresSecrets({ teamId: input.teamId }) }),
    ref: credentialsId,
    ...(client !== undefined
      ? { client: { clientId: client.clientId, ...(client.clientSecret !== undefined ? { clientSecret: client.clientSecret } : {}) } }
      : {}),
  };
}

/**
 * Load + decrypt the remote adapter's auth secret from
 * `external_service_credentials`. The stored payload is encrypted JSON of the
 * form `{ "secret": "<token-to-auth-to-the-remote-server>" }`.
 */
export async function loadRemoteAdapterSecret(
  credentialsId: string,
  teamId: TeamId,
  expectedAppId: string,
): Promise<string> {
  return (await loadRemoteInstallPayload(credentialsId, teamId, expectedAppId)).secret;
}

/** The install's whole decrypted payload: its server secret, and the host's
 *  OAuth apps for the module's declared credentials. */
export async function loadRemoteInstallPayload(
  credentialsId: string,
  teamId: TeamId,
  expectedAppId: string,
): Promise<RemoteAdapterCredentialPayload> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', teamId)
    .select(['id', 'credentials', 'app_id'])
    .executeTakeFirst();
  if (!row) {
    throw new Error(
      `Remote adapter credential not found (credentials_id=${credentialsId}, team=${teamId}).`,
    );
  }

  // The app_id binding: this credential was minted for a specific remote
  // adapter. Reject it for any other — a secret for adapter A must never
  // authenticate adapter B. Checked before decryption so a mismatched secret is
  // never even touched.
  if (row.app_id !== expectedAppId) {
    throw new Error(
      `Remote adapter credential (credentials_id=${credentialsId}) does not belong to adapter "${expectedAppId}" (app_id="${row.app_id ?? 'null'}").`,
    );
  }

  // Lazy import: `lib/credentials` reads encryption env vars at module-eval
  // time. Deferring the import keeps `resolve.ts` (now on the engine's import
  // graph) from forcing those env vars on every test that imports the engine.
  const { decryptToken } = await import('../../../lib/credentials');
  const decrypted = await decryptToken(row.credentials, row.id);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decrypted);
  } catch {
    throw new Error(
      `Remote adapter credential (credentials_id=${credentialsId}) is not valid JSON.`,
    );
  }

  const parsed = RemoteAdapterCredentialPayload.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `Remote adapter credential (credentials_id=${credentialsId}) payload is malformed — expected { "secret": string }.`,
    );
  }
  return parsed.data;
}
