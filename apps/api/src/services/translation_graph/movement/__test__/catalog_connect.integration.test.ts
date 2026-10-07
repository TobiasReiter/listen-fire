// Integration test for AZ-7: the catalog surfaces each adapter's connect
// method (oauth | key-entry | intrinsic | handshake | app-only) so an author
// never authors toward — then fails to connect — an unconnectable adapter.
// Exercised against the REAL adapter manifests + the REAL connectKindForType
// derivation that connectCredential itself applies, so the catalog can never
// disagree with what a connect attempt would actually do. Also pins that
// `triggerExpectation` (what a listener actually fires on) reaches the
// agent-facing view at DISCOVERY time — before any credential exists.

import { randomUUID } from 'node:crypto';
import { getCoreQb } from '../../../../lib/kysely';
import { cleanupTeam } from '../../../../test/harness/cleanup';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import { movementCatalogSnapshotForTeam, toAgentCatalogView } from '../catalog';
import { installRemoteAdapterFromManifest } from '../../adapters/remote/install';
import { RemoteAdapterManifestFile } from '../../adapters/remote/manifest';
import { services } from '../../../../adapters/registry';

jest.mock('../../../credentials/credential_lifecycle', () => ({
  credentialLifecycle: () => undefined,
}));

describe('catalog connect-method (real manifests)', () => {
  let teamId: TeamId;

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `cat-connect-${teamId.slice(0, 8)}` } as any)
      .execute();
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  // The catalog's connect method is the LIVE derivation: an OAuth type only
  // advertises 'oauth' when its `services.*` connector is actually wired (client
  // id/secret present) — so it can never advertise a link the mint would refuse.
  // Jest doesn't boot the real singletons, so stand up a stub Attio connector to
  // represent the prod condition where the OAuth client IS configured.
  const attioBefore = services.attio;
  beforeEach(() => {
    services.attio = {
      generateInstallUrl: async () => 'https://attio.test/install',
    } as unknown as typeof services.attio;
  });
  afterEach(() => {
    services.attio = attioBefore;
  });

  it('tags each adapter with the same connect method a connect attempt would take', async () => {
    const { snapshot } = await movementCatalogSnapshotForTeam(teamId);
    const adapters = snapshot.adapters;

    // handshake: the connect link hands the user into the system's own
    // linking flow (Telegram's bot Start step).
    expect(adapters.telegram?.connect).toBe('handshake');

    // oauth: a browser sign-in link.
    expect(adapters.attio?.connect).toBe('oauth');

    // key-entry: a paste-the-API-key form.
    expect(adapters.affinity?.connect).toBe('key-entry');
  });

  it('the agent-facing catalog view carries connect + triggerExpectation through (the surface the agent sees)', async () => {
    // Regression guard: the snapshot computes these, but the agent only
    // ever sees `toAgentCatalogView`'s curated projection — they must
    // survive that reshape (`connect` was dropped once, invisible to the
    // live agent). `triggerExpectation` must be here at DISCOVERY time so
    // the agent can answer "which messages does this capture?" before
    // anything is connected, not after via describeInstance.
    const { snapshot, notes } = await movementCatalogSnapshotForTeam(teamId);
    const view = toAgentCatalogView({ snapshot, notes });
    const adapters = view.adapters as Record<
      string,
      { connect?: string; requiresCredential: boolean; triggerExpectation?: string }
    >;
    expect(adapters.telegram?.connect).toBe('handshake');
    expect(adapters.attio?.connect).toBe('oauth');
    expect(adapters.affinity?.connect).toBe('key-entry');
    // requiresCredential still derived; the projection didn't lose it.
    expect(adapters.attio?.requiresCredential).toBe(true);
    // The visibility truth an author grounds trigger claims in — group
    // reply/@-mention semantics and the no-access-to-other-chats fact.
    expect(adapters.telegram?.triggerExpectation).toContain('@-mention');
    expect(adapters.telegram?.triggerExpectation).toContain('NO access');
  });

  it('surfaces a remote install as needs-secret until its secret is provisioned', async () => {
    const manifest = RemoteAdapterManifestFile.parse({
      protocolVersion: 2,
      adapterType: 'acme_crm',
      displayName: 'Acme CRM',
      baseUrl: 'https://crm.example/adapter',
      authStrategy: { kind: 'bearer' },
      supportedTriggers: [],
      runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
      methods: ['describe', 'createRecord'],
    });

    // Installed without a secret → the author sees it needs connecting, via a
    // key-entry link — and construction stays credential-free.
    await installRemoteAdapterFromManifest({ teamId, manifest });
    const needy = toAgentCatalogView(await movementCatalogSnapshotForTeam(teamId)).adapters as Record<
      string,
      { connect?: string; requiresCredential: boolean; remoteConnection?: string }
    >;
    expect(needy.acme_crm?.remoteConnection).toBe('needs-secret');
    expect(needy.acme_crm?.connect).toBe('key-entry');
    expect(needy.acme_crm?.requiresCredential).toBe(false);

    // Provision the secret (one-step) → now connected.
    await installRemoteAdapterFromManifest({ teamId, manifest, secret: 'crm-token' });
    const connected = toAgentCatalogView(await movementCatalogSnapshotForTeam(teamId)).adapters as Record<
      string,
      { remoteConnection?: string }
    >;
    expect(connected.acme_crm?.remoteConnection).toBe('connected');
  });
});
