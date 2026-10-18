// A stored credential the given team owns. The engine host refuses a run that
// names a credential its team does not own, so a test that stands in a
// credential id for a run needs a real row.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import { getAutomationsQb } from '../../lib/kysely';

export async function seedTeamCredential(teamId: TeamId): Promise<ExternalServiceCredentialsId> {
  const id = randomUUID() as ExternalServiceCredentialsId;
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id, team_id: teamId, type: ExternalServiceType.ATTIO, name: `test-${id.slice(0, 8)}`, credentials: 'x' } as any)
    .execute();
  return id;
}
