// Pins that the WhatsApp webhook sees the exact bytes Meta signed. Meta escapes
// `/` as `\/` and non-ASCII as `\uXXXX`, so a message carrying a link or an
// emoji does not survive parse → JSON.stringify; verifying the HMAC over the
// re-serialised body refused every real pitch (a deck link) with a 401.

import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import express from 'express';

import type { AddressInfo } from 'node:net';


import { jsonBodyParser } from '../body_parser';
import { whatsappProvider } from '../../../services/webhook_sync/providers/whatsapp';

const SECRET = 'test-app-secret';

// Written the way Meta writes it: escaped slashes and a \u-escaped emoji.
const META_BYTES =
  '{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":' +
  '{"messages":[{"from":"447700900000","id":"wamid.X","type":"text","text":' +
  '{"body":"Deck: https:\\/\\/docsend.com\\/view\\/abc \\ud83d\\ude80"}}]}}]}]}';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

describe('jsonBodyParser keeps the raw body for the WhatsApp webhook', () => {
  let server: Server;
  let base: string;
  let seen: { raw?: Buffer; body?: unknown }[];

  beforeAll(async () => {
    const app = express();
    app.use(jsonBodyParser);
    app.post(['/api/public/whatsapp/webhook', '/api/other'], (req, res) => {
      seen.push({ raw: (req as unknown as { rawBody?: Buffer }).rawBody, body: req.body });
      res.sendStatus(200);
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen = [];
  });

  it('verifies Meta’s signature over a body with links and emoji', async () => {
    await fetch(`${base}/api/public/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: META_BYTES,
    });

    const { raw, body } = seen[0]!;
    expect(raw?.toString('utf-8')).toBe(META_BYTES);
    expect(whatsappProvider.verifySignature(raw!, sign(META_BYTES), SECRET)).toBe(true);

    // The failure this replaces: the re-serialised body no longer matches.
    const reserialised = Buffer.from(JSON.stringify(body));
    expect(whatsappProvider.verifySignature(reserialised, sign(META_BYTES), SECRET)).toBe(false);
  });

  it('does not keep the raw body on other routes', async () => {
    await fetch(`${base}/api/other`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: META_BYTES,
    });
    expect(seen[0]!.raw).toBeUndefined();
  });
});
