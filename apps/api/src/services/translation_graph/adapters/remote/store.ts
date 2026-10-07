// Team-scoped persistence for remote Translation Graph adapter installs.
//
// One `public.remote_adapter` row per (team, adapterType). The whole manifest
// file round-trips through the `manifest` jsonb column; the projected scalar
// columns (`base_url`, `auth_strategy`, `credentials_id`) mirror the manifest
// for routing and credential resolution. The credential itself is NEVER stored
// here — only the `credentials_id` FK into `external_service_credentials`.
// Decryption happens at resolution time (a later phase).
//
// Registration

import { sql } from 'kysely';

import { getAutomationsQb } from '../../../../lib/kysely';
import { RemoteAdapterManifestFile } from './manifest';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { RemoteAdapter as RemoteAdapterRow } from '../../../../generated/kysely/automations/RemoteAdapter';

export type { RemoteAdapterRow };

/**
 * Reconstruct the installable manifest file from a stored row. The full
 * manifest lives in the `manifest` jsonb column; this validates it back into
 * the typed shape on read.
 */
export function rowToManifest(row: RemoteAdapterRow): RemoteAdapterManifestFile {
  return RemoteAdapterManifestFile.parse(row.manifest);
}

/**
 * Like `rowToManifest`, but a stored manifest that no longer parses (the schema
 * has tightened since it was saved) is an answer, not a throw — so one stale row
 * cannot take a whole list down with it.
 */
export function parseStoredManifest(
  row: RemoteAdapterRow,
): { ok: true; manifest: RemoteAdapterManifestFile } | { ok: false; reason: string } {
  const parsed = RemoteAdapterManifestFile.safeParse(row.manifest);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  const reason = parsed.error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ')
    .replace(/\s*\n\s*/g, ' ');
  return { ok: false, reason };
}

/**
 * Install or update a remote adapter from a manifest file. Upserts on the
 * `(team_id, adapter_type)` unique key — a second call with the same slug
 * updates the existing row rather than creating a duplicate. The full manifest
 * is stored in the `manifest` jsonb column AND projected into the scalar
 * columns.
 */
export async function upsertRemoteAdapter(input: {
  teamId: TeamId;
  manifest: unknown;
}): Promise<{ id: string }> {
  const manifest = RemoteAdapterManifestFile.parse(input.manifest);

  const row = await getAutomationsQb(['remote_adapter'])
    .insertInto('remote_adapter')
    .values({
      team_id: input.teamId,
      adapter_type: manifest.adapterType,
      base_url: manifest.baseUrl,
      auth_strategy: sql`${JSON.stringify(manifest.authStrategy)}::jsonb` as unknown as never,
      credentials_id: (manifest.credentialsId ?? null) as RemoteAdapterRow['credentials_id'],
      manifest: sql`${JSON.stringify(manifest)}::jsonb` as unknown as never,
    } as never)
    .onConflict((oc) =>
      oc.columns(['team_id', 'adapter_type']).doUpdateSet({
        base_url: manifest.baseUrl,
        auth_strategy: sql`${JSON.stringify(manifest.authStrategy)}::jsonb` as unknown as never,
        credentials_id: (manifest.credentialsId ?? null) as RemoteAdapterRow['credentials_id'],
        manifest: sql`${JSON.stringify(manifest)}::jsonb` as unknown as never,
        updated_at: new Date(),
      } as never),
    )
    .returning(['id'])
    .executeTakeFirstOrThrow();

  return { id: row.id as unknown as string };
}

/**
 * Attach a credential to an installed remote adapter — the write-back a
 * connect-link submit performs after minting the REMOTE secret out-of-band.
 * Sets the install's `credentials_id` for `(team, adapter_type)`.
 */
export async function linkRemoteAdapterCredential(input: {
  teamId: TeamId;
  adapterType: string;
  credentialsId: string;
}): Promise<void> {
  await getAutomationsQb(['remote_adapter'])
    .updateTable('remote_adapter')
    .set({
      credentials_id: input.credentialsId as RemoteAdapterRow['credentials_id'],
      updated_at: new Date(),
    } as never)
    .where('team_id', '=', input.teamId)
    .where('adapter_type', '=', input.adapterType)
    .execute();
}

export async function getRemoteAdapter(input: {
  teamId: TeamId;
  adapterType: string;
}): Promise<RemoteAdapterRow | null> {
  const row = await getAutomationsQb(['remote_adapter'])
    .selectFrom('remote_adapter')
    .where('team_id', '=', input.teamId)
    .where('adapter_type', '=', input.adapterType)
    .selectAll()
    .executeTakeFirst();
  return row ?? null;
}

export async function listRemoteAdapters(input: {
  teamId: TeamId;
}): Promise<RemoteAdapterRow[]> {
  return getAutomationsQb(['remote_adapter'])
    .selectFrom('remote_adapter')
    .where('team_id', '=', input.teamId)
    .selectAll()
    .orderBy('adapter_type', 'asc')
    .execute();
}

/** Every team's install of one adapter type, or just the named team's. Only a
 *  push door asks this: the caller presents a credential (and, optionally, the
 *  team it means), and the credential picks the row. */
export async function listRemoteAdaptersOfType(input: {
  adapterType: string;
  teamId?: TeamId;
}): Promise<RemoteAdapterRow[]> {
  let query = getAutomationsQb(['remote_adapter'])
    .selectFrom('remote_adapter')
    .where('adapter_type', '=', input.adapterType);
  if (input.teamId !== undefined) query = query.where('team_id', '=', input.teamId);
  return query.selectAll().orderBy('created_at', 'asc').execute();
}

export async function deleteRemoteAdapter(input: {
  teamId: TeamId;
  adapterType: string;
}): Promise<void> {
  await getAutomationsQb(['remote_adapter'])
    .deleteFrom('remote_adapter')
    .where('team_id', '=', input.teamId)
    .where('adapter_type', '=', input.adapterType)
    .execute();
}
