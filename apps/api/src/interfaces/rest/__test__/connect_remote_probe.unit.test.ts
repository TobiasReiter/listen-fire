// The connect link supplying a remote adapter's secret asks the adapter server
// its protocol version first, exactly as an install with the secret does: a
// server answering anything but 2 is refused on the form, before the token is
// spent or a credential minted. The probe and the server are real; only the
// token store, the install row and the credential mint are doubles.

import http, { createServer, type Server } from 'node:http';

import express, { Router } from 'express';

import type { AddressInfo } from 'node:net';
import type { ConnectTokenLookup } from '../../../services/credentials/connect_link';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';

const lookupConnectToken = jest.fn<Promise<ConnectTokenLookup>, [string]>();
const consumeConnectToken = jest.fn<Promise<boolean>, [string]>();
const mintRemoteCredential = jest.fn();
const linkRemoteAdapterCredential = jest.fn();
const getRemoteAdapter = jest.fn();

jest.mock('../../../services/credentials/connect_link', () => ({
  lookupConnectToken: (t: string) => lookupConnectToken(t),
  consumeConnectToken: (id: string) => consumeConnectToken(id),
  startConnectOAuth: jest.fn(),
}));
jest.mock('../../../services/credentials/remote_credential', () => ({
  mintRemoteCredential: (input: unknown) => mintRemoteCredential(input),
}));
jest.mock('../../../services/translation_graph/adapters/remote/store', () => {
  const actual = jest.requireActual('../../../services/translation_graph/adapters/remote/store');
  return {
    ...actual,
    getRemoteAdapter: (input: unknown) => getRemoteAdapter(input),
    linkRemoteAdapterCredential: (input: unknown) => linkRemoteAdapterCredential(input),
  };
});

import { connectRouter } from '../connect';
import { startFakeCrmServer, type FakeCrmServer } from '../../../scripts/dev/fake_crm_adapter';

const SECRET = 'remote-secret';

let app: Server;
let baseUrl: string;
let v2: FakeCrmServer;
let v1: http.Server;
let v1Url: string;

beforeAll(async () => {
  const router = express();
  router.use(express.urlencoded({ extended: true }));
  router.use('/api/connect', connectRouter as Router);
  app = createServer(router);
  await new Promise<void>((resolve) => app.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  v2 = await startFakeCrmServer({ secret: SECRET });
  // Built for protocol 1: its manifest answer carries no protocolVersion.
  v1 = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        result: {
          adapterType: 'acme_crm',
          supportedTriggers: [],
          runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
          methods: ['describe'],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => v1.listen(0, '127.0.0.1', resolve));
  v1Url = `http://127.0.0.1:${(v1.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await v2.close();
  await new Promise<void>((resolve) => v1.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  lookupConnectToken.mockResolvedValue({
    ok: true,
    row: {
      id: 'tok-remote',
      teamId: 'team-1' as never,
      userId: 'user-1' as never,
      adapterSlug: 'acme_crm',
      credentialName: 'Acme CRM',
      serviceType: ExternalServiceType.REMOTE,
      connectKind: 'key-entry',
    },
  });
  consumeConnectToken.mockResolvedValue(true);
  mintRemoteCredential.mockResolvedValue({ credentialsId: 'cred-1' });
});

function installedAt(url: string) {
  getRemoteAdapter.mockResolvedValue({
    manifest: {
      protocolVersion: 2,
      adapterType: 'acme_crm',
      baseUrl: url,
      authStrategy: { kind: 'bearer' },
      supportedTriggers: [],
      runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
      methods: ['describe'],
    },
  });
}

function submit() {
  return fetch(`${baseUrl}/api/connect/abc`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: SECRET }),
  });
}

describe('POST /api/connect/:token (remote key-entry)', () => {
  it('refuses a server that answers an older protocol: form re-rendered, token kept, nothing minted', async () => {
    installedAt(v1Url);

    const res = await submit();

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('protocolVersion: expected 2, got nothing');
    expect(html).toContain(v1Url);
    expect(consumeConnectToken).not.toHaveBeenCalled();
    expect(mintRemoteCredential).not.toHaveBeenCalled();
    expect(linkRemoteAdapterCredential).not.toHaveBeenCalled();
  });

  it('links the secret when the server answers protocol 2', async () => {
    installedAt(v2.baseUrl);

    const res = await submit();

    expect(res.status).toBe(200);
    expect(consumeConnectToken).toHaveBeenCalledWith('tok-remote');
    expect(mintRemoteCredential).toHaveBeenCalledWith(expect.objectContaining({ adapterType: 'acme_crm', secret: SECRET }));
    expect(linkRemoteAdapterCredential).toHaveBeenCalledWith({
      teamId: 'team-1',
      adapterType: 'acme_crm',
      credentialsId: 'cred-1',
    });
  });
});
