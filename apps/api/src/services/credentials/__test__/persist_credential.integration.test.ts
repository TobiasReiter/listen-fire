// Real-DB gate for the (team_id, name) unique constraint on
// external_service_credentials and the service-level guard in persistCredential.
//
// The constraint is the primary enforcement surface; the service guard
// translates a raw unique-violation DB error into a typed
// CredentialNameTakenError so callers get a clean signal instead of a
// Postgres error object.
//
// Uses the integration test DB (DATABASE_URL_TEST) with the migration applied
// via globalSetup. Heavy lifecycle deps (Attio API calls, token registration)
// are irrelevant to this gate and are isolated via a jest.mock.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';

// credentialLifecycle imports Attio API clients and token registries that
// require a live adapter stack. They are not the subject of this test.
jest.mock('../credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

import { persistCredential, CredentialNameTakenError } from '../persist_credential';

let teamId: TeamId;

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `persist-cred-test-${teamId.slice(0, 8)}` } as any)
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

const baseInput = () => ({
  teamId,
  // user_id is nullable on the table; cast null past the non-optional TypeScript param
  userId: null as unknown as import('../../../generated/kysely/core/User').UserId,
  type: ExternalServiceType.GOOGLE,
  credentials: { access_token: 'test-token' },
});

describe('persistCredential', () => {
  it('inserts a new credential and returns its uuid', async () => {
    const id = await persistCredential({ ...baseInput(), name: 'My Google Creds' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('throws CredentialNameTakenError on a second insert with the same (teamId, name)', async () => {
    await persistCredential({ ...baseInput(), name: 'Duplicate' });

    await expect(
      persistCredential({ ...baseInput(), name: 'Duplicate' }),
    ).rejects.toThrow(CredentialNameTakenError);
  });

  it('CredentialNameTakenError message names the conflicting credential', async () => {
    await persistCredential({ ...baseInput(), name: 'Named Cred' });

    await expect(
      persistCredential({ ...baseInput(), name: 'Named Cred' }),
    ).rejects.toThrow(/Named Cred/);
  });

  it('replaceExisting: true upserts without error', async () => {
    await persistCredential({ ...baseInput(), name: 'Replace Me' });

    await expect(
      persistCredential({ ...baseInput(), name: 'Replace Me', replaceExisting: true }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('different names on the same team do not conflict', async () => {
    await persistCredential({ ...baseInput(), name: 'Cred A' });
    await expect(
      persistCredential({ ...baseInput(), name: 'Cred B' }),
    ).resolves.toBeTruthy();
  });
});
