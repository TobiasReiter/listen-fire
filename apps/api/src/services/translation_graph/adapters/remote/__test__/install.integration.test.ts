// Real-DB gate for one-step remote-adapter install: supplying the secret at
// install time mints the REMOTE credential (app_id bound to the slug) and sets
// the remote_adapter row's credentials_id in one operation. Installing without
// a secret leaves the FK null ("needs connecting").

import { randomUUID } from 'node:crypto';

import { getAutomationsQb, getCoreQb } from '../../../../../lib/kysely';
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import ExternalServiceType from '../../../../../generated/kysely/automations/ExternalServiceType';
import { RemoteAdapterManifestFile } from '../manifest';

jest.mock('../../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

import { installRemoteAdapterFromManifest } from '../install';

let teamId: TeamId;

const manifest = (adapterType: string) =>
  RemoteAdapterManifestFile.parse({
    protocolVersion: 2,
    adapterType,
    displayName: 'Acme CRM',
    baseUrl: 'https://crm.example/adapter',
    authStrategy: { kind: 'bearer' },
    supportedTriggers: ['webhook'],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods: ['describe', 'createRecord'],
  });

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  await getCoreQb(['team'])
    .insertInto('team')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values({ id: teamId, name: `remote-install-${teamId.slice(0, 8)}` } as any)
    .execute();
});

afterEach(async () => {
  await getAutomationsQb(['remote_adapter']).deleteFrom('remote_adapter').where('team_id', '=', teamId).execute();
  await getAutomationsQb(['external_service_credentials'])
    .deleteFrom('external_service_credentials')
    .where('team_id', '=', teamId)
    .execute();
});

afterAll(async () => {
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

describe('installRemoteAdapterFromManifest', () => {
  it('with a secret: mints a REMOTE credential (app_id = slug) and links it to the install', async () => {
    const result = await installRemoteAdapterFromManifest({
      teamId,
      manifest: manifest('acme_crm'),
      secret: 'crm-token',
    });

    expect(result.credentialsId).not.toBeNull();

    const row = await getAutomationsQb(['remote_adapter'])
      .selectFrom('remote_adapter')
      .where('team_id', '=', teamId)
      .where('adapter_type', '=', 'acme_crm')
      .select(['credentials_id'])
      .executeTakeFirstOrThrow();
    expect(row.credentials_id as unknown as string).toBe(result.credentialsId);

    const cred = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', result.credentialsId as never)
      .select(['type', 'app_id'])
      .executeTakeFirstOrThrow();
    expect(cred.type).toBe(ExternalServiceType.REMOTE);
    expect(cred.app_id).toBe('acme_crm');
  });

  it('refuses a manifest for an older protocol before minting anything', async () => {
    await expect(
      installRemoteAdapterFromManifest({
        teamId,
        // @ts-expect-error a v1 manifest is exactly what the type now rules out
        manifest: { ...manifest('legacy_crm'), protocolVersion: 1 },
        secret: 'legacy-token',
      }),
    ).rejects.toThrow(/Remote adapter "legacy_crm" cannot be installed: protocolVersion: expected 2, got 1/);

    const rows = await getAutomationsQb(['remote_adapter'])
      .selectFrom('remote_adapter')
      .where('team_id', '=', teamId)
      .where('adapter_type', '=', 'legacy_crm')
      .select(['id'])
      .execute();
    expect(rows).toEqual([]);
    const creds = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('app_id', '=', 'legacy_crm')
      .select(['id'])
      .execute();
    expect(creds).toEqual([]);
  });

  it('without a secret: installs with a null credential FK (needs connecting)', async () => {
    const result = await installRemoteAdapterFromManifest({
      teamId,
      manifest: manifest('acme_crm'),
    });

    expect(result.credentialsId).toBeNull();
    const row = await getAutomationsQb(['remote_adapter'])
      .selectFrom('remote_adapter')
      .where('team_id', '=', teamId)
      .where('adapter_type', '=', 'acme_crm')
      .select(['credentials_id'])
      .executeTakeFirstOrThrow();
    expect(row.credentials_id).toBeNull();
  });
});
