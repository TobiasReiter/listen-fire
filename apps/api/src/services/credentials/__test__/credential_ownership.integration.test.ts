// The platform's answer to "is this credential the run's team's?": a row of
// that team's in the vault, and nothing else.

import { randomUUID } from 'node:crypto';

import { tenantIdOf } from 'engine-contracts';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { cleanupTeam } from '../../../test/harness/cleanup';
import { teamCredentials } from '../credential_ownership';

async function team(): Promise<TeamId> {
  const id = randomUUID() as TeamId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await getCoreQb(['team']).insertInto('team').values({ id, name: `own-${id.slice(0, 8)}` } as any).execute();
  return id;
}

describe('teamCredentials', () => {
  let mine: TeamId;
  let theirs: TeamId;
  let credId: ExternalServiceCredentialsId;

  beforeEach(async () => {
    mine = await team();
    theirs = await team();
    credId = randomUUID() as ExternalServiceCredentialsId;
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: credId, team_id: mine, type: ExternalServiceType.ATTIO, name: 'crm', credentials: 'x' } as any)
      .execute();
  });
  afterEach(async () => {
    await cleanupTeam(mine);
    await cleanupTeam(theirs);
  });

  it("is the owning team's, and no other team's", async () => {
    expect(await teamCredentials.belongsTo({ teamId: tenantIdOf(mine), credentialsId: credId })).toBe(true);
    expect(await teamCredentials.belongsTo({ teamId: tenantIdOf(theirs), credentialsId: credId })).toBe(false);
  });

  it('answers no for an id that is no row, or is not a row id at all', async () => {
    expect(await teamCredentials.belongsTo({ teamId: tenantIdOf(mine), credentialsId: randomUUID() })).toBe(false);
    expect(await teamCredentials.belongsTo({ teamId: tenantIdOf(mine), credentialsId: 'cred-a' })).toBe(false);
  });
});
