// Real-DB gate for one-step remote-adapter install: supplying the secret at
// install time mints the REMOTE credential (app_id bound to the slug) and sets
// the remote_adapter row's credentials_id in one operation. Installing without
// a secret leaves the FK null ("needs connecting").

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { getAutomationsQb, getCoreQb } from '../../../../../lib/kysely';
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import ExternalServiceType from '../../../../../generated/kysely/automations/ExternalServiceType';
import { startFakeCrmServer, type FakeCrmServer } from '../../../../../scripts/dev/fake_crm_adapter';
import { RemoteAdapterManifestInput } from '../manifest';

jest.mock('../../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

import { installRemoteAdapterFromManifest } from '../install';

let teamId: TeamId;
let v2Server: FakeCrmServer;
let v1Server: http.Server;
let v1BaseUrl: string;

/** A server built for protocol 1: its manifest carries no protocolVersion. */
async function startV1Server(): Promise<void> {
  v1Server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        result: {
          adapterType: 'legacy_crm',
          supportedTriggers: [],
          runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
          methods: ['describe'],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => v1Server.listen(0, '127.0.0.1', resolve));
  const { port } = v1Server.address() as AddressInfo;
  v1BaseUrl = `http://127.0.0.1:${port}/`;
}

const SECRET = 'crm-token';

// Claims no version: the server's answer is what install trusts.
const manifest = (adapterType: string, baseUrl: string) =>
  RemoteAdapterManifestInput.parse({
    adapterType,
    displayName: 'Acme CRM',
    baseUrl,
    authStrategy: { kind: 'bearer' },
    supportedTriggers: ['webhook'],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods: ['describe', 'createRecord'],
  });

beforeAll(async () => {
  v2Server = await startFakeCrmServer({ secret: SECRET });
  await startV1Server();
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
  await v2Server.close();
  await new Promise<void>((resolve) => v1Server.close(() => resolve()));
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

describe('installRemoteAdapterFromManifest', () => {
  it('with a secret: asks the server its version, mints a REMOTE credential (app_id = slug) and links it', async () => {
    const result = await installRemoteAdapterFromManifest({
      teamId,
      manifest: manifest('acme_crm', v2Server.baseUrl),
      secret: SECRET,
    });

    expect(result.credentialsId).not.toBeNull();

    const row = await getAutomationsQb(['remote_adapter'])
      .selectFrom('remote_adapter')
      .where('team_id', '=', teamId)
      .where('adapter_type', '=', 'acme_crm')
      .select(['credentials_id'])
      .executeTakeFirstOrThrow();
    expect(row.credentials_id as unknown as string).toBe(result.credentialsId);
    const stored = await getAutomationsQb(['remote_adapter'])
      .selectFrom('remote_adapter')
      .where('team_id', '=', teamId)
      .where('adapter_type', '=', 'acme_crm')
      .select(['manifest'])
      .executeTakeFirstOrThrow();
    expect(stored.manifest).toMatchObject({ protocolVersion: 2 });

    const cred = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', result.credentialsId as never)
      .select(['type', 'app_id'])
      .executeTakeFirstOrThrow();
    expect(cred.type).toBe(ExternalServiceType.REMOTE);
    expect(cred.app_id).toBe('acme_crm');
  });

  it('refuses a server that answers an older protocol, before minting anything, naming the field and the URL', async () => {
    await expect(
      installRemoteAdapterFromManifest({
        teamId,
        // The file's claim is not what decides.
        manifest: { ...manifest('legacy_crm', v1BaseUrl), protocolVersion: 2 },
        secret: 'legacy-token',
      }),
    ).rejects.toThrow(
      new RegExp(`Remote adapter "legacy_crm" at ${v1BaseUrl} refused: protocolVersion: expected 2, got nothing`),
    );

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

  it('without a secret: installs on the file\'s claim with a null credential FK (needs connecting)', async () => {
    const result = await installRemoteAdapterFromManifest({
      teamId,
      manifest: { ...manifest('acme_crm', 'https://crm.example/adapter'), protocolVersion: 2 },
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

describe('installRemoteAdapterFromManifest with no credential to ask with', () => {
  it('refuses a file that does not claim protocol 2', async () => {
    await expect(
      installRemoteAdapterFromManifest({ teamId, manifest: manifest('acme_crm', 'https://crm.example/adapter') }),
    ).rejects.toThrow(/cannot be installed without its secret: protocolVersion: expected 2, got nothing/);
  });
});
