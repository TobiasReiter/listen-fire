// GET /api/public/config — which sign-in providers this deployment offers.
//
// The login page is the one page with no session, and it draws a Google or a
// Microsoft button only for a client id that exists. Those ids used to be
// inlined into the web bundle at build time, so a published image carried the
// release build's (none) and no operator could configure them back. They are
// answered here instead, from the SAME variables the API validates tokens
// against — so a button can never offer a provider the API would refuse.

import { AddressInfo } from 'node:net';

import express from 'express';

import type { Server } from 'node:http';

import { publicConfigFrom } from '../public_config';
import { preAuthRouter } from '../capabilities';
import { LISTEN_FIRE_VERSION } from '../../../constants';

describe('publicConfigFrom', () => {
  it('offers both providers when both client ids are set', () => {
    expect(
      publicConfigFrom({
        GOOGLE_AUTH_CLIENT_ID: 'google-client-id',
        MICROSOFT_CLIENT_ID: 'microsoft-client-id',
      }),
    ).toEqual({
      googleClientId: 'google-client-id',
      microsoftClientId: 'microsoft-client-id',
      version: LISTEN_FIRE_VERSION,
    });
  });

  it('offers only the provider that is configured', () => {
    expect(publicConfigFrom({ GOOGLE_AUTH_CLIENT_ID: 'google-client-id' })).toEqual({
      googleClientId: 'google-client-id',
      version: LISTEN_FIRE_VERSION,
    });
  });

  // Absent, not empty: the page tests for presence, and an empty string would
  // draw a button whose OAuth request the provider then rejects.
  it('names no provider at all when neither is configured', () => {
    expect(publicConfigFrom({})).toEqual({ version: LISTEN_FIRE_VERSION });
  });

  it('treats a variable set to nothing as not configured', () => {
    expect(publicConfigFrom({ GOOGLE_AUTH_CLIENT_ID: '', MICROSOFT_CLIENT_ID: '' })).toEqual({
      version: LISTEN_FIRE_VERSION,
    });
  });

  // The client id is public — it rides in the URL of every consent screen. The
  // secret beside it is not, and must never be served from an open route.
  it('never carries the client secret', () => {
    const config = publicConfigFrom({
      GOOGLE_AUTH_CLIENT_ID: 'google-client-id',
      GOOGLE_AUTH_CLIENT_SECRET: 'do-not-serve-me',
    });

    expect(JSON.stringify(config)).not.toContain('do-not-serve-me');
    expect(Object.keys(config).sort()).toEqual(['googleClientId', 'version']);
  });
});

describe('the route', () => {
  let server: Server;
  let base: string;
  const ORIGINAL = {
    GOOGLE_AUTH_CLIENT_ID: process.env.GOOGLE_AUTH_CLIENT_ID,
    MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
  };

  beforeAll(async () => {
    const app = express();
    app.use('/api/public', preAuthRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [name, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // It has to be reachable with no credential of any kind: it is what the
  // login page asks before anybody has one.
  it('answers an unauthenticated caller', async () => {
    process.env.GOOGLE_AUTH_CLIENT_ID = 'google-client-id';
    delete process.env.MICROSOFT_CLIENT_ID;

    const res = await fetch(`${base}/api/public/config`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      googleClientId: 'google-client-id',
      version: LISTEN_FIRE_VERSION,
    });
  });

  it('stops offering a provider whose id is removed', async () => {
    delete process.env.GOOGLE_AUTH_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_ID;

    await expect((await fetch(`${base}/api/public/config`)).json()).resolves.toEqual({
      version: LISTEN_FIRE_VERSION,
    });
  });
});
