// `lf connect <module>` and `lf credential add|update|delete|list` end to
// end: the real `lf` with its answers piped in, the example's external
// declaring its credential (OAuth 2 at a fake provider, or static), the
// secrets file read back after each command. The secrets file is never
// written by the test beyond its starting state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startFakeOAuthServer, type FakeOAuthServer } from 'movement-engine/public/secrets-testing';
import { EXAMPLE, lfCommand, served } from './example';
import { lf, ok } from './interactive';

const EVENT = 'events/company_created.json';
const CLIENT = { clientId: 'lf-app', clientSecret: 'lf-app-secret' };

type Declaration = Record<string, unknown>;

function oauthDeclaration(provider: FakeOAuthServer, fields: Declaration[] = []): Declaration[] {
  return [{ name: 'acme', kind: 'oauth2', fields, oauth2: { authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl, scopes: ['crm.read'], pkce: true } }];
}

const STATIC: Declaration[] = [
  { name: 'acme_key', kind: 'static', fields: [{ name: 'api_key', label: 'API key' }, { name: 'workspace', secret: false, optional: true }] },
];

/** The example, its external declaring `credentials`; `secrets` is the
 *  starting secrets file (none: no file). */
function project(credentials: Declaration[], secrets?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-credential-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !src.includes(`${EXAMPLE}/.lf`) });
  mkdirSync(join(dir, '.lf'), { recursive: true });
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const source = readFileSync(server, 'utf8');
  const methods = "    methods: Object.keys(METHODS).filter((m) => m !== 'manifest'),\n";
  assert.ok(source.includes(methods), 'the example external changed; update this test patch');
  writeFileSync(server, source.replace(methods, `${methods}    credentials: ${JSON.stringify(credentials)},\n`));
  if (secrets !== undefined) writeFileSync(join(dir, '.lf/secrets.yaml'), secrets);
  return dir;
}

/** A project with no secrets yet, and no movement that needs one. */
function freshProject(credentials: Declaration[]): string {
  const dir = project(credentials);
  rmSync(join(dir, 'movements/companies.mvt'));
  return dir;
}

function secretsFile(dir: string, file = join(dir, '.lf/secrets.yaml')): Record<string, Record<string, string>> {
  const parsed: unknown = parse(readFileSync(file, 'utf8')) ?? {};
  assert.ok(parsed !== null && typeof parsed === 'object');
  return Object.fromEntries(
    Object.entries(parsed).map(([name, entry]) => [name, Object.fromEntries(Object.entries(entry as object).map(([k, v]) => [k, String(v)]))]),
  );
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

const AUTHORIZE = /^\s+http:\/\/127\.0\.0\.1:\d+\/authorize\?/;

/** `lf connect acme_crm` on a fresh project: server secret, webhook secret
 *  (generated), the OAuth app, and the registered redirect port. */
async function connectAcme(dir: string, port = '0'): Promise<string> {
  return ok(lf(dir, ['connect', 'acme_crm'], { answers: ['dev-acme-token', '', CLIENT.clientId, CLIENT.clientSecret, port] }));
}

// ── lf connect <module> ─────────────────────────────────────────────────────

test('lf connect with no module lists the installed ones and whether they are set up', async () => {
  const provider = await startFakeOAuthServer(CLIENT);
  try {
    const dir = freshProject(oauthDeclaration(provider));
    const before = await ok(lf(dir, ['connect']));
    assert.match(before, /^acme_crm {2}installed \(command\); install not set up; credentials: none$/m);
    await connectAcme(dir);
    const after = await ok(lf(dir, ['connect']));
    assert.match(after, /^acme_crm {2}installed \(command\); install set up \(acme_crm\); credentials: none$/m);
  } finally {
    await provider.close();
  }
});

test('lf connect <module> writes its install — server secret, webhook secret, OAuth app — and no user credential', async () => {
  const provider = await startFakeOAuthServer(CLIENT);
  try {
    const dir = freshProject(oauthDeclaration(provider));
    const out = await connectAcme(dir, '8765');
    assert.match(out, /register these redirect URIs/);
    assert.match(out, /http:\/\/127\.0\.0\.1:8765\/callback/);
    assert.match(out, /lf credential add --module acme_crm/);
    const install = secretsFile(dir).acme_crm;
    assert.ok(install !== undefined);
    assert.equal(install.module, 'acme_crm');
    assert.equal(install.credential, undefined, 'an install binds no declared credential');
    assert.equal(install.token, 'dev-acme-token');
    assert.match(install.webhook_secret ?? '', /^[0-9a-f]{48}$/, 'generated');
    assert.equal(install.client_id, CLIENT.clientId);
    assert.equal(install.client_secret, CLIENT.clientSecret);
    assert.equal(install.redirect_port, '8765');
    assert.equal(install.access_token, undefined);
    assert.equal(provider.calls.length, 0);

    // Again: every answer kept by enter.
    await ok(lf(dir, ['connect', 'acme_crm'], { answers: ['', '', '', '', ''] }));
    assert.deepEqual(secretsFile(dir).acme_crm, install);
  } finally {
    await provider.close();
  }
});

test('lf connect installs a separately-run module at its server URL', async () => {
  const dir = freshProject(STATIC);
  const refused = await lf(dir, ['connect', '@acme/hubspot'], { answers: ['ftp://nope'] }).done;
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /server URL of the separately-run module/);
  assert.match(refused.out, /must be http\(s\)/);
  assert.equal(existsSync(join(dir, 'externals/hubspot')), false, 'nothing left behind');
  // Unreachable: the manifest cannot be read, and the install is undone.
  const unreachable = await lf(dir, ['connect', '@acme/hubspot', '--url', 'http://127.0.0.1:9/'], { answers: ['s3cret'] }).done;
  assert.equal(unreachable.code, 1, unreachable.out);
  assert.equal(existsSync(join(dir, 'externals/hubspot')), false);
});

