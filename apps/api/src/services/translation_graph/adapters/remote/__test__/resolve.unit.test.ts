// Unit tests for the async adapter resolution seam (`adapters/resolve.ts`).
//
// Coverage:
//   - local slug → returns the static adapter, no DB hit
//   - remote slug + stored row + valid cred → RemoteAdapter, manifest-derived
//     adapterType, a minted cacheScopeId threaded into createRemoteAdapter
//   - unknown slug (not local, no row) → throws
//   - remote row with null credentials_id → throws the "no credential" error
//   - bad cred payload (not { secret }) → throws
//
// All boundaries are mocked: the registry (local-first), the store
// (remote_adapter row), the credential decrypt, the kysely qb (credential
// row fetch), and `createRemoteAdapter` (so no wire/fetch is exercised).

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';

// ── Mocks ────────────────────────────────────────────────────────────────

const mockHasAdapter = jest.fn<boolean, [string]>();
const mockGetAdapter = jest.fn();
const mockListAdapterTypes = jest.fn<string[], []>(() => ['kg', 'email']);
// A small alias table mirroring registry.KIND_TO_ADAPTER_SLUG for the kinds
// the slug-aliasing test exercises. `resolveAdapter` keys its remote lookup
// off the canonical slug, so the mock has to apply the same indirection.
const SLUG_ALIASES: Record<string, string> = {
  ATTIO: 'attio',
  ACME_CRM: 'acme_crm',
};
jest.mock('../../registry', () => ({
  hasAdapter: (slug: string) => mockHasAdapter(slug),
  getAdapter: (input: unknown) => mockGetAdapter(input),
  listAdapterTypes: () => mockListAdapterTypes(),
  resolveAdapterSlug: (adapterType: string) => SLUG_ALIASES[adapterType] ?? adapterType,
}));

const mockGetRemoteAdapter = jest.fn();
jest.mock('../store', () => ({
  getRemoteAdapter: (input: unknown) => mockGetRemoteAdapter(input),
  // Real rowToManifest: parse the row's `manifest` jsonb. The fixture rows
  // carry a well-formed manifest object, so the real zod parse exercises the
  // manifest-file → RemoteManifest bridge.
  rowToManifest: jest.requireActual('../store').rowToManifest,
}));

const mockDecryptToken = jest.fn<Promise<string>, [Buffer, string]>();
jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: (data: Buffer, ctx: string) => mockDecryptToken(data, ctx),
}));

const mockCredRow = jest.fn();
jest.mock('../../../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: () => ({
      where: () => ({
        where: () => ({
          select: () => ({
            executeTakeFirst: () => mockCredRow(),
          }),
        }),
      }),
    }),
  });
  return { getQb: qb, getCoreQb: qb, getAutomationsQb: qb };
});

const mockCreateRemoteAdapter = jest.fn();
jest.mock('movement-engine/services/translation_graph/adapters/remote', () => ({
  ...jest.requireActual('movement-engine/services/translation_graph/adapters/remote'),
  createRemoteAdapter: (input: unknown) => mockCreateRemoteAdapter(input),
}));

import { resolveAdapter } from '../../resolve';

const TEAM = 'team-1' as never;

function validManifest(adapterType: string) {
  return {
    protocolVersion: 2,
    adapterType,
    baseUrl: 'https://example.test/rpc',
    authStrategy: { kind: 'bearer' },
    credentialsId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: {
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    },
    methods: ['describe', 'listEntryPoints'],
  };
}

