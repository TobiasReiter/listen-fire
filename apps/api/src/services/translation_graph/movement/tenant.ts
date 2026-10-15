// The run host's one conversion between its team (the database's `TeamId`)
// and the engine's tenant (the contract's opaque `TenantId`). The engine and
// the contract never see a team; the run host names its team as the tenant on
// every run it hands the engine, and reads the team back off every segment
// the engine opens.

import { tenantIdOf, type TenantId } from 'engine-contracts';
import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';

/** A team id is the team row's key, a Postgres `uuid`: any GUID-shaped hex
 *  string, whatever its version bits. */
export const teamKeySchema = z.custom<TeamId>((value) => z.guid().safeParse(value).success);

/** The tenant a team's runs are for. */
export function tenantOfTeam(teamId: TeamId): TenantId {
  return tenantIdOf(teamId);
}

/** The team a tenant the engine names stands for. Every tenant this host
 *  hands the engine is a team's, so anything else is refused. */
export function teamOfTenant(tenantId: TenantId): TeamId {
  return teamKeySchema.parse(tenantId);
}
