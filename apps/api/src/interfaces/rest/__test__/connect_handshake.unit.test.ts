// Connect-LINK handshake (Telegram) route tests. Exercises the confirm-page
// render and the POST leg (consume token → ensure team credential → mint
// deep-link token → redirect into Telegram) + replay 410 + unconfigured-bot
// 503 — by driving the route's handlers through a mounted express router with
// the DB-backed connect_link and telegram handshake modules mocked. Mirrors
// connect_intrinsic.unit.test.ts (the intrinsic sibling).

import express from 'express';
import { Router } from 'express';

import type { ConnectTokenLookup } from '../../../services/credentials/connect_link';
import type { AddressInfo } from 'node:net';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';

// ── Mocks ───────────────────────────────────────────────────────────────────
const lookupConnectToken = jest.fn<Promise<ConnectTokenLookup>, [string]>();
const consumeConnectToken = jest.fn<Promise<boolean>, [string]>();
const startConnectOAuth = jest.fn();
const persistCredential = jest.fn();
const builtInBotUsername = jest.fn<string | null, []>();
const ensureSharedTelegramTeamCredential = jest.fn<
  Promise<{ id: string; name: string; created: boolean }>,
  [unknown]
>();
const mintTelegramToken = jest.fn<
  Promise<{ token: string; expiresAt: Date }>,
  [unknown]
>();

jest.mock('../../../services/credentials/connect_link', () => ({
  lookupConnectToken: (t: string) => lookupConnectToken(t),
  consumeConnectToken: (id: string) => consumeConnectToken(id),
  startConnectOAuth: (...a: unknown[]) => startConnectOAuth(...a),
}));

jest.mock('../../../services/credentials/persist_credential', () => ({
  persistCredential: (input: unknown) => persistCredential(input),
}));

jest.mock('../../../services/translation_graph/adapters/telegram/handshake', () => ({
  builtInBotUsername: () => builtInBotUsername(),
  ensureSharedTelegramTeamCredential: (input: unknown) =>
    ensureSharedTelegramTeamCredential(input),
  mintTelegramToken: (input: unknown) => mintTelegramToken(input),
  telegramStartUrl: (input: { botUsername: string; token: string }) =>
    `https://t.me/${input.botUsername}?start=${input.token}`,
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
  builtInBotUsername.mockReturnValue('ListenFireBot');
});

// credentialName is whatever mintConnectLink promised the agent (their
// requested name, an existing credential's name, or the default) — the route
// must thread it into the ensure so the promise is kept on creation.
const telegramRow: ConnectTokenLookup = {
  ok: true,
  row: {
    id: 'tok-id-t',
    teamId: 'team-1' as never,
    userId: 'user-1' as never,
    adapterSlug: 'telegram',
    credentialName: 'telegram_main',
    serviceType: ExternalServiceType.TELEGRAM,
    connectKind: 'handshake',
  },
};

describe('GET /api/connect/:token (handshake)', () => {
  it('renders a confirm page walking through the Telegram Start step (no side effects on load)', async () => {
    lookupConnectToken.mockResolvedValue(telegramRow);
    const res = await fetch(`${baseUrl}/api/connect/abc`, { redirect: 'manual' });
    expect(res.status).toBe(200); // a page, not a 3xx redirect
    const html = await res.text();
    expect(html).toContain('Connect Telegram');
    expect(html).toContain('method="post"');
    expect(html).toContain('Start'); // the one extra step no other kind has
    // The scope panel answers "is this reading all my Telegram?" and the
    // tenancy question at the moment the user forms that mental model.
    expect(html).toContain('What the bot can see');
    expect(html).toContain('cannot read your Telegram');
    expect(html).toContain('only to your own workspace');
    expect(html).not.toContain('type="password"'); // no key to paste
    // Nothing connected on load — only on the explicit POST.
    expect(ensureSharedTelegramTeamCredential).not.toHaveBeenCalled();
    expect(mintTelegramToken).not.toHaveBeenCalled();
    expect(startConnectOAuth).not.toHaveBeenCalled();
  });
});

describe('POST /api/connect/:token (handshake start)', () => {
  it('consumes the token, ensures the team credential, mints the deep-link token, and redirects into Telegram', async () => {
    lookupConnectToken.mockResolvedValue(telegramRow);
    consumeConnectToken.mockResolvedValue(true);
    ensureSharedTelegramTeamCredential.mockResolvedValue({
      id: 'cred-1',
      name: 'telegram_main',
      created: true,
    });
    mintTelegramToken.mockResolvedValue({ token: 'start-tok', expiresAt: new Date() });

    const res = await fetch(`${baseUrl}/api/connect/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
      redirect: 'manual',
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://t.me/ListenFireBot?start=start-tok');

    // Consume BEFORE the side effects (single-use; a replay can't double-run).
    expect(consumeConnectToken).toHaveBeenCalledWith('tok-id-t');
    // The token's user/team AND the promised credential name are threaded into
    // the ensure — the tokenless route has no auth-context user, and the name
    // the agent was promised at mint time must be the one created here.
    expect(ensureSharedTelegramTeamCredential).toHaveBeenCalledWith({
      teamId: 'team-1',
      userId: 'user-1',
      name: 'telegram_main',
    });
    expect(mintTelegramToken).toHaveBeenCalledWith({
      nativeUserId: 'user-1',
      teamId: 'team-1',
    });
    // Handshake persists no secret — the credential is the empty shared-bot row.
    expect(persistCredential).not.toHaveBeenCalled();
  });

  it('returns 410 on replay (token already consumed) without connecting anything', async () => {
    lookupConnectToken.mockResolvedValue(telegramRow);
    consumeConnectToken.mockResolvedValue(false); // someone already consumed it

    const res = await fetch(`${baseUrl}/api/connect/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
      redirect: 'manual',
    });

    expect(res.status).toBe(410);
    expect(ensureSharedTelegramTeamCredential).not.toHaveBeenCalled();
    expect(mintTelegramToken).not.toHaveBeenCalled();
  });

  it('returns 503 without consuming when the shared bot is not configured', async () => {
    lookupConnectToken.mockResolvedValue(telegramRow);
    builtInBotUsername.mockReturnValue(null);

    const res = await fetch(`${baseUrl}/api/connect/abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}),
      redirect: 'manual',
    });

    expect(res.status).toBe(503);
    expect(consumeConnectToken).not.toHaveBeenCalled();
    expect(ensureSharedTelegramTeamCredential).not.toHaveBeenCalled();
  });
});
