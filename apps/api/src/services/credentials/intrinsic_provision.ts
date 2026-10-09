// Author-time connect-LINK intrinsic provisioning.
//
// A third connect kind, alongside OAuth (browser sign-in) and key-entry (paste
// a key). An INTRINSIC credential is one Listen-Fire owns both ends of: there's no
// external provider to authorize and no key for the user to paste — the server
// MINTS the credential itself. "Connecting" such an adapter is pure
// provisioning: the user confirms, the server mints + registers the token and
// persists the credential envelope.
//
// One provisioner per intrinsic credential type, paired with the SAME minting
// logic the in-app `addCredential` mutation runs (pipelineConfiguration.ts), so
// the connect-link path and the in-app path can never drift. The connect-link
// landing route (connect.ts) calls `intrinsicProvisionerForType` on submit;
// `addCredential` calls the same provisioner for its own intrinsic branch.

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { ApiKeyService } from '../api_key';
import { platformTokenRegistry } from '../translation_graph/engine/platform_token_registry_db';
import { NATIVE_VALUATIONS_ADAPTER_TYPE } from '../translation_graph/adapters/native_valuations';
import { KG_ADAPTER_TYPE } from '../translation_graph/adapters/knowledge_graph';

export interface IntrinsicProvisionArgs {
  teamId: TeamId;
  /** The user the minted credential is owned by — the connect token's user, or
   *  the acting user in-app. Threaded explicitly because the connect-link route
   *  is tokenless (no auth-context user); the mint must not read the context. */
  userId: UserId;
  /** The credential's display name — also seeds the minted api-key's name. */
  credentialName: string;
  /** Optional adapter base-URL override, carried into the credentials envelope. */
  baseUrl?: string;
}

/** Mints + registers an Listen-Fire-owned credential and returns the envelope to
 *  persist. `provision` is the substantive, single-use action — callers consume
 *  the connect token BEFORE invoking it so a replay can't double-mint. */
export interface IntrinsicProvisioner {
  provision(args: IntrinsicProvisionArgs): Promise<{ credentials: unknown }>;
}

/**
 * An override is stored HOST-ONLY: every request path carries its own `/api/v1`
 * prefix, so a baked-in one doubles up (96f9c9c1a). An override that resolves to
 * nothing is stored as nothing — the adapter then reads this instance's own
 * `API_BASE_URL` live, which is what makes a COMPOSED deployment connect with
 * nothing to paste, and what stops a host change from stranding the credential
 * on an address that stopped answering.
 */
function hostOnlyBaseUrl(baseUrl?: string): string | undefined {
  const host = baseUrl?.trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return host ? host : undefined;
}

// Auto-mint an Listen-Fire-owned integration token. Three atomic steps:
//   1. Mint an api-key with the API scope the adapter reaches through.
//   2. Register its id in `platform_owned_token` so the firing filter drops echoes
//      of our own writes.
//   3. Build the credentials envelope (plaintext key + api-key id + optional
//      baseUrl) the adapter replays and `onDelete` revokes.
// A registry failure leaves a usable api-key floating, so we revoke it on the
// error path rather than leak it.
//
// One shape, parameterised, because the two Listen-Fire-owned systems differ in
// nothing but which scope and which adapter the token belongs to — and a second
// hand-copied body is how the scope and the echo-filter key drift apart.
function platformOwnedProvisioner(input: {
  /** The api-key scope naming the API surface this adapter reaches. */
  scope: string;
  /** The adapter the token belongs to, as the echo filter names it. */
  adapterType: string;
}): IntrinsicProvisioner {
  return {
    async provision({ teamId, userId, credentialName, baseUrl }) {
      const minted = await ApiKeyService.createForOwner({
        name: `${credentialName} (auto)`,
        scopes: [input.scope],
        teamId,
        createdBy: userId,
      });
      try {
        await platformTokenRegistry.registerToken({
          teamId,
          adapterType: input.adapterType,
          tokenId: minted.id,
        });
      } catch (err) {
        await ApiKeyService.revokeById(minted.id).catch(() => {});
        throw err;
      }
      const host = hostOnlyBaseUrl(baseUrl);
      return {
        credentials: {
          apiKey: minted.key,
          apiKeyId: minted.id,
          ...(host ? { baseUrl: host } : {}),
        },
      };
    },
  };
}

const nativeValuationsProvisioner = platformOwnedProvisioner({
  scope: 'valuations',
  adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
});

// The knowledge graph is reached over HTTP with a stored credential like any
// other system (D25) — so connecting it is the same act as connecting
// Valuations, and the token is Listen-Fire-owned for the same reason: the graph
// echoes our own writes back through its mutation webhook.
const nativeKnowledgeProvisioner = platformOwnedProvisioner({
  scope: 'knowledge',
  adapterType: KG_ADAPTER_TYPE,
});

const INTRINSIC_PROVISION_BY_TYPE: Partial<Record<ExternalServiceType, IntrinsicProvisioner>> = {
  [ExternalServiceType.NATIVE_VALUATIONS]: nativeValuationsProvisioner,
  [ExternalServiceType.NATIVE_KNOWLEDGE]: nativeKnowledgeProvisioner,
};

/** The provisioner for an intrinsic credential type, or undefined if the type
 *  isn't intrinsically provisionable (OAuth / key-entry / handshake). */
export function intrinsicProvisionerForType(
  type: ExternalServiceType,
): IntrinsicProvisioner | undefined {
  return INTRINSIC_PROVISION_BY_TYPE[type];
}

/** Whether a credential type is connected by server-side provisioning (no
 *  external sign-in, no key to paste) — STATIC membership. */
export function isIntrinsicProvisionable(type: ExternalServiceType): boolean {
  return type in INTRINSIC_PROVISION_BY_TYPE;
}
