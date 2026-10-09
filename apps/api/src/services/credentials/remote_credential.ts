// Minting the credential for a remote (homespun-CRM) adapter.
//
// A remote adapter authenticates each RPC with a single secret (bearer token or
// shared-secret header — see `protocol/client.ts` `authHeader`). That secret
// lives, encrypted, in a `REMOTE`-type `external_service_credentials` row whose
// `app_id` is the adapter's slug. The `app_id` binding is the safety property:
// `resolveAdapter` refuses a credential whose `app_id` does not match the
// install's `adapter_type`, so a secret minted for one remote adapter can never
// drive another.
//
// Both provisioning surfaces — the one-step web install and the connect-link
// key-entry submit — mint through here, so the type + app_id + payload shape are
// declared in exactly one place.

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import { persistCredential } from './persist_credential';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { RemoteAdapterCredentialPayload } from '../translation_graph/adapters/remote/manifest';

export interface MintRemoteCredentialInput {
  teamId: TeamId;
  /** The member provisioning the secret; null for system/harness flows (the
   *  column is nullable). */
  userId?: UserId | null;
  /** The remote adapter's slug — becomes the credential's `app_id`, binding the
   *  secret to this adapter. */
  adapterType: string;
  /** Credential row name (unique per team); the adapter's display name. */
  displayName: string;
  /** The raw auth secret the remote server checks on every request. Stored only
   *  inside the encrypted `{ secret }` payload — never in the manifest. */
  secret: string;
  /** Re-provision (rotate) an existing same-name credential instead of erroring. */
  replaceExisting?: boolean;
}

/**
 * Mint (or rotate) the `REMOTE` credential for a remote adapter and return its
 * id. The caller writes that id onto the `remote_adapter` row's `credentials_id`.
 */
export async function mintRemoteCredential(
  input: MintRemoteCredentialInput,
): Promise<{ credentialsId: string }> {
  const payload: RemoteAdapterCredentialPayload = { secret: input.secret };
  const credentialsId = await persistCredential({
    teamId: input.teamId,
    userId: (input.userId ?? null) as UserId,
    type: ExternalServiceType.REMOTE,
    name: input.displayName,
    appId: input.adapterType,
    credentials: payload,
    replaceExisting: input.replaceExisting ?? false,
  });
  return { credentialsId };
}
