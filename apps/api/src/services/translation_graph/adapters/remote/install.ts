// One-step remote-adapter install.
//
// Installing a remote (homespun-CRM) adapter and giving it its auth secret is
// ONE act, so the user never feels two steps: pass the secret alongside the
// manifest and this mints the encrypted `REMOTE` credential (bound to the
// adapter via `app_id`), sets the manifest's `credentialsId`, and upserts the
// install — all together. Omit the secret and the install lands with a null FK
// ("needs connecting"), to be filled later by a connect-link submit.
//
// The secret NEVER enters the stored manifest: it goes straight into the
// encrypted credential row; only the resulting FK is persisted on the install.

import { mintRemoteCredential } from '../../../credentials/remote_credential';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';
import { RemoteAdapterManifestFile } from './manifest';
import { upsertRemoteAdapter } from './store';

export interface InstallRemoteAdapterInput {
  teamId: TeamId;
  /** The member installing; null for system/harness flows. */
  userId?: UserId | null;
  /** The parsed, validated manifest (no secret — that rides `secret`). */
  manifest: RemoteAdapterManifestFile;
  /** The adapter's auth secret. When present, minted into a REMOTE credential
   *  and linked; when absent, the install lands with a null credential FK. */
  secret?: string;
}

/**
 * Install (or update) a remote adapter, optionally provisioning its secret in
 * the same operation. Returns the install id and the credential FK (null when
 * no secret was supplied).
 */
export async function installRemoteAdapterFromManifest(
  input: InstallRemoteAdapterInput,
): Promise<{ id: string; credentialsId: string | null }> {
  // Refused before a credential is minted, so an older adapter leaves nothing behind.
  const version = RemoteAdapterManifestFile.shape.protocolVersion.safeParse(
    input.manifest.protocolVersion,
  );
  if (!version.success) {
    throw new Error(
      `Remote adapter "${input.manifest.adapterType}" cannot be installed: ${version.error.issues[0]?.message ?? 'protocolVersion is not 2'}`,
    );
  }

  let credentialsId: string | null = input.manifest.credentialsId ?? null;

  if (input.secret !== undefined) {
    const minted = await mintRemoteCredential({
      teamId: input.teamId,
      userId: input.userId ?? null,
      adapterType: input.manifest.adapterType,
      displayName: input.manifest.displayName ?? input.manifest.adapterType,
      secret: input.secret,
      // Re-provision on re-install (rotation) rather than colliding on the
      // (team, name) unique.
      replaceExisting: true,
    });
    credentialsId = minted.credentialsId;
  }

  const { id } = await upsertRemoteAdapter({
    teamId: input.teamId,
    manifest: { ...input.manifest, ...(credentialsId ? { credentialsId } : {}) },
  });

  return { id, credentialsId };
}
