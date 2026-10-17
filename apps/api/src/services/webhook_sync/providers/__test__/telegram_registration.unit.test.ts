// A team's own Telegram bot, registered and deregistered against the
// fake-channels Bot API: the platform sets the webhook with a fresh secret,
// Telegram delivers an update carrying that secret, and the module's declared
// inbound verification accepts it (and refuses a delivery without it).

jest.mock('../../../../lib/credentials', () => ({
  decryptToken: async () => JSON.stringify(storedCredential),
}));

jest.mock('../../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: () => {
      const api = {
        where: () => api,
        select: () => api,
        executeTakeFirstOrThrow: async () => ({ id: 'cred-telegram', credentials: 'enc' }),
      };
      return api;
    },
  });
  return { getQb: qb, getCoreQb: qb, getAutomationsQb: qb };
});

import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { verifyInbound } from 'movement-engine/public/inbound';

import { telegramProvider } from '../telegram';
import { builtinModuleInboundVerifier } from '../../../translation_graph/adapters/builtin_modules';
import { bootFakeChannels } from '../../../translation_graph/adapters/__test__/parity/fake_channels';

let storedCredential: Record<string, unknown> = {};

const TOKEN = 'TEAM-BOT-TOKEN';

jest.setTimeout(60_000);

describe('telegramProvider against the fake Bot API', () => {
  let fake: { baseUrl: string; stop(): void };
  let target: { url: string; deliveries: Array<{ headers: IncomingHttpHeaders; body: Buffer }>; close(): Promise<void> };

  beforeAll(async () => {
    fake = await bootFakeChannels({ file: 'telegram', factory: 'telegramRoutes', mount: '/telegram' });
    target = await webhookTarget();
  });
  afterAll(async () => {
    fake.stop();
    await target.close();
  });

  async function botApi(method: string, body: unknown = {}): Promise<{ ok: boolean; result?: unknown; status?: number }> {
    const answer = await fetch(`${fake.baseUrl}/${method.startsWith('admin/') ? method : `bot${TOKEN}/${method}`}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await answer.json()) as { ok: boolean; result?: unknown; status?: number };
  }

  it("registers the team's bot with a fresh secret that a delivery carries and the module accepts", async () => {
    storedCredential = { botToken: TOKEN, baseUrl: fake.baseUrl };
    const registration = await telegramProvider.registerSubscription({ credentialsId: 'cred-telegram', targetUrl: target.url, eventTypes: ['message'] });

    expect(registration.secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await botApi('getWebhookInfo')).result).toMatchObject({ url: target.url });

    const update = { update_id: 1, message: { message_id: 7, chat: { id: 42, type: 'private' }, date: 1, text: 'hello' } };
    expect(await botApi(`admin/bot${TOKEN}/deliver`, update)).toMatchObject({ ok: true, status: 200 });
    const delivery = target.deliveries.at(-1);
    if (delivery === undefined) throw new Error('nothing was delivered');
    expect(JSON.parse(delivery.body.toString('utf8'))).toEqual(update);

    const verifier = builtinModuleInboundVerifier('TELEGRAM');
    if (verifier === undefined) throw new Error('Telegram declares no inbound');
    const secret = registration.secret ?? '';
    expect(verifyInbound(verifier, { rawBody: delivery.body, headers: delivery.headers, secret })).toBe(true);
    const { 'x-telegram-bot-api-secret-token': _secret, ...unsigned } = delivery.headers;
    expect(verifyInbound(verifier, { rawBody: delivery.body, headers: unsigned, secret })).toBe(false);
  });

  it('registering again replaces the secret a delivery carries', async () => {
    storedCredential = { botToken: TOKEN, baseUrl: fake.baseUrl };
    const first = await telegramProvider.registerSubscription({ credentialsId: 'cred-telegram', targetUrl: target.url, eventTypes: ['message'] });
    const second = await telegramProvider.registerSubscription({ credentialsId: 'cred-telegram', targetUrl: target.url, eventTypes: ['message'] });
    expect(second.secret).not.toBe(first.secret);

    await botApi(`admin/bot${TOKEN}/deliver`, { update_id: 2 });
    const delivery = target.deliveries.at(-1);
    expect(delivery?.headers['x-telegram-bot-api-secret-token']).toBe(second.secret);
  });

  it('deregisters by deleting the webhook', async () => {
    storedCredential = { botToken: TOKEN, baseUrl: fake.baseUrl };
    await telegramProvider.registerSubscription({ credentialsId: 'cred-telegram', targetUrl: target.url, eventTypes: ['message'] });
    await telegramProvider.deregisterSubscription?.({ credentialsId: 'cred-telegram', externalId: '' });
    expect((await botApi('getWebhookInfo')).result).toMatchObject({ url: '' });
  });

  it("refuses the platform's shared bot, which has no webhook of its own", async () => {
    storedCredential = { botToken: '', baseUrl: fake.baseUrl };
    await expect(telegramProvider.registerSubscription({ credentialsId: 'cred-telegram', targetUrl: target.url, eventTypes: ['message'] })).rejects.toThrow(
      /shared bot/,
    );
  });
});

/** Where the webhook points: keeps every delivery and answers 200. */
async function webhookTarget(): Promise<{ url: string; deliveries: Array<{ headers: IncomingHttpHeaders; body: Buffer }>; close(): Promise<void> }> {
  const deliveries: Array<{ headers: IncomingHttpHeaders; body: Buffer }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      deliveries.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/webhooks/telegram`, deliveries, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
