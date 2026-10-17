import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { EntityStore } from '../../store';
import { oauthRoutes } from '../oauth';
import { dropboxRoutes } from '../dropbox';

async function bootApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-')), 'fake-channels.db');
  const store = new EntityStore(dbPath);
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/oauth', oauthRoutes(store));
  app.use('/dropbox', dropboxRoutes(store));
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function form(params: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  };
}

async function post(baseUrl: string, route: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function signIn(baseUrl: string): Promise<Record<string, string>> {
  const consent = await fetch(
    `${baseUrl}/oauth/authorize?redirect_uri=${encodeURIComponent('http://app.test/cb')}&state=s1&client_id=c`,
    { redirect: 'manual' },
  );
  const back = new URL(consent.headers.get('location') ?? '');
  assert.equal(back.searchParams.get('state'), 's1');
  const res = await fetch(`${baseUrl}/oauth/token`, form({ grant_type: 'authorization_code', code: back.searchParams.get('code') ?? '' }));
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, string>;
}

test('oauth: the code is single use and the refresh token rotates', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const first = await signIn(baseUrl);
    assert.ok(first.access_token && first.refresh_token);

    const refreshed = await fetch(`${baseUrl}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: first.refresh_token }));
    const second = (await refreshed.json()) as Record<string, string>;
    assert.equal(refreshed.status, 200);
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.notEqual(second.access_token, first.access_token);

    const replay = await fetch(`${baseUrl}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: first.refresh_token }));
    assert.equal(replay.status, 400);
    assert.equal(((await replay.json()) as { error: string }).error, 'invalid_grant');
  } finally {
    await close();
  }
});

test('oauth: expiring a token makes the protected endpoint and the dropbox fake refuse it', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const tokens = await signIn(baseUrl);
    const auth = { authorization: `Bearer ${tokens.access_token}` };
    assert.equal((await fetch(`${baseUrl}/oauth/protected`, { headers: auth })).status, 200);

    await post(baseUrl, '/oauth/control/expire', { accessToken: tokens.access_token });
    assert.equal((await fetch(`${baseUrl}/oauth/protected`, { headers: auth })).status, 401);
    const list = await fetch(`${baseUrl}/dropbox/2/files/list_folder`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '' }),
    });
    assert.equal(list.status, 401);

    const stranger = await fetch(`${baseUrl}/dropbox/2/files/list_folder`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-issued-here', 'content-type': 'application/json' },
      body: JSON.stringify({ path: '' }),
    });
    assert.equal(stranger.status, 200);
  } finally {
    await close();
  }
});

test('oauth: injected failures fail the next N token calls, and every call is logged', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const tokens = await signIn(baseUrl);
    await post(baseUrl, '/oauth/control/config', { failNext: 1, failWith: 'server_error' });
    const failed = await fetch(`${baseUrl}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }));
    assert.equal(failed.status, 500);
    // The injected failure did not spend the refresh token.
    const ok = await fetch(`${baseUrl}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }));
    assert.equal(ok.status, 200);

    const state = (await (await fetch(`${baseUrl}/oauth/control/state`)).json()) as { calls: { grant: string; outcome: string }[] };
    assert.deepEqual(
      state.calls.map((c) => `${c.grant}:${c.outcome}`),
      ['authorization_code:ok', 'refresh_token:injected_server_error', 'refresh_token:ok'],
    );
  } finally {
    await close();
  }
});

test('oauth: a non-rotating provider keeps the refresh token and omits it from the answer', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const tokens = await signIn(baseUrl);
    await post(baseUrl, '/oauth/control/config', { rotate: false, expiresIn: 60 });
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${baseUrl}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }));
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200);
      assert.equal(body.refresh_token, undefined);
      assert.equal(body.expires_in, 60);
    }
  } finally {
    await close();
  }
});
