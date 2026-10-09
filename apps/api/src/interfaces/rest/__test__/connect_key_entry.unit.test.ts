// Connect-LINK key-entry route tests. Exercises the landing form render, the
// POST persist + token consume, replay 410, and reconnect-replace — by driving
// the route's handlers through a mounted express router with the DB-backed
// connect_link + persist_credential modules mocked.

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

jest.mock('../../../services/credentials/connect_link', () => ({
  lookupConnectToken: (t: string) => lookupConnectToken(t),
  consumeConnectToken: (id: string) => consumeConnectToken(id),
  startConnectOAuth: (...a: unknown[]) => startConnectOAuth(...a),
}));

jest.mock('../../../services/credentials/persist_credential', () => ({
  persistCredential: (input: unknown) => persistCredential(input),
}));

// connectRouter imports these; keep them real (pure) — the form spec + manifest.
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

const granolaRow: ConnectTokenLookup = {
  ok: true,
  row: {
    id: 'tok-id-1',
    teamId: 'team-1' as never,
    userId: 'user-1' as never,
    adapterSlug: 'granola',
    credentialName: 'Granola',
    serviceType: ExternalServiceType.GRANOLA,
    connectKind: 'key-entry',
  },
};

const attioRow: ConnectTokenLookup = {
  ok: true,
  row: {
    id: 'tok-id-2',
    teamId: 'team-1' as never,
    userId: 'user-1' as never,
    adapterSlug: 'attio',
    credentialName: 'Attio',
    serviceType: ExternalServiceType.ATTIO,
    connectKind: 'oauth',
  },
};

describe('GET /api/connect/:token (oauth)', () => {
  it('renders a confirm page with a Connect button and does NOT auto-redirect', async () => {
    lookupConnectToken.mockResolvedValue(attioRow);
    const res = await fetch(`${baseUrl}/api/connect/abc`, { redirect: 'manual' });
    expect(res.status).toBe(200); // a page, not a 3xx redirect
    const html = await res.text();
    expect(html).toContain('Connect Attio');
    expect(html).toContain('method="post"');
    expect(html).toContain('<button');
    // No OAuth was started on load — only on the explicit POST.
    expect(startConnectOAuth).not.toHaveBeenCalled();
  });
});

describe('POST /api/connect/:token (oauth start)', () => {
  it('starts the provider OAuth and redirects, without consuming the token', async () => {
    lookupConnectToken.mockResolvedValue(attioRow);
    startConnectOAuth.mockResolvedValue('https://provider.example/authorize?state=xyz');

    const res = await fetch(`${baseUrl}/api/connect/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
      redirect: 'manual',
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://provider.example/authorize?state=xyz');
    expect(startConnectOAuth).toHaveBeenCalledWith(ExternalServiceType.ATTIO);
    // The token is consumed on the /complete leg, not here.
    expect(consumeConnectToken).not.toHaveBeenCalled();
    expect(persistCredential).not.toHaveBeenCalled();
  });
});

describe('GET /api/connect/:token (key-entry)', () => {
  it('renders a form with the Granola apiKey field', async () => {
    lookupConnectToken.mockResolvedValue(granolaRow);
    const res = await fetch(`${baseUrl}/api/connect/abc`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Connect Granola');
    expect(html).toContain('name="apiKey"');
    expect(html).toContain('type="password"'); // apiKey is a secret
    expect(html).toContain('method="post"');
    // No OAuth was started.
    expect(startConnectOAuth).not.toHaveBeenCalled();
  });
});

describe('POST /api/connect/:token (key-entry submit)', () => {
  it('persists the key (replaceExisting) and consumes the token', async () => {
    lookupConnectToken.mockResolvedValue(granolaRow);
    consumeConnectToken.mockResolvedValue(true);
    persistCredential.mockResolvedValue('new-id');

    const res = await fetch(`${baseUrl}/api/connect/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiKey: 'gr-secret' }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Granola is connected');

    expect(consumeConnectToken).toHaveBeenCalledWith('tok-id-1');
    expect(persistCredential).toHaveBeenCalledTimes(1);
    expect(persistCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: 'team-1',
        name: 'Granola',
        type: ExternalServiceType.GRANOLA,
        credentials: { apiKey: 'gr-secret' },
        replaceExisting: true,
      }),
    );
  });

  it('re-renders the form (no consume) when the key is missing', async () => {
    lookupConnectToken.mockResolvedValue(granolaRow);

    const res = await fetch(`${baseUrl}/api/connect/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiKey: '' }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('name="apiKey"'); // form re-rendered
    expect(consumeConnectToken).not.toHaveBeenCalled();
    expect(persistCredential).not.toHaveBeenCalled();
  });

  it('returns 410 on replay (token already consumed)', async () => {
    lookupConnectToken.mockResolvedValue(granolaRow);
    consumeConnectToken.mockResolvedValue(false); // someone already consumed it

    const res = await fetch(`${baseUrl}/api/connect/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiKey: 'gr-secret' }),
    });

    expect(res.status).toBe(410);
    expect(persistCredential).not.toHaveBeenCalled();
  });

  it('returns 410 when the token lookup says consumed/expired', async () => {
    lookupConnectToken.mockResolvedValue({ ok: false, reason: 'consumed' });

    const res = await fetch(`${baseUrl}/api/connect/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiKey: 'gr-secret' }),
    });

    expect(res.status).toBe(410);
    expect(consumeConnectToken).not.toHaveBeenCalled();
  });
});
