// Persisting an external-service credential — the shared core that turns a
// decrypted credentials envelope into a stored, team-bound
// `external_service_credentials` row.
//
// Two callers share this: the in-app `addCredential` tRPC mutation (popup
// connect flow) and the author-time connect-LINK landing route
// (`/api/connect/:token/complete`). Both end up with the same envelope (from a
// claim token) and need identical lifecycle + encryption + identifier handling
// — so that logic lives here once rather than being reimplemented per caller.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import { forgetAffinityWorkspace } from '../../adapters/affinity/apiClient';
import { encryptToken } from '../../lib/credentials';
import { getAutomationsQb } from '../../lib/kysely';
import { credentialLifecycle } from './credential_lifecycle';
import { defaultAppIdForType } from './app_id';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

/** Thrown when a non-replace insert collides on the (team_id, name) unique constraint. */
export class CredentialNameTakenError extends Error {
  constructor(name: string) {
    super(`A credential named "${name}" already exists for this team`);
    this.name = 'CredentialNameTakenError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

interface PersistCredentialInput {
  teamId: TeamId;
  userId: UserId;
  /** Human-readable name to store the credential under. */
  name: string;
  type: ExternalServiceType;
  /** The decrypted credentials envelope (e.g. claimed pending OAuth tokens). */
  credentials: unknown;
  /**
   * RECONNECT semantics: when true, first delete any existing credential of the
   * same (team, type, name) so this acts as an upsert-by-name rather than
   * stacking a second row. Used by the connect-LINK path, where re-opening a
   * link for an already-connected adapter must REPLACE the key, not duplicate
   * it. The in-app `addCredential` path leaves this off (it explicitly creates
   * new named rows). Without this flag a second insert with the same (team, name)
   * throws CredentialNameTakenError (enforced by the DB unique constraint).
   */
  replaceExisting?: boolean;
  /**
   * Which app/bot in the external service granted access (the `app_id` column).
   * For Slack: 'legacy' (the old app) vs 'listen-fire' (movements app). Omitted → null,
   * read as the legacy app by every filter. Set by the connector that minted
   * the credential, so a second app of the same type is told apart.
   */
  appId?: string | null;
}

/**
 * Run the create lifecycle hook, encrypt, derive the Slack identifier, and
 * insert the `external_service_credentials` row. Returns the new row id.
 *
 * With `replaceExisting`, any prior credential of the same (team, type, name)
 * is removed first so the call upserts-by-name (reconnect / replace).
 */
export async function persistCredential(input: PersistCredentialInput): Promise<string> {
  if (input.replaceExisting) {
    // Triggers bound to the replaced credential are released by the vault's
    // in-schema ON DELETE SET NULL (restored with the vault's move, D7).
    await getAutomationsQb(['external_service_credentials'])
      .deleteFrom('external_service_credentials')
      .where('team_id', '=', input.teamId)
      .where('type', '=', input.type)
      .where('name', '=', input.name)
      .execute();
  }

  let credentials = input.credentials;

  const createLifecycle = credentialLifecycle(input.type);
  if (createLifecycle?.onCreate) {
    credentials = await createLifecycle.onCreate({
      credentials,
      teamId: input.teamId,
    });
  }

  const id = randomUUID();
  const encrypted = await encryptToken(JSON.stringify(credentials), id);

  let identifier: string | null = null;
  if (input.type === ExternalServiceType.SLACK) {
    const creds = credentials as { teamId?: string; enterpriseId?: string };
    if (creds.teamId) {
      identifier = `teamId:${creds.teamId}`;
    } else if (creds.enterpriseId) {
      identifier = `enterpriseId:${creds.enterpriseId}`;
    }
  }

  try {
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({
        id: id as ExternalServiceCredentialsId,
        name: input.name,
        type: input.type,
        credentials: encrypted,
        identifier,
        // Explicit appId wins; else the type's default (Slack → 'listen-fire', the
        // modern app). Pre-existing legacy rows keep their null (read as legacy).
        app_id: input.appId ?? defaultAppIdForType(input.type) ?? null,
        team_id: input.teamId,
        user_id: input.userId,
      })
      .executeTakeFirst();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CredentialNameTakenError(input.name);
    }
    throw err;
  }

  // A workspace whose key was just (re)connected is a workspace somebody has
  // been editing. Whatever we cached about its shape predates that.
  if (input.type === ExternalServiceType.AFFINITY) {
    const creds = credentials as { apiKey?: unknown; baseUrl?: unknown };
    if (typeof creds?.apiKey === 'string') {
      forgetAffinityWorkspace(
        creds.apiKey,
        typeof creds.baseUrl === 'string' ? creds.baseUrl : undefined,
      );
    }
  }

  return id;
}