function remoteRow(adapterType: string, credentialsId: string | null) {
  return {
    id: 'row-1',
    team_id: TEAM,
    adapter_type: adapterType,
    base_url: 'https://example.test/rpc',
    auth_strategy: { kind: 'bearer' },
    credentials_id: credentialsId,
    manifest: validManifest(adapterType),
    created_at: new Date(),
    updated_at: new Date(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListAdapterTypes.mockReturnValue(['kg', 'email']);
});

describe('resolveAdapter — local first', () => {
  it('returns the static adapter for a local slug without touching the DB', async () => {
    const fakeLocal = { adapterType: 'email' } as unknown as Adapter;
    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue(fakeLocal);

    const adapter = await resolveAdapter({ adapterType: 'email', teamId: TEAM });

    expect(adapter).toBe(fakeLocal);
    expect(mockGetAdapter).toHaveBeenCalledWith({ adapterType: 'email', teamId: TEAM });
    expect(mockGetRemoteAdapter).not.toHaveBeenCalled();
    expect(mockDecryptToken).not.toHaveBeenCalled();
  });
});

describe('resolveAdapter — remote fallback', () => {
  it('constructs a RemoteAdapter from a stored row + valid credential', async () => {
    mockHasAdapter.mockReturnValue(false);
    mockGetRemoteAdapter.mockResolvedValue(remoteRow('acme_crm', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'));
    mockCredRow.mockResolvedValue({ id: 'cred-1', credentials: Buffer.from('enc'), app_id: 'acme_crm' });
    mockDecryptToken.mockResolvedValue(JSON.stringify({ secret: 'super-secret-token' }));

    const fakeRemote = { adapterType: 'acme_crm' } as unknown as Adapter;
    mockCreateRemoteAdapter.mockReturnValue(fakeRemote);

    const adapter = await resolveAdapter({ adapterType: 'acme_crm', teamId: TEAM });

    expect(adapter).toBe(fakeRemote);
    expect(mockCreateRemoteAdapter).toHaveBeenCalledTimes(1);
    const arg = mockCreateRemoteAdapter.mock.calls[0][0] as {
      config: { adapterType: string; baseUrl: string };
      secret: string;
      cacheScopeId: string;
      manifest: { adapterType: string };
    };
    expect(arg.manifest.adapterType).toBe('acme_crm');
    expect(arg.config.adapterType).toBe('acme_crm');
    expect(arg.secret).toBe('super-secret-token');
    // A cacheScopeId was minted (uuid v4 shape) and threaded through.
    expect(arg.cacheScopeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('resolves when the run names the install\'s own credential', async () => {
    const own = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    mockHasAdapter.mockReturnValue(false);
    mockGetRemoteAdapter.mockResolvedValue(remoteRow('acme_crm', own));
    mockCredRow.mockResolvedValue({ id: 'cred-1', credentials: Buffer.from('enc'), app_id: 'acme_crm' });
    mockDecryptToken.mockResolvedValue(JSON.stringify({ secret: 's' }));
    mockCreateRemoteAdapter.mockReturnValue({ adapterType: 'acme_crm' });

    await resolveAdapter({ adapterType: 'acme_crm', teamId: TEAM, credentialsId: own });

    expect(mockCreateRemoteAdapter).toHaveBeenCalledTimes(1);
  });

  it("sends the connection's provider credential, refreshed with the install's OAuth app", async () => {
    const own = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const alice = 'ffffffff-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const row = remoteRow('acme_crm', own);
    row.manifest = {
      ...row.manifest,
      credentials: [{ name: 'oauth', kind: 'oauth2', fields: [], oauth2: { authorizeUrl: 'https://p.test/a', tokenUrl: 'https://p.test/t' } }],
    } as never;
    mockHasAdapter.mockReturnValue(false);
    mockGetRemoteAdapter.mockResolvedValue(row);
    mockCredRow
      .mockResolvedValueOnce({ id: own, credentials: Buffer.from('enc'), app_id: 'acme_crm' })
      .mockResolvedValueOnce({ app_id: 'acme_crm', declared_credential: 'oauth' });
    mockDecryptToken.mockResolvedValue(JSON.stringify({ secret: 'server-secret', oauthClients: { oauth: { clientId: 'app', clientSecret: 'app-secret' } } }));
    mockCreateRemoteAdapter.mockReturnValue({ adapterType: 'acme_crm' });

    await resolveAdapter({ adapterType: 'acme_crm', teamId: TEAM, credentialsId: alice });

    const arg = mockCreateRemoteAdapter.mock.calls[0][0] as {
      secret: string;
      config: { credentialsId: string };
      credential: { name: string; ref: string; client: { clientId: string; clientSecret: string } };
    };
    expect(arg.secret).toBe('server-secret');
    expect(arg.config.credentialsId).toBe(alice);
    expect(arg.credential).toMatchObject({ name: 'oauth', ref: alice, client: { clientId: 'app', clientSecret: 'app-secret' } });
  });

  it("refuses a connection's credential that belongs to another module", async () => {
    const own = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    mockHasAdapter.mockReturnValue(false);
    mockGetRemoteAdapter.mockResolvedValue(remoteRow('acme_crm', own));
    mockCredRow
      .mockResolvedValueOnce({ id: own, credentials: Buffer.from('enc'), app_id: 'acme_crm' })
      .mockResolvedValueOnce({ app_id: 'hubspot', declared_credential: 'oauth' });
    mockDecryptToken.mockResolvedValue(JSON.stringify({ secret: 's' }));

    await expect(
      resolveAdapter({ adapterType: 'acme_crm', teamId: TEAM, credentialsId: 'ffffffff-e5f6-4a7b-8c9d-0e1f2a3b4c5d' }),
    ).rejects.toThrow(/is not a acme_crm credential; it is not sent/);
    expect(mockCreateRemoteAdapter).not.toHaveBeenCalled();
  });

  it('throws for an unknown slug with no remote install', async () => {
    mockHasAdapter.mockReturnValue(false);
    mockGetRemoteAdapter.mockResolvedValue(null);

    await expect(resolveAdapter({ adapterType: 'nope', teamId: TEAM })).rejects.toThrow(
      /Unknown adapter type: nope/,
    );
    expect(mockCreateRemoteAdapter).not.toHaveBeenCalled();
  });

  it('throws when the remote row has no credential configured', async () => {
    mockHasAdapter.mockReturnValue(false);
    mockGetRemoteAdapter.mockResolvedValue(remoteRow('acme_crm', null));

    await expect(resolveAdapter({ adapterType: 'acme_crm', teamId: TEAM })).rejects.toThrow(
      /no credential configured/,
    );
    expect(mockDecryptToken).not.toHaveBeenCalled();
  });

  it('throws when the decrypted credential payload is malformed', async () => {
    mockHasAdapter.mockReturnValue(false);
    mockGetRemoteAdapter.mockResolvedValue(remoteRow('acme_crm', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'));
    mockCredRow.mockResolvedValue({ id: 'cred-1', credentials: Buffer.from('enc'), app_id: 'acme_crm' });
    mockDecryptToken.mockResolvedValue(JSON.stringify({ nottheright: 'shape' }));

    await expect(resolveAdapter({ adapterType: 'acme_crm', teamId: TEAM })).rejects.toThrow(
      /payload is malformed/,
    );
    expect(mockCreateRemoteAdapter).not.toHaveBeenCalled();
  });

  it('throws when the credential app_id does not match the adapter (a secret minted for another adapter)', async () => {
    mockHasAdapter.mockReturnValue(false);
    mockGetRemoteAdapter.mockResolvedValue(remoteRow('acme_crm', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'));
    // The credential belongs to a DIFFERENT remote adapter.
    mockCredRow.mockResolvedValue({ id: 'cred-1', credentials: Buffer.from('enc'), app_id: 'other-crm' });

    await expect(resolveAdapter({ adapterType: 'acme_crm', teamId: TEAM })).rejects.toThrow(
      /does not belong to adapter/,
    );
    expect(mockDecryptToken).not.toHaveBeenCalled();
    expect(mockCreateRemoteAdapter).not.toHaveBeenCalled();
  });
});

describe('resolveAdapter — slug aliasing', () => {
  // The local-first `hasAdapter` check already aliases the kind (registry does
  // `resolveAdapterSlug` internally), so an uppercase kind resolves locally and
  // `getAdapter` receives the raw input verbatim (preserving prior behavior).
  it('resolves a kind-alias (ATTIO) to the local adapter', async () => {
    const fakeLocal = { adapterType: 'attio' } as unknown as Adapter;
    mockHasAdapter.mockReturnValue(true);
    mockGetAdapter.mockReturnValue(fakeLocal);

    const adapter = await resolveAdapter({ adapterType: 'ATTIO', teamId: TEAM });

    expect(adapter).toBe(fakeLocal);
    expect(mockHasAdapter).toHaveBeenCalledWith('ATTIO');
    expect(mockGetAdapter).toHaveBeenCalledWith({ adapterType: 'ATTIO', teamId: TEAM });
    expect(mockGetRemoteAdapter).not.toHaveBeenCalled();
  });

  // The porting-critical path: an input still carries the uppercase kind
  // (`ACME_CRM`) but the team's remote install is stored under the canonical
  // slug (`acme_crm`). The remote lookup must key off the slug — not the raw
  // type — so the existing input resolves without a bulk edit.
  it('resolves a kind-alias to a remote install keyed by the canonical slug', async () => {
    mockHasAdapter.mockReturnValue(false);
    mockGetRemoteAdapter.mockResolvedValue(
      remoteRow('acme_crm', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'),
    );
    mockCredRow.mockResolvedValue({ id: 'cred-1', credentials: Buffer.from('enc'), app_id: 'acme_crm' });
    mockDecryptToken.mockResolvedValue(JSON.stringify({ secret: 'super-secret-token' }));
    const fakeRemote = { adapterType: 'acme_crm' } as unknown as Adapter;
    mockCreateRemoteAdapter.mockReturnValue(fakeRemote);

    const adapter = await resolveAdapter({ adapterType: 'ACME_CRM', teamId: TEAM });

    expect(adapter).toBe(fakeRemote);
    // The remote store was queried with the canonical slug, not 'ACME_CRM'.
    expect(mockGetRemoteAdapter).toHaveBeenCalledWith({ teamId: TEAM, adapterType: 'acme_crm' });
  });

  it('mentions the slug in the unknown-adapter error', async () => {
    mockHasAdapter.mockReturnValue(false);
    mockGetRemoteAdapter.mockResolvedValue(null);

    await expect(resolveAdapter({ adapterType: 'ACME_CRM', teamId: TEAM })).rejects.toThrow(
      /Unknown adapter type: ACME_CRM \(slug: acme_crm\)/,
    );
  });
});