// ── lf credential add (OAuth 2) ─────────────────────────────────────────────

test('lf credential add signs in through the loopback redirect and binds the credential to its module', async () => {
  const provider = await startFakeOAuthServer({ ...CLIENT, requirePkce: true });
  try {
    const dir = freshProject(oauthDeclaration(provider, [{ name: 'workspace', secret: false, optional: true }]));
    await connectAcme(dir);
    const adding = lf(dir, ['credential', 'add', '--module', 'acme_crm', 'alice_acme', '--no-browser'], { answers: ['north'] });
    const url = (await adding.line(AUTHORIZE)).trim();
    assert.equal(new URL(url).searchParams.get('scope'), 'crm.read');
    const page = await fetch(url);
    assert.equal(page.status, 200, await page.clone().text());
    assert.match(await page.text(), /Signed in for "alice_acme"/);
    const out = await ok(adding);
    assert.match(out, /added alice_acme \(acme_crm, credential acme\)/);
    assert.match(out, /connect acme_crm using alice_acme/);

    const { alice_acme: alice, acme_crm: install } = secretsFile(dir);
    assert.ok(alice !== undefined && install !== undefined);
    assert.equal(alice.module, 'acme_crm');
    assert.equal(alice.credential, 'acme');
    assert.equal(alice.workspace, 'north');
    assert.equal(alice.access_token, 'access-1');
    assert.equal(alice.refresh_token, provider.currentRefreshToken());
    assert.ok(!Number.isNaN(Date.parse(alice.expires_at ?? '')));
    assert.equal(alice.client_id, undefined, "the app is the install's, never copied");
    assert.equal(alice.client_secret, undefined);
    assert.equal(install.access_token, undefined, 'the install holds no user token');
    // The code exchange: the install's app, PKCE.
    assert.equal(provider.calls[0]?.grant, 'authorization_code');
    assert.match(provider.calls[0]?.authorization ?? '', /^Basic /);
    assert.ok((provider.calls[0]?.form.code_verifier ?? '').length > 0);

    const listed = await ok(lf(dir, ['credential', 'list']));
    assert.match(listed, /^acme_crm {2}acme_crm {2}install/m);
    assert.match(listed, /^alice_acme {2}acme_crm {2}credential acme .*token expires/m);
    assert.doesNotMatch(listed, /access-1|lf-app-secret/, 'no value is listed');

    const again = await lf(dir, ['credential', 'add', '--module', 'acme_crm', 'alice_acme', '--no-browser']).done;
    assert.equal(again.code, 1);
    assert.match(again.out, /already a credential "alice_acme"; change it with lf credential update/);
  } finally {
    await provider.close();
  }
});

