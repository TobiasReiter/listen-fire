import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../../generated/kysely/automations/ExternalServiceCredentials';

import { getAutomationsQb, getCoreQb } from '../../../../../lib/kysely';
import ExternalServiceType from '../../../../../generated/kysely/automations/ExternalServiceType';
import { cleanupTeam } from '../../../../../test/harness/cleanup';
import { grantItem, DRIVE_FOLDER_MIME } from '../../../../credentials/granted_items';
import {
  grantSpreadsheet, listGrantedSpreadsheets, listGrantedSpreadsheetIds, revokeSpreadsheet,
} from '../grants';

describe('sheets grants facade', () => {
  let teamId: TeamId; let credId: ExternalServiceCredentialsId;
  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team']).insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `sg-${teamId.slice(0, 8)}` } as any).execute();
    credId = randomUUID() as ExternalServiceCredentialsId;
    await getAutomationsQb(['external_service_credentials']).insertInto('external_service_credentials')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: credId, team_id: teamId, type: ExternalServiceType.GOOGLE, name: 'g', credentials: 'x' } as any).execute();
  });
  afterEach(async () => { await cleanupTeam(teamId); });

  it('lists only spreadsheets, not drive folders on the same credential', async () => {
    await grantSpreadsheet({ credentialsId: credId, spreadsheetId: 'sh1', name: 'Sheet' });
    await grantItem({ credentialsId: credId, itemId: 'fold1', mimeType: DRIVE_FOLDER_MIME, name: 'Folder' });
    const sheets = await listGrantedSpreadsheets(credId);
    expect(sheets).toEqual([{ spreadsheetId: 'sh1', name: 'Sheet' }]);
  });

  it('lists bare spreadsheet ids in oldest-first order', async () => {
    await grantSpreadsheet({ credentialsId: credId, spreadsheetId: 'sh1', name: 'Sheet 1' });
    await grantSpreadsheet({ credentialsId: credId, spreadsheetId: 'sh2', name: 'Sheet 2' });
    const ids = await listGrantedSpreadsheetIds(credId);
    expect(ids).toEqual(['sh1', 'sh2']);
  });

  it('records a null name when none is given', async () => {
    await grantSpreadsheet({ credentialsId: credId, spreadsheetId: 'sh1' });
    const sheets = await listGrantedSpreadsheets(credId);
    expect(sheets).toEqual([{ spreadsheetId: 'sh1', name: null }]);
  });

  it('revokeSpreadsheet removes the spreadsheet from the granted list', async () => {
    await grantSpreadsheet({ credentialsId: credId, spreadsheetId: 'sh1', name: 'Sheet' });
    await revokeSpreadsheet({ credentialsId: credId, spreadsheetId: 'sh1' });
    const sheets = await listGrantedSpreadsheets(credId);
    expect(sheets).toEqual([]);
  });
});
