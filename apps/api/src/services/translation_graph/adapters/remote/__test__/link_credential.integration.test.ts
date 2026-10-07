// Real-DB gate for the connect-link write-back: linkRemoteAdapterCredential
// attaches a freshly-minted credential to an already-installed remote adapter
// (the out-of-band half of the "install, then connect the secret" flow).

import { randomUUID } from 'node:crypto';

import { getAutomationsQb, getCoreQb } from '../../../../../lib/kysely';
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import { RemoteAdapterManifestFile } from '../manifest';
import { installRemoteAdapterFromManifest } from '../install';
import { linkRemoteAdapterCredential, getRemoteAdapter } from '../store';

jest.mock('../../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

let teamId: TeamId;

const manifest = RemoteAdapterManifestFile.parse({
  protocolVersion: 2,
  adapterType: 'acme_crm',
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
    .values({ id: teamId, name: `remote-link-${teamId.slice(0, 8)}` } as any)
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

describe('linkRemoteAdapterCredential', () => {
  it('sets the install credentials_id for a previously credential-less install', async () => {
    // Install without a secret → null FK ("needs connecting").
    await installRemoteAdapterFromManifest({ teamId, manifest });
    const before = await getRemoteAdapter({ teamId, adapterType: 'acme_crm' });
    expect(before?.credentials_id).toBeNull();

    // A credential id minted out-of-band (any uuid; the FK is ON DELETE SET NULL,
    // so no referential insert is required for this write-back gate).
    const credId = randomUUID();
    await getAutomationsQb(['external_service_credentials'])
      .insertInto('external_service_credentials')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: credId, team_id: teamId, name: 'Acme CRM', type: 'REMOTE', credentials: Buffer.from('x') } as any)
      .execute();

    await linkRemoteAdapterCredential({ teamId, adapterType: 'acme_crm', credentialsId: credId });

    const after = await getRemoteAdapter({ teamId, adapterType: 'acme_crm' });
    expect(after?.credentials_id as unknown as string).toBe(credId);
  });
});