test('lf credential add --headless takes the pasted redirect URL at the registered port', async () => {
  const provider = await startFakeOAuthServer(CLIENT);
  try {
    const dir = freshProject(oauthDeclaration(provider));
    await connectAcme(dir);
    const noPort = await lf(dir, ['credential', 'add', '--module', 'acme_crm', 'bob_acme', '--headless']).done;
    assert.equal(noPort.code, 1);
    assert.match(noPort.out, /--headless needs the redirect port your app registered/);

    const port = await freePort();
    const adding = lf(dir, ['credential', 'add', '--module', 'acme_crm', 'bob_acme', '--headless', '--redirect-port', String(port)]);
    const url = (await adding.line(AUTHORIZE)).trim();
    assert.equal(new URL(url).searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/callback`);
    // The browser on another machine: sent to a loopback page that will not load.
    const consent = await fetch(url, { redirect: 'manual' });
    const location = consent.headers.get('location');
    assert.ok(location !== null);
    await adding.line(/paste the URL your browser was sent back to/);
    adding.answer(location);
    await ok(adding);
    const bob = secretsFile(dir).bob_acme;
    assert.equal(bob?.access_token, 'access-1');
    assert.equal(bob?.credential, 'acme');
  } finally {
    await provider.close();
  }
});

test('lf credential add --public finishes through lf serve at publicUrl', async () => {
  const provider = await startFakeOAuthServer(CLIENT);
  try {
    const dir = freshProject(oauthDeclaration(provider));
    await connectAcme(dir);
    const serving = await served(dir);
    try {
      const publicUrl = `http://127.0.0.1:${serving.port}`;
      writeFileSync(join(dir, 'lf.yaml'), `${readFileSync(join(dir, 'lf.yaml'), 'utf8')}publicUrl: ${publicUrl}\n`);
      // Nobody waits for this state: lf serve writes nothing.
      const stray = await fetch(`${publicUrl}/oauth/callback?code=x&state=nobody`);
      assert.equal(stray.status, 404);

      const adding = lf(dir, ['credential', 'add', '--module', 'acme_crm', 'carol_acme', '--public']);
      const url = (await adding.line(AUTHORIZE)).trim();
      assert.equal(new URL(url).searchParams.get('redirect_uri'), `${publicUrl}/oauth/callback`);
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /lf has the sign-in/);
      await ok(adding);
      assert.equal(secretsFile(dir).carol_acme?.access_token, 'access-1');
    } finally {
      await serving.stop();
    }
  } finally {
    await provider.close();
  }
});

test('lf credential add refuses a module not installed, and an OAuth module with no app set up', async () => {
  const provider = await startFakeOAuthServer(CLIENT);
  try {
    const dir = freshProject(oauthDeclaration(provider));
    const missing = await lf(dir, ['credential', 'add', '--module', 'hubspot', 'x']).done;
    assert.equal(missing.code, 1);
    assert.match(missing.out, /module "hubspot" is not installed here; set it up first: lf connect hubspot/);
    // The install has only its server secret: no app at the provider.
    writeFileSync(join(dir, '.lf/secrets.yaml'), 'acme_crm:\n  module: acme_crm\n  token: dev-acme-token\n');
    const noApp = await lf(dir, ['credential', 'add', '--module', 'acme_crm', 'x', '--no-browser']).done;
    assert.equal(noApp.code, 1);
    assert.match(noApp.out, /module "acme_crm" has no OAuth app set up: lf connect acme_crm/);
    assert.equal(secretsFile(dir).x, undefined);
  } finally {
    await provider.close();
  }
});

