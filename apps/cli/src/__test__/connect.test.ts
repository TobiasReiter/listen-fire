// `lf connect <credential>` end to end against a fake OAuth provider: the
// external declares an `oauth2` credential, lf prints the authorize URL, the
// "browser" (a fetch that follows the provider's redirect to lf's loopback
// listener) consents, lf exchanges the code and writes the tokens to the
// secrets file. A run after it uses the connected credential, refreshing it
// from the same declaration and writing the rotated token back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startFakeOAuthServer, type FakeOAuthServer } from 'movement-engine/public/secrets-testing';
import { EXAMPLE, lfCommand } from './example';

const EVENT = 'events/company_created.json';
const CLIENT = { clientId: 'lf-app', clientSecret: 'lf-app-secret' };

/** The example, its external declaring `acme` as an oauth2 credential at the
 *  fake provider; the secrets name the external and lf's app there. */
function project(provider: FakeOAuthServer): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-connect-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !src.includes(`${EXAMPLE}/.lf`) });
  mkdirSync(join(dir, '.lf'), { recursive: true });
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const source = readFileSync(server, 'utf8');
  const methods = "    methods: Object.keys(METHODS).filter((m) => m !== 'manifest'),\n";
  assert.ok(source.includes(methods), 'the example external changed; update this test patch');
  const declaration = JSON.stringify([
    {
      name: 'acme',
      kind: 'oauth2',
      fields: [{ name: 'webhook_secret' }],
      oauth2: { authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl, scopes: ['crm.read'], pkce: true },
    },
  ]);
  writeFileSync(server, source.replace(methods, `${methods}    credentials: ${declaration},\n`));
  writeFileSync(
    join(dir, '.lf/secrets.yaml'),
    `# lf's app at the provider\nacme:\n  external: acme_crm\n  token: dev-acme-token\n  webhook_secret: w\n  client_id: ${CLIENT.clientId}\n  client_secret: ${CLIENT.clientSecret}\n`,
  );
  return dir;
}

interface Running {
  /** Resolves with the first output line matching. */
  line(pattern: RegExp): Promise<string>;
  done: Promise<{ code: number; out: string }>;
}

function lf(dir: string, args: string[]): Running {
  const child = spawn(...lfCommand(args), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let out = '';
  const waiters: { pattern: RegExp; resolve: (line: string) => void }[] = [];
  const scan = () => {
    for (const waiter of [...waiters]) {
      const found = out.split('\n').find((l) => waiter.pattern.test(l));
      if (found !== undefined) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(found);
      }
    }
  };
  child.stdout.on('data', (c) => ((out += c), scan()));
  child.stderr.on('data', (c) => ((out += c), scan()));
  const done = new Promise<{ code: number; out: string }>((resolve) => child.on('close', (code) => resolve({ code: code ?? -1, out })));
  return {
    line: (pattern) =>
      new Promise((resolve, reject) => {
        waiters.push({ pattern, resolve });
        scan();
        void done.then(({ out: all }) => reject(new Error(`lf exited before printing ${pattern}:\n${all}`)));
      }),
    done,
  };
}

function secrets(dir: string): Record<string, string> {
  const parsed: unknown = parse(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'));
  assert.ok(parsed !== null && typeof parsed === 'object' && 'acme' in parsed);
  const acme: unknown = parsed.acme;
  assert.ok(acme !== null && typeof acme === 'object');
  return Object.fromEntries(Object.entries(acme).map(([k, v]) => [k, String(v)]));
}

test('lf connect signs in at the declared provider, writes the tokens to the secrets file, and a run refreshes them', async () => {
  // The connect's token lives a second: the run after it finds it about to
  // expire. The refreshed one lives an hour.
  const provider = await startFakeOAuthServer({ ...CLIENT, requirePkce: true, expiresIn: (issue) => (issue === 1 ? 1 : 3600) });
  try {
    const dir = project(provider);
    const connecting = lf(dir, ['connect', 'acme', '--no-browser']);
    const url = (await connecting.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/authorize\?/)).trim();
    assert.equal(new URL(url).searchParams.get('scope'), 'crm.read');
    const page = await fetch(url);
    assert.equal(page.status, 200, await page.clone().text());
    assert.match(await page.text(), /Connected "acme"/);
    const connected = await connecting.done;
    assert.equal(connected.code, 0, connected.out);
    assert.match(connected.out, /connected acme \(acme_crm\)/);

    const afterConnect = secrets(dir);
    assert.equal(afterConnect.access_token, 'access-1');
    assert.equal(afterConnect.refresh_token, provider.currentRefreshToken());
    assert.ok(!Number.isNaN(Date.parse(afterConnect.expires_at ?? '')));
    // What the operator wrote is kept.
    assert.equal(afterConnect.client_secret, CLIENT.clientSecret);
    assert.equal(afterConnect.token, 'dev-acme-token');
    assert.equal(afterConnect.external, 'acme_crm');
    assert.match(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'), /^# lf's app at the provider/);
    // The code exchange: PKCE verifier sent, client in a Basic header.
    assert.equal(provider.calls[0]?.grant, 'authorization_code');
    assert.ok((provider.calls[0]?.form.code_verifier ?? '').length > 0);
    assert.match(provider.calls[0]?.authorization ?? '', /^Basic /);

    const run = lf(dir, ['run', '--event', EVENT]);
    const ran = await run.done;
    assert.equal(ran.code, 0, ran.out);
    assert.deepEqual(provider.calls.map((c) => c.grant), ['authorization_code', 'refresh_token'], 'one refresh');
    const afterRun = secrets(dir);
    assert.equal(afterRun.access_token, 'access-2');
    assert.equal(afterRun.refresh_token, provider.currentRefreshToken());
    assert.notEqual(afterRun.refresh_token, afterConnect.refresh_token);
  } finally {
    await provider.close();
  }
});

test('lf connect fails, naming the provider answer, when the sign-in is refused, and writes nothing', async () => {
  const provider = await startFakeOAuthServer(CLIENT);
  try {
    const dir = project(provider);
    const before = readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8');
    const connecting = lf(dir, ['connect', 'acme', '--no-browser']);
    const url = new URL((await connecting.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/authorize\?/)).trim());
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
    const page = await fetch(redirect);
    assert.equal(page.status, 400);
    const failed = await connecting.done;
    assert.equal(failed.code, 1, failed.out);
    assert.match(failed.out, /access_denied/);
    assert.equal(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'), before);
    assert.equal(provider.calls.length, 0);
  } finally {
    await provider.close();
  }
});

test('lf connect refuses a credential the secrets do not name, saying what to add', async () => {
  const provider = await startFakeOAuthServer(CLIENT);
  try {
    const dir = project(provider);
    const missing = await lf(dir, ['connect', 'other', '--no-browser']).done;
    assert.equal(missing.code, 1);
    assert.match(missing.out, /credential "other" is not in the secrets/);
    assert.match(missing.out, /client_id:/);
  } finally {
    await provider.close();
  }
});
