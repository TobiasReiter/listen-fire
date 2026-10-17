// Credential lifecycle — adapter-keyed hooks that run when an external-service
// credential is created, updated, or deleted.
//
// The concrete concern today is the *owned-token* registration used for echo
// recognition (Layer 14.4): some adapters' writes generate webhooks back to us,
// so we record the external token id a write was made under in
// `platform_owned_token` and drop inbound events whose actor matches. Capturing
// and releasing that id is per-adapter:
//   - Attio: probe `/v2/self` to discover the api-token id, register it, and
//     stamp it onto the persisted credentials so rotate/revoke can find it.
//     Rotating the access token (update) re-resolves to a new api-token id.
//   - Listen-Fire Valuations: the auto-minted api-key's id is the owned token. The
//     mint flow (in the credential router) registers it inline; teardown here
//     unregisters and revokes the key.
//
// Keyed by `ExternalServiceType` — the credential's type — so the credential
// router and the setup-agent router dispatch through one seam instead of the
// `if (type === 'attio')` branches and the duplicated `identifyAndRegisterAttioToken`
// helper they used to each carry. Adapters with no lifecycle concern simply
// aren't in the registry (the hooks are no-ops for them).

import type { z } from 'zod';
import type { TeamId } from '../../generated/kysely/core/Team';

import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { AttioAPIClient, attioCredsParser } from '../../adapters/attio/apiClient';
import { ATTIO_ADAPTER_TYPE } from '../translation_graph/adapters/attio';
import {
  NATIVE_VALUATIONS_ADAPTER_TYPE,
  nativeValuationsCredsParser,
} from '../translation_graph/adapters/native_valuations';
import { platformTokenRegistry } from '../translation_graph/engine/platform_token_registry_db';
import { ApiKeyService } from '../api_key';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../lib/recording';
import { logger } from 'movement-engine/public/log';

interface LifecycleContext {
  /** The decrypted credentials envelope this hook operates on. */
  credentials: unknown;
  teamId: TeamId;
}

interface CredentialLifecycle {
  /**
   * After the new credentials envelope is resolved on create. Returns the
   * (possibly enriched) envelope to persist.
   */
  onCreate?(input: LifecycleContext): Promise<unknown>;
  /**
   * After the updated envelope is resolved on update — `prior` is the decrypted
   * previous envelope, so the hook can release state tied to the old token
   * before capturing the new one. Returns the envelope to persist.
   */
  onUpdate?(input: LifecycleContext & { prior: unknown }): Promise<unknown>;
  /** Before the credential row is deleted — release any external/owned state. */
  onDelete?(input: LifecycleContext): Promise<void>;
}

/**
 * Identify the Attio api-token id for this access token via `/v2/self` and
 * register it in `platform_owned_token`, returning the credentials with
 * `apiTokenId` populated so subsequent rotate / revoke paths can find the
 * registered id without re-introspecting. Best-effort: any failure logs a
 * warning and returns the unmodified creds (Layer 14.2's circuit breaker
 * carries loop prevention in that case — Layer 14.4 is an optimization).
 */
async function identifyAndRegisterAttioToken(
  creds: z.infer<typeof attioCredsParser>,
  teamId: TeamId,
): Promise<z.infer<typeof attioCredsParser>> {
  const probedCreds = isTestHarnessTeam(teamId)
    ? (injectFakeBaseUrl(creds, 'ATTIO') as z.infer<typeof attioCredsParser>)
    : creds;
  try {
    const client = new AttioAPIClient(probedCreds);
    const apiTokenId = await client.identifyApiTokenId();
    if (!apiTokenId) {
      logger.warn(
        '[Attio] /v2/self did not surface a token id; Layer 14.4 echo recognition disabled for this credential (Layer 14.2 carries loop prevention)',
      );
      return creds;
    }
    await platformTokenRegistry.registerToken({
      teamId,
      adapterType: ATTIO_ADAPTER_TYPE,
      tokenId: apiTokenId,
    });
    return { ...creds, apiTokenId };
  } catch (err) {
    logger.warn('[Attio] identifyAndRegisterAttioToken failed; Layer 14.2 carries loop prevention', {
      err,
    });
    return creds;
  }
}

async function unregisterAttioToken(prior: unknown, teamId: TeamId): Promise<void> {
  try {
    const creds = attioCredsParser.parse(prior);
    if (creds.apiTokenId) {
      await platformTokenRegistry.unregisterToken({
        teamId,
        adapterType: ATTIO_ADAPTER_TYPE,
        tokenId: creds.apiTokenId,
      });
    }
  } catch (err) {
    logger.warn('[Attio] failed to unregister owned token', { err });
  }
}

const LIFECYCLES: Partial<Record<ExternalServiceType, CredentialLifecycle>> = {
  [ExternalServiceType.ATTIO]: {
    onCreate: ({ credentials, teamId }) =>
      identifyAndRegisterAttioToken(attioCredsParser.parse(credentials), teamId),
    onUpdate: async ({ credentials, teamId, prior }) => {
      // The new access token may resolve to a different api-token id — drop the
      // prior registration before capturing the new one.
      await unregisterAttioToken(prior, teamId);
      return identifyAndRegisterAttioToken(attioCredsParser.parse(credentials), teamId);
    },
    onDelete: ({ credentials, teamId }) => unregisterAttioToken(credentials, teamId),
  },
  [ExternalServiceType.NATIVE_VALUATIONS]: {
    // Mirror of the auto-mint in the credential router: revoke the underlying
    // api-key and unregister from platform_owned_token so we don't leave a usable
    // token or a stale echo-suppression entry. Manually-wired integrations with
    // no apiKeyId (legacy / dev seed) have nothing to revoke.
    onDelete: async ({ credentials, teamId }) => {
      try {
        const prior = nativeValuationsCredsParser.parse(credentials);
        if (prior.apiKeyId) {
          await platformTokenRegistry.unregisterToken({
            teamId,
            adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
            tokenId: prior.apiKeyId,
          });
          await ApiKeyService.revoke(prior.apiKeyId);
        }
      } catch {
        // Best-effort — proceed with row deletion even if cleanup fails.
      }
    },
  },
};

/** The lifecycle hooks for a credential type, or undefined when it has none. */
export function credentialLifecycle(
  type: ExternalServiceType,
): CredentialLifecycle | undefined {
  return LIFECYCLES[type];
}
