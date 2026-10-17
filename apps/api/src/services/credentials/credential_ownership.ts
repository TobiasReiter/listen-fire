// Which team a stored credential belongs to, as the engine host asks before
// it builds an instance a run names a credential for: a run reaches only its
// own team's connections, whatever id its input carries.

import { z } from 'zod';

import type { CredentialOwnership } from 'movement-engine/public/host';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb } from '../../lib/kysely';
import { teamOfTenant } from '../translation_graph/movement/tenant';

export const teamCredentials: CredentialOwnership = {
  async belongsTo({ teamId, credentialsId }) {
    // A row id is a UUID: anything else is no row of any team's (and would
    // fail the comparison in the database rather than answer).
    if (!z.guid().safeParse(credentialsId).success) return false;
    const row = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', credentialsId as ExternalServiceCredentialsId)
      .where('team_id', '=', teamOfTenant(teamId))
      .select('id')
      .executeTakeFirst();
    return row !== undefined;
  },
};
