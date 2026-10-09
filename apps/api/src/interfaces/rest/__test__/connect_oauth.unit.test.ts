// Connect-LINK OAuth confirm-page render tests. The page is generic across
// OAuth adapters; Slack additionally carries a "using it in private channels"
// guide block (a bot auto-joins public channels but must be invited to private
// ones). Asserts the Slack guidance renders, and does NOT bleed onto other
// OAuth adapters. Mirrors connect_handshake.unit.test.ts's harness.

import express from 'express';
import { Router } from 'express';

import type { ConnectTokenLookup } from '../../../services/credentials/connect_link';
import type { AddressInfo } from 'node:net';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';

const lookupConnectToken = jest.fn<Promise<ConnectTokenLookup>, [string]>();
const consumeConnectToken = jest.fn<Promise<boolean>, [string]>();
const startConnectOAuth = jest.fn();

jest.mock('../../../services/credentials/connect_link', () => ({
  lookupConnectToken: (t: string) => lookupConnectToken(t),
  consumeConnectToken: (id: string) => consumeConnectToken(id),
  startConnectOAuth: (...a: unknown[]) => startConnectOAuth(...a),
}));

jest.mock('../../../services/credentials/persist_credential', () => ({
  persistCredential: jest.fn(),
}));

import { connectRouter } from '../connect';

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

function oauthRow(adapterSlug: string, serviceType: ExternalServiceType): ConnectTokenLookup {
  return {
    ok: true,
    row: {
      id: `tok-${adapterSlug}`,
      teamId: 'team-1' as never,
      userId: 'user-1' as never,
      adapterSlug,
      credentialName: `${adapterSlug}_main`,
      serviceType,
      connectKind: 'oauth',
    },
  };
}

describe('GET /api/connect/:token (oauth confirm page)', () => {
  it('shows the private-channel guidance on the Slack connect screen (no side effects on load)', async () => {
    lookupConnectToken.mockResolvedValue(oauthRow('slack', ExternalServiceType.SLACK));
    const res = await fetch(`${baseUrl}/api/connect/abc`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Connect Slack');
    expect(html).toContain('Using it in private channels');
    // Auto-join is post-time + public-only; private needs a manual add.
    expect(html).toContain('joins a <strong>public</strong> channel automatically');
    expect(html).toContain('/invite');
    expect(html).toContain('Add apps');
    // Rendering the page never starts the provider OAuth.
    expect(startConnectOAuth).not.toHaveBeenCalled();
  });

  it('does not show the Slack guidance for other OAuth adapters', async () => {
    lookupConnectToken.mockResolvedValue(oauthRow('attio', ExternalServiceType.ATTIO));
    const res = await fetch(`${baseUrl}/api/connect/abc`, { redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Connect Attio');
    expect(html).not.toContain('Using it in private channels');
  });
});
