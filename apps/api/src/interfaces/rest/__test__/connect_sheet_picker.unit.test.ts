// Connect-LINK item-picker route tests: the page render, the grant leg
// (consume → grant per pick), replay 410, and the bare-POST reject. Mirrors
// connect_handshake.unit.test.ts. The Picker widget itself is Google's
// browser-side code — the server contract under test is what its PICKED
// callback drives.

import express from 'express';
import { Router } from 'express';

import type { ConnectTokenLookup } from '../../../services/credentials/connect_link';
import type { AddressInfo } from 'node:net';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';

const lookupConnectToken = jest.fn<Promise<ConnectTokenLookup>, [string]>();
const consumeConnectToken = jest.fn<Promise<boolean>, [string]>();
const startConnectOAuth = jest.fn();
const grantItem = jest.fn<Promise<void>, [unknown]>();

jest.mock('../../../services/credentials/connect_link', () => ({
  lookupConnectToken: (t: string) => lookupConnectToken(t),
  consumeConnectToken: (id: string) => consumeConnectToken(id),
  startConnectOAuth: (...a: unknown[]) => startConnectOAuth(...a),
}));

jest.mock('../../../services/credentials/persist_credential', () => ({
  persistCredential: jest.fn(),
}));

jest.mock('../../../services/credentials/granted_items', () => ({
  grantItem: (input: unknown) => grantItem(input),
}));

jest.mock('../../../services/credentials/picker_spec', () => ({
  pickerActionKindForAdapter: (slug: string) =>
    slug === 'google_sheets' ? 'google-sheets-picker' : null,
  pickerSpecForActionKind: () => ({
    title: 'Choose a spreadsheet',
    blurb: 'Listen-Fire can only see the spreadsheets you explicitly choose — picking one here grants access to that file and nothing else in your Drive.',
    mimeTypes: ['application/vnd.google-apps.spreadsheet'],
    allowFolders: false,
  }),
}));

import { connectRouter } from '../connect';

import { createServer, type Server } from 'node:http';


let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/connect', connectRouter as Router);
  server = createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

beforeEach(() => jest.clearAllMocks());

const pickerRow: ConnectTokenLookup = {
  ok: true,
  row: {
    id: 'tok-id-p',
    teamId: 'team-1' as never,
    userId: 'user-1' as never,
    adapterSlug: 'google_sheets',
    credentialName: 'Dev Loop Google',
    credentialsId: 'cred-9',
    serviceType: ExternalServiceType.GOOGLE,
    connectKind: 'item-picker',
  },
};

describe('GET /api/connect/:token (item-picker)', () => {
  it('renders the picker page (no grant on load)', async () => {
    lookupConnectToken.mockResolvedValue(pickerRow);
    const res = await fetch(`${baseUrl}/api/connect/abc`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Choose a spreadsheet');
    expect(html).toContain('picker-token'); // the just-in-time token fetch
    expect(html).toContain('nothing else in your Drive'); // scope reassurance
    expect(grantItem).not.toHaveBeenCalled();
  });
});

describe('POST /api/connect/:token/grant', () => {
  it('consumes the token then grants each picked item', async () => {
    lookupConnectToken.mockResolvedValue(pickerRow);
    consumeConnectToken.mockResolvedValue(true);
    const res = await fetch(`${baseUrl}/api/connect/abc/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { id: 'ss-1', mimeType: 'application/vnd.google-apps.spreadsheet', name: 'LP Commitments' },
          { id: 'ss-2', mimeType: 'application/vnd.google-apps.spreadsheet' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ granted: 2 });
    expect(consumeConnectToken).toHaveBeenCalledWith('tok-id-p');
    expect(grantItem).toHaveBeenCalledWith({
      credentialsId: 'cred-9',
      itemId: 'ss-1',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      name: 'LP Commitments',
    });
    expect(grantItem).toHaveBeenCalledWith({
      credentialsId: 'cred-9',
      itemId: 'ss-2',
      mimeType: 'application/vnd.google-apps.spreadsheet',
    });
  });

  it('410s a consumed link without granting', async () => {
    lookupConnectToken.mockResolvedValue({ ok: false, reason: 'consumed' });
    const res = await fetch(`${baseUrl}/api/connect/abc/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 'x', mimeType: 'application/vnd.google-apps.spreadsheet' }] }),
    });
    expect(res.status).toBe(410);
    expect(grantItem).not.toHaveBeenCalled();
  });

  it('rejects an empty pick list before consuming', async () => {
    lookupConnectToken.mockResolvedValue(pickerRow);
    const res = await fetch(`${baseUrl}/api/connect/abc/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.status).toBe(400);
    expect(consumeConnectToken).not.toHaveBeenCalled();
  });
});

describe('POST /api/connect/:token (bare, item-picker)', () => {
  it('rejects — the flow writes only via /picker-token and /grant', async () => {
    lookupConnectToken.mockResolvedValue(pickerRow);
    const res = await fetch(`${baseUrl}/api/connect/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
    });
    expect(res.status).toBe(400);
    expect(consumeConnectToken).not.toHaveBeenCalled();
  });
});
