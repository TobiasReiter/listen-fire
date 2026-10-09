// Connect-LINK intrinsic route tests. Exercises the confirm-page render and the
// POST provision (mint → persist) + token consume + replay 410 — by driving the
// route's handlers through a mounted express router with the DB-backed
// connect_link, persist_credential, and intrinsic_provision modules mocked.
// Mirrors connect_key_entry.unit.test.ts (the key-entry sibling).

import express from 'express';
import { Router } from 'express';

import type { ConnectTokenLookup } from '../../../services/credentials/connect_link';
import type { AddressInfo } from 'node:net';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';

// ── Mocks ───────────────────────────────────────────────────────────────────
const lookupConnectToken = jest.fn<Promise<ConnectTokenLookup>, [string]>();
const consumeConnectToken = jest.fn<Promise<boolean>, [string]>();
const startConnectOAuth = jest.fn();
const persistCredential = jest.fn<Promise<string>, [unknown]>();
const provision = jest.fn<Promise<{ credentials: unknown }>, [unknown]>();

jest.mock('../../../services/credentials/connect_link', () => ({
  lookupConnectToken: (t: string) => lookupConnectToken(t),
  consumeConnectToken: (id: string) => consumeConnectToken(id),
  startConnectOAuth: (...a: unknown[]) => startConnectOAuth(...a),
}));

jest.mock('../../../services/credentials/persist_credential', () => ({
  persistCredential: (input: unknown) => persistCredential(input),
}));

jest.mock('../../../services/credentials/intrinsic_provision', () => ({
  intrinsicProvisionerForType: () => ({ provision: (a: unknown) => provision(a) }),
}));

// connectRouter imports these; keep them real (pure) — the manifest lookup.
import { connectRouter } from '../connect';

// ── Tiny in-process HTTP harness (no supertest dep) ─────────────────────────
import { createServer, type Server } from 'node:http';


let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/connect', connectRouter as Router);
  server = createServer(app);
  server.listen(0, () => {
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
});

const valuationsRow: ConnectTokenLookup = {
  ok: true,
  row: {
    id: 'tok-id-v',
    teamId: 'team-1' as never,
    userId: 'user-1' as never,
    adapterSlug: 'native-valuations',
    credentialName: 'Listen-Fire Valuations',
    serviceType: ExternalServiceType.NATIVE_VALUATIONS,
    connectKind: 'intrinsic',
  },
};

describe('GET /api/connect/:token (intrinsic)', () => {
  it('renders a confirm page (no key form, no provision on load)', async () => {
    lookupConnectToken.mockResolvedValue(valuationsRow);
    const res = await fetch(`${baseUrl}/api/connect/abc`, { redirect: 'manual' });
    expect(res.status).toBe(200); // a page, not a 3xx redirect
    const html = await res.text();
    expect(html).toContain('Connect Listen-Fire Valuations');
    expect(html).toContain('method="post"');
    expect(html).toContain('<button');
    expect(html).not.toContain('type="password"'); // no key to paste
    // Nothing provisioned on load — only on the explicit POST.
    expect(provision).not.toHaveBeenCalled();
    expect(startConnectOAuth).not.toHaveBeenCalled();
  });
});

describe('POST /api/connect/:token (intrinsic provision)', () => {
  it('consumes the token, provisions, and persists (replaceExisting)', async () => {
    lookupConnectToken.mockResolvedValue(valuationsRow);
    consumeConnectToken.mockResolvedValue(true);
    provision.mockResolvedValue({ credentials: { apiKey: 'mk-secret', apiKeyId: 'key-1' } });
    persistCredential.mockResolvedValue('new-id');

    const res = await fetch(`${baseUrl}/api/connect/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Listen-Fire Valuations is connected');

    // Consume BEFORE provision (single-use; a replay can't double-mint).
    expect(consumeConnectToken).toHaveBeenCalledWith('tok-id-v');
    // The token's user is threaded into provision (the mint owner) — the
    // tokenless route has no auth-context user, so this MUST come from the token.
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1', userId: 'user-1', credentialName: 'Listen-Fire Valuations' }),
    );
    expect(persistCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'team-1',
        name: 'Listen-Fire Valuations',
        type: ExternalServiceType.NATIVE_VALUATIONS,
        credentials: { apiKey: 'mk-secret', apiKeyId: 'key-1' },
        replaceExisting: true,
      }),
    );
  });

  it('returns 410 on replay (token already consumed) without provisioning', async () => {
    lookupConnectToken.mockResolvedValue(valuationsRow);
    consumeConnectToken.mockResolvedValue(false); // someone already consumed it

    const res = await fetch(`${baseUrl}/api/connect/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
    });

    expect(res.status).toBe(410);
    expect(provision).not.toHaveBeenCalled();
    expect(persistCredential).not.toHaveBeenCalled();
  });
});
