// The secrets family's contract suite against the platform's store, the
// encrypted `external_service_credentials` table, plus what only this store
// owes: its ciphertext and the legacy `lib/credentials` cipher read each
// other's, a type's stored payload keeps its shape under a refresh, and the
// Dropbox refresh (now through the family) spends the refresh token once when
// two processes find the same stale token.

import { randomUUID } from 'node:crypto';

import { createSecretsFamily, type SecretFields } from 'movement-engine/public/secrets';
import { secretsContractCases } from 'movement-engine/public/secrets-testing';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { decryptToken, encryptToken } from '../../../lib/credentials';
import { getAutomationsQb, getCoreQb } from '../../../lib/kysely';
import { DropboxAuthClient } from '../../../adapters/dropbox/authClient';
import { camelTokenPayloadShape, postgresSecrets } from '../secrets_postgres';

let teamId: TeamId;

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `secrets-pg-test-${teamId.slice(0, 8)}` } as any)
    .execute();
});

afterAll(async () => {
  await getAutomationsQb(['external_service_credentials']).deleteFrom('external_service_credentials').where('team_id', '=', teamId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

/** A row written the way the connect flows write one: `encryptToken` of the
 *  JSON payload, context = the row id. */
async function seedRow(payload: Record<string, unknown>, type: ExternalServiceType = ExternalServiceType.REMOTE): Promise<string> {
  const id = randomUUID();
  await getAutomationsQb(['external_service_credentials'])
    .insertInto('external_service_credentials')
    .values({
      id: id as ExternalServiceCredentialsId,
      name: `secret-${id.slice(0, 8)}`,
      team_id: teamId,
      type,
      credentials: await encryptToken(JSON.stringify(payload), id),
    })
    .execute();
  return id;
}

/** The stored payload, read with the legacy cipher. */
async function legacyRead(id: string): Promise<unknown> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', id as ExternalServiceCredentialsId)
    .select(['id', 'credentials'])
    .executeTakeFirstOrThrow();
  return JSON.parse(await decryptToken(row.credentials, row.id));
}

describe('secrets contract: Postgres (external_service_credentials)', () => {
  for (const contractCase of secretsContractCases) {
    it(contractCase.name, async () => {
      await contractCase.run({
        backend: postgresSecrets({ teamId }),
        // A second store handle runs its lock and its reads on its own
        // connection, as another process would.
        sibling: () => postgresSecrets({ teamId }),
        seed: (fields: SecretFields) => seedRow({ ...fields }),
        missingRef: () => randomUUID(),
      });
    });
  }
});

describe('Postgres secrets store: ciphertext and payload shapes unchanged', () => {
  it('the legacy cipher reads what the family wrote, and the family reads what the legacy cipher wrote', async () => {
    const id = await seedRow({ secret: 'legacy-secret', note: 'kept' });
    const family = createSecretsFamily({ backend: postgresSecrets() });
    const seen = await family.resolve(id);
    expect(seen.fields).toEqual({ secret: 'legacy-secret', note: 'kept' });
    await family.writeBack(id, { secret: 'new-secret' }, seen.version);
    expect(await legacyRead(id)).toEqual({ secret: 'new-secret', note: 'kept' });
  });

  it('a refresh of a camel-cased OAuth payload keeps its keys and types, and its other keys', async () => {
    const id = await seedRow(
      { accessToken: 'a0', refreshToken: 'r0', expiresAt: 946_684_800_000, emailAddress: 'm@example.test', scopes: ['s1'] },
      ExternalServiceType.GOOGLE_GMAIL,
    );
    const family = createSecretsFamily({ backend: postgresSecrets({ shape: camelTokenPayloadShape }) });
    const seen = await family.resolve(id);
    expect(seen.fields).toEqual({ access_token: 'a0', refresh_token: 'r0', expires_at: '2000-01-01T00:00:00.000Z', emailAddress: 'm@example.test' });
    await family.refresh(id, {
      seenVersion: seen.version,
      refresher: async () => ({ access_token: 'a1', expires_at: '2030-01-01T00:00:00.000Z' }),
    });
    expect(await legacyRead(id)).toEqual({
      accessToken: 'a1',
      refreshToken: 'r0',
      expiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
      emailAddress: 'm@example.test',
      scopes: ['s1'],
    });
  });

  it('a shell row (no ciphertext) is refused by name, not by the cipher', async () => {
    const id = randomUUID();
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      .values({ id: id as ExternalServiceCredentialsId, name: `shell-${id.slice(0, 8)}`, team_id: teamId, type: ExternalServiceType.REMOTE, credentials: null })
      .execute();
    await expect(createSecretsFamily({ backend: postgresSecrets() }).resolve(id)).rejects.toThrow(/must be reconnected/);
  });

  it('two Dropbox clients finding the same stale token make one token call, and both get the new token', async () => {
    const stale = { accessToken: 'stale', refreshToken: 'dropbox-refresh', expiresAt: Date.now() - 1000 };
    const id = await seedRow(stale, ExternalServiceType.DROPBOX);
    const realFetch = global.fetch;
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ access_token: `fresh-${calls}`, expires_in: 14_400 });
    }) as typeof fetch;
    try {
      const client = () => new DropboxAuthClient({ clientId: 'cid', clientSecret: 'csecret', redirectBaseUrl: 'http://localhost' });
      const tokens = await Promise.all([client().getValidAccessToken(id, stale), client().getValidAccessToken(id, stale)]);
      expect(calls).toBe(1);
      expect(tokens).toEqual(['fresh-1', 'fresh-1']);
      const stored = await legacyRead(id);
      expect(stored).toEqual({ accessToken: 'fresh-1', refreshToken: 'dropbox-refresh', expiresAt: expect.any(Number) });
    } finally {
      global.fetch = realFetch;
    }
  });
});
