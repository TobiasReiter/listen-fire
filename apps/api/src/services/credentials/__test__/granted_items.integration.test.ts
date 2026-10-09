import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { cleanupTeam } from '../../../test/harness/cleanup';
import {
  grantItem, listGrantedItems, revokeItem, SPREADSHEET_MIME, DRIVE_FOLDER_MIME,
} from '../granted_items';

describe('granted_items store', () => {
  let teamId: TeamId;
  let credId: ExternalServiceCredentialsId;

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team']).insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `gi-${teamId.slice(0, 8)}` } as any).execute();
    credId = randomUUID() as ExternalServiceCredentialsId;
    await getAutomationsQb(['external_service_credentials']).insertInto('external_service_credentials')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: credId, team_id: teamId, type: ExternalServiceType.GOOGLE, name: 'g', credentials: 'x' } as any)
      .execute();
  });
  afterEach(async () => { await cleanupTeam(teamId); });

  it('grants, filters by mime, and revokes', async () => {
    await grantItem({ credentialsId: credId, itemId: 'sheet1', mimeType: SPREADSHEET_MIME, name: 'S' });
    await grantItem({ credentialsId: credId, itemId: 'folderA', mimeType: DRIVE_FOLDER_MIME, name: 'F' });

    const all = await listGrantedItems(credId);
    expect(all.map((g) => g.itemId).sort()).toEqual(['folderA', 'sheet1']);

    const sheetsOnly = await listGrantedItems(credId, { mimeTypes: [SPREADSHEET_MIME] });
    expect(sheetsOnly).toEqual([{ itemId: 'sheet1', mimeType: SPREADSHEET_MIME, name: 'S' }]);

    await revokeItem({ credentialsId: credId, itemId: 'sheet1' });
    expect(await listGrantedItems(credId, { mimeTypes: [SPREADSHEET_MIME] })).toEqual([]);
  });

  it('re-granting the same item updates its name, not a duplicate', async () => {
    await grantItem({ credentialsId: credId, itemId: 'f1', mimeType: DRIVE_FOLDER_MIME, name: 'old' });
    await grantItem({ credentialsId: credId, itemId: 'f1', mimeType: DRIVE_FOLDER_MIME, name: 'new' });
    const rows = await listGrantedItems(credId);
    expect(rows).toEqual([{ itemId: 'f1', mimeType: DRIVE_FOLDER_MIME, name: 'new' }]);
  });
});
