// Real-DB gate for the REMOTE adapter credential: mintRemoteCredential must
// persist a REMOTE-type row whose `app_id` is the adapter slug (the binding
// resolveAdapter checks) and whose encrypted payload decrypts to { secret }.
//
// Uses the integration test DB (DATABASE_URL_TEST). The credential lifecycle
// (Attio API clients etc.) is irrelevant here and isolated via jest.mock.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { decryptToken } from '../../../lib/credentials';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';

jest.mock('../credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

import { mintRemoteCredential } from '../remote_credential';

let teamId: TeamId;

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `remote-cred-test-${teamId.slice(0, 8)}` } as any)
    .execute();
});

afterAll(async () => {
  await getAutomationsQb(['external_service_credentials'])
    .deleteFrom('external_service_credentials')
    .where('team_id', '=', teamId)
    .execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

afterEach(async () => {
  await getAutomationsQb(['external_service_credentials'])
    .deleteFrom('external_service_credentials')
    .where('team_id', '=', teamId)
    .execute();
});

describe('mintRemoteCredential', () => {
  it('persists a REMOTE row bound to the adapter slug via app_id, secret encrypted', async () => {
    const { credentialsId } = await mintRemoteCredential({
      teamId,
      adapterType: 'acme_crm',
      displayName: 'Acme CRM',
      secret: 'crm-token-xyz',
    });

    const row = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', credentialsId as never)
      .select(['id', 'type', 'name', 'app_id', 'credentials'])
      .executeTakeFirstOrThrow();

    expect(row.type).toBe(ExternalServiceType.REMOTE);
    expect(row.name).toBe('Acme CRM');
    // The binding resolveAdapter enforces: app_id === the adapter slug.
    expect(row.app_id).toBe('acme_crm');
    // Secret is encrypted at rest and decrypts to the { secret } payload.
    const decrypted = JSON.parse(await decryptToken(row.credentials, row.id));
    expect(decrypted).toEqual({ secret: 'crm-token-xyz' });
  });

  it('two different adapters on one team get distinct app_id bindings', async () => {
    const a = await mintRemoteCredential({
      teamId,
      adapterType: 'acme_crm',
      displayName: 'Acme CRM',
      secret: 's1',
    });
    const b = await mintRemoteCredential({
      teamId,
      adapterType: 'other_crm',
      displayName: 'Other CRM',
      secret: 's2',
    });

    const rows = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', 'in', [a.credentialsId, b.credentialsId] as never)
      .select(['app_id', 'name'])
      .execute();

    const byName = new Map(rows.map((r) => [r.name, r.app_id]));
    expect(byName.get('Acme CRM')).toBe('acme_crm');
    expect(byName.get('Other CRM')).toBe('other_crm');
  });
});
