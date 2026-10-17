// Postgres-backed PlatformTokenRegistry implementation. The in-memory variant
// in platform_token_registry.ts stays as a test/placeholder; this module is the
// production implementation, backed by `public.platform_owned_token`.

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { Actor } from 'movement-engine/public/adapter';
import type { PlatformTokenRegistry } from './platform_token_registry';

import { getAutomationsQb } from '../../../lib/kysely';

export class PostgresPlatformTokenRegistry implements PlatformTokenRegistry {
  async isPlatformOwned(input: {
    teamId: TeamId;
    adapterType: string;
    actor: Actor;
  }): Promise<boolean> {
    if (input.actor.type !== 'api-token') return false;
    if (input.actor.id === null) return false;

    const qb = getAutomationsQb(['platform_owned_token']);
    const row = await qb
      .selectFrom('platform_owned_token')
      .where('team_id', '=', input.teamId)
      .where('adapter_type', '=', input.adapterType)
      .where('external_token_id', '=', input.actor.id)
      .where('revoked_at', 'is', null)
      .select('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  async registerToken(input: {
    teamId: TeamId;
    adapterType: string;
    tokenId: string;
    description?: string;
  }): Promise<void> {
    const qb = getAutomationsQb(['platform_owned_token']);
    // Idempotent insert — the unique partial index covers (team, adapter, token)
    // for non-revoked rows. ON CONFLICT does nothing; if there's an existing
    // revoked row, we leave it alone and create a new active row anyway by
    // letting the unique partial index allow it.
    await qb
      .insertInto('platform_owned_token')
      .values({
        team_id: input.teamId,
        adapter_type: input.adapterType,
        external_token_id: input.tokenId,
        description: input.description ?? null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async unregisterToken(input: {
    teamId: TeamId;
    adapterType: string;
    tokenId: string;
  }): Promise<void> {
    const qb = getAutomationsQb(['platform_owned_token']);
    await qb
      .updateTable('platform_owned_token')
      .set({ revoked_at: new Date() })
      .where('team_id', '=', input.teamId)
      .where('adapter_type', '=', input.adapterType)
      .where('external_token_id', '=', input.tokenId)
      .where('revoked_at', 'is', null)
      .execute();
  }
}

/** Convenience singleton for production code. Tests should use InMemoryPlatformTokenRegistry. */
export const platformTokenRegistry: PlatformTokenRegistry = new PostgresPlatformTokenRegistry();