test('a refused sign-in writes nothing', async () => {
  const provider = await startFakeOAuthServer(CLIENT);
  try {
    const dir = freshProject(oauthDeclaration(provider));
    await connectAcme(dir);
    const before = readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8');
    const adding = lf(dir, ['credential', 'add', '--module', 'acme_crm', 'dan_acme', '--no-browser']);
    const url = new URL((await adding.line(AUTHORIZE)).trim());
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
    assert.equal((await fetch(redirect)).status, 400);
    const failed = await adding.done;
    assert.equal(failed.code, 1, failed.out);
    assert.match(failed.out, /access_denied/);
    assert.equal(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'), before);
    assert.equal(provider.calls.length, 0);
  } finally {
    await provider.close();
  }
});

// ── An entry written by hand: read as before, its binding recorded on update ─

test('lf credential update re-authorises a hand-written entry, records its binding, and a run refreshes it', async () => {
  // The update's token lives a second: the run after it finds it about to
  // expire. The refreshed one lives an hour.
  const provider = await startFakeOAuthServer({ ...CLIENT, requirePkce: true, expiresIn: (issue) => (issue === 1 ? 1 : 3600) });
  try {
    const dir = project(
      oauthDeclaration(provider, [{ name: 'webhook_secret' }]),
      `# lf's app at the provider\nacme:\n  external: acme_crm\n  token: dev-acme-token\n  webhook_secret: w\n  client_id: ${CLIENT.clientId}\n  client_secret: ${CLIENT.clientSecret}\n`,
    );
    const listed = await ok(lf(dir, ['credential', 'list']));
    assert.match(listed, /^acme {2}acme_crm {2}written by hand/m);

    const updating = lf(dir, ['credential', 'update', 'acme', '--no-browser'], { answers: [''] });
    const page = await fetch((await updating.line(AUTHORIZE)).trim());
    assert.equal(page.status, 200, await page.clone().text());
    assert.match(await ok(updating), /updated acme \(acme_crm, credential acme\); its binding is now recorded/);

    const acme = secretsFile(dir).acme;
    assert.ok(acme !== undefined);
    assert.equal(acme.external, undefined);
    assert.equal(acme.module, 'acme_crm');
    assert.equal(acme.credential, 'acme');
    assert.equal(acme.access_token, 'access-1');
    // What the operator wrote is kept: the entry is still the install its
    // webhook URL names.
    assert.equal(acme.token, 'dev-acme-token');
    assert.equal(acme.webhook_secret, 'w');
    assert.equal(acme.client_secret, CLIENT.clientSecret);
    assert.match(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'), /^# lf's app at the provider/);

    const ran = await lf(dir, ['run', '--event', EVENT]).done;
    assert.equal(ran.code, 0, ran.out);
    assert.deepEqual(provider.calls.map((c) => c.grant), ['authorization_code', 'refresh_token'], 'one refresh');
    const afterRun = secretsFile(dir).acme;
    assert.equal(afterRun?.access_token, 'access-2');
    assert.equal(afterRun?.refresh_token, provider.currentRefreshToken());
    assert.equal(afterRun?.credential, 'acme', 'a refresh keeps the binding');
  } finally {
    await provider.close();
  }
});

// ── Static credentials, plain and SOPS ──────────────────────────────────────

/** A `sops` that keeps the plaintext at `<file>.plain`: `-d` prints it, `set`
 *  and `unset` change it the way sops does (a JSON path, a JSON value). */
function sopsStandIn(): string {
  const bin = mkdtempSync(join(tmpdir(), 'lf-sops-standin-'));
  writeFileSync(
    join(bin, 'sops'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const yaml = require(${JSON.stringify(require.resolve('yaml'))});
const [command, ...rest] = process.argv.slice(2);
if (command === '--version') { console.log('sops 3.9.0 (stand-in)'); process.exit(0); }
if (command === '-d') { process.stdout.write(fs.readFileSync(rest[0] + '.plain', 'utf8')); process.exit(0); }
const keysOf = (path) => [...path.matchAll(/\\[("(?:[^"\\\\]|\\\\.)*")\\]/g)].map((m) => JSON.parse(m[1]));
if (command === 'set' || command === 'unset') {
  const [file, path, value] = rest;
  const doc = yaml.parseDocument(fs.readFileSync(file + '.plain', 'utf8'));
  if (command === 'set') doc.setIn(keysOf(path), doc.createNode(JSON.parse(value)));
  else doc.deleteIn(keysOf(path));
  fs.writeFileSync(file + '.plain', doc.toString());
  fs.appendFileSync(file + '.calls', command + ' ' + path + '\\n');
  process.exit(0);
}
process.stderr.write('stand-in sops: unknown command ' + command + '\\n');
process.exit(2);
`,
  );
  chmodSync(join(bin, 'sops'), 0o755);
  return bin;
}

for (const store of ['plain', 'SOPS'] as const) {
  test(`static credential add, update, delete (${store} file)`, async () => {
    const dir = freshProject(STATIC);
    const file = join(dir, '.lf/secrets.yaml');
    const env: Record<string, string> = {};
    let read = () => secretsFile(dir);
    if (store === 'SOPS') {
      writeFileSync(file, 'sops:\n  version: 3.9.0\n');
      writeFileSync(`${file}.plain`, '{}\n');
      env.PATH = `${sopsStandIn()}:${process.env.PATH ?? ''}`;
      read = () => secretsFile(dir, `${file}.plain`);
    }
    const notSetUp = await lf(dir, ['credential', 'add', '--module', 'acme_crm', 'eve_acme'], { env }).done;
    assert.equal(notSetUp.code, 1);
    assert.match(notSetUp.out, /module "acme_crm" is not set up here \(its server secret\): lf connect acme_crm/);
    // A static module's install: its server and webhook secrets, no app.
    await ok(lf(dir, ['connect', 'acme_crm'], { answers: ['dev-acme-token', ''], env }));
    assert.equal(read().acme_crm?.client_id, undefined);
    await ok(lf(dir, ['credential', 'add', '--module', 'acme_crm', 'eve_acme'], { answers: ['k-1', 'west'], env }));
    assert.deepEqual(read().eve_acme, { module: 'acme_crm', credential: 'acme_key', api_key: 'k-1', workspace: 'west' });

    await ok(lf(dir, ['credential', 'update', 'eve_acme'], { answers: ['k-2', ''], env }));
    assert.deepEqual(read().eve_acme, { module: 'acme_crm', credential: 'acme_key', api_key: 'k-2', workspace: 'west' });

    await ok(lf(dir, ['credential', 'delete', 'eve_acme'], { env }));
    assert.equal(read().eve_acme, undefined);
    if (store === 'SOPS') {
      assert.equal(readFileSync(file, 'utf8'), 'sops:\n  version: 3.9.0\n', 'never decrypted onto disk');
      assert.match(readFileSync(`${file}.calls`, 'utf8'), /^set \["acme_crm"\]\nset \["eve_acme"\]\n.*\nunset \["eve_acme"\]\n$/s);
    }
    const gone = await lf(dir, ['credential', 'delete', 'eve_acme'], { env }).done;
    assert.equal(gone.code, 1);
    assert.match(gone.out, /there is no credential "eve_acme"/);
  });
}

test('lf credential refuses to write a credential from the environment, which is read-only', async () => {
  const dir = freshProject(STATIC);
  await ok(lf(dir, ['connect', 'acme_crm'], { answers: ['dev-acme-token', ''] }));
  const env = { LF_SECRET__ENVY__EXTERNAL: 'acme_crm', LF_SECRET__ENVY__API_KEY: 'from-env' };
  const listed = await ok(lf(dir, ['credential', 'list'], { env }));
  assert.match(listed, /^envy {2}acme_crm {2}written by hand .*\(environment\)$/m);
  for (const args of [['delete', 'envy'], ['update', 'envy']]) {
    const refused = await lf(dir, ['credential', ...args], { env, answers: ['x', ''] }).done;
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /"envy" has fields from the environment \(LF_SECRET__ENVY__…\), which lf cannot write/);
  }
  const taken = await lf(dir, ['credential', 'add', '--module', 'acme_crm', 'envy'], { env, answers: ['x', ''] }).done;
  assert.equal(taken.code, 1);
  assert.match(taken.out, /already a credential "envy"/);
});

test('lf connect of a core module with no settings (@lf/judge, @lf/local-files) writes no secrets entry', () => {
  const dir = project(STATIC, 'acme:\n  external: acme_crm\n  token: t\n');
  const before = readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8');
  for (const module of ['@lf/judge', '@lf/local-files']) {
    const [command, args] = lfCommand(['connect', module]);
    const run = spawnSync(command, args, { cwd: dir, encoding: 'utf8', input: '', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout, new RegExp(`connected ${module}: it has no settings to keep`));
  }
  assert.equal(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'), before);
});
