// Secrets (OAuth refresh written back, SOPS, environment mapping, missing
// credentials), the acting user from lf.yaml, and reading a stored file's text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localIdentity } from '../host';
import type { FileRef } from 'engine-contracts';
import { redeemFileRef } from 'movement-engine/services/translation_graph/engine/files/redeem';
import { localDocumentStore } from '../documents';
import { localFileText } from '../files';
import { loadProject, initProject } from '../project';
import { loadSecrets, refreshCredential, type Credential } from '../secrets';

const LF = resolve(__dirname, '../../bin/lf.cjs');
const EXAMPLE = resolve(__dirname, '../../../../examples/lf-acme');
const EVENT = 'events/company_created.json';

/** A copy of the example whose external logs the Authorization header of each
 *  call, and (via `rejectStale`) answers `unauthorized` to a stale token on calls past startup. */
function project(options: { secrets?: string | null; rejectStale?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-secrets-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !src.includes(`${EXAMPLE}/.lf`) });
  mkdirSync(join(dir, '.lf'), { recursive: true });
  const manifest = join(dir, 'externals/acme_crm/lf-external.yaml');
  writeFileSync(
    manifest,
    readFileSync(manifest, 'utf8')
      .replace('field: token', 'field: access_token')
      .replace('env:\n', 'env:\n  AUTH_LOG: "{lf}/auth.log"\n'),
  );
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const check = "if (!/^Bearer \\S+/.test(req.headers.authorization ?? '')) {";
  const source = readFileSync(server, 'utf8');
  assert.ok(source.includes(check), 'the example external changed; update this test patch');
  const startup = "['manifest', 'listEntryPoints', 'describe', 'listEventTypes']";
  const stale = options.rejectStale
    ? `|| (req.headers.authorization === 'Bearer stale-token' && !${startup}.includes(JSON.parse(body || '{}').method))`
    : '';
  writeFileSync(
    server,
    source.replace(
      check,
      `(await import('node:fs')).appendFileSync(process.env.AUTH_LOG, (req.headers.authorization ?? '') + '\\n');\n    if (!/^Bearer \\S+/.test(req.headers.authorization ?? '') ${stale}) {`,
    ),
  );
  const secrets = options.secrets === undefined ? credentialYaml() : options.secrets;
  if (secrets !== null) writeFileSync(join(dir, '.lf/secrets.yaml'), secrets);
  return dir;
}

function credentialYaml(extra = ''): string {
  return `# keep this comment\nacme:\n  external: acme_crm\n  access_token: stale-token\n  webhook_secret: w\n${extra}`;
}

function lf(dir: string, args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [LF, ...args], { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1', ...env } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => done({ code: code ?? -1, out }));
  });
}

/** An OAuth token endpoint that records the form it was posted. */
async function tokenServer(answer: object): Promise<{ url: string; forms: URLSearchParams[]; close(): void }> {
  const forms: URLSearchParams[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      forms.push(new URLSearchParams(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}/token`, forms, close: () => server.close() };
}

const authLog = (dir: string): string[] => readFileSync(join(dir, '.lf/auth.log'), 'utf8').trim().split('\n');

test('an expiring token is refreshed before the call and written back to the plain file, comments kept', async () => {
  const token = await tokenServer({ access_token: 'fresh-token', expires_in: 3600, refresh_token: 'r2' });
  try {
    const dir = project({
      secrets: credentialYaml(`  refresh_token: r1\n  client_id: cid\n  token_url: ${'URL'}\n  expires_at: 2000-01-01T00:00:00Z\n`).replace('URL', token.url),
    });
    const run = await lf(dir, ['run', '--event', EVENT]);
    assert.equal(run.code, 0, run.out);
    assert.equal(token.forms.length, 1);
    assert.equal(token.forms[0]?.get('grant_type'), 'refresh_token');
    assert.equal(token.forms[0]?.get('refresh_token'), 'r1');
    assert.equal(token.forms[0]?.get('client_id'), 'cid');
    const file = readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8');
    assert.match(file, /# keep this comment/);
    assert.match(file, /access_token: fresh-token/);
    assert.match(file, /refresh_token: r2/);
    assert.doesNotMatch(file, /2000-01-01/);
    assert.equal(authLog(dir).at(-1), 'Bearer fresh-token');
  } finally {
    token.close();
  }
});

test('a call answered unauthorized refreshes once and is retried with the new token', async () => {
  const token = await tokenServer({ access_token: 'fresh-token' });
  try {
    const dir = project({
      rejectStale: true,
      secrets: credentialYaml(`  refresh_token: r1\n  token_url: URL\n`).replace('URL', token.url),
    });
    const run = await lf(dir, ['run', '--event', EVENT]);
    assert.equal(run.code, 0, run.out);
    assert.equal(token.forms.length, 1);
    assert.match(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'), /access_token: fresh-token/);
    assert.equal(authLog(dir).at(-1), 'Bearer fresh-token');
  } finally {
    token.close();
  }
});

test('a SOPS file is read with sops -d and the refresh goes back through sops set', async () => {
  const token = await tokenServer({ access_token: 'fresh-token', expires_in: 60 });
  try {
    const bin = mkdtempSync(join(tmpdir(), 'lf-sops-'));
    const plain = join(bin, 'plain.yaml');
    const calls = join(bin, 'calls.log');
    writeFileSync(plain, credentialYaml(`  refresh_token: r1\n  token_url: ${token.url}\n  expires_at: 2000-01-01T00:00:00Z\n`));
    writeFileSync(join(bin, 'sops'), `#!/bin/sh\nif [ "$1" = "-d" ]; then cat "${plain}"; else echo "$@" >> "${calls}"; fi\n`);
    chmodSync(join(bin, 'sops'), 0o755);
    const dir = project({ secrets: 'acme:\n  external: acme_crm\nsops:\n  version: 3.9.0\n' });
    const run = await lf(dir, ['run', '--event', EVENT], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(run.code, 0, run.out);
    const log = readFileSync(calls, 'utf8');
    assert.match(log, /set .*secrets\.yaml \["acme"\]\["access_token"\] "fresh-token"/);
    assert.match(log, /\["acme"\]\["expires_at"\]/);
    assert.match(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8'), /sops:/);
  } finally {
    token.close();
  }
});

test('with sops unavailable, an encrypted credential is refused before the refresh token is spent', async () => {
  const token = await tokenServer({ access_token: 'fresh-token' });
  const savedPath = process.env.PATH;
  try {
    const credential: Credential = {
      name: 'acme',
      external: 'acme_crm',
      fields: { refresh_token: 'r1', token_url: token.url },
      origin: { file: { path: '/secrets/lf.yaml', encrypted: true }, envFields: new Set() },
    };
    process.env.PATH = mkdtempSync(join(tmpdir(), 'lf-nopath-'));
    await assert.rejects(refreshCredential(credential), /credential "acme".*\/secrets\/lf\.yaml.*sops/);
    assert.equal(token.forms.length, 0);
  } finally {
    process.env.PATH = savedPath;
    token.close();
  }
});

test('a field from the environment is refreshed for this process only, with one warning', async () => {
  const token = await tokenServer({ access_token: 'fresh-token' });
  try {
    const dir = project({ secrets: null });
    const env = { LF_SECRET__ACME__EXTERNAL: 'acme_crm', LF_SECRET__ACME__ACCESS_TOKEN: 'stale-token', LF_SECRET__ACME__REFRESH_TOKEN: 'r1', LF_SECRET__ACME__TOKEN_URL: token.url, LF_SECRET__ACME__EXPIRES_AT: '2000-01-01T00:00:00Z' };
    const run = await lf(dir, ['run', '--event', EVENT], env);
    assert.equal(run.code, 0, run.out);
    assert.equal(run.out.match(/cannot be written back/g)?.length, 1, run.out);
    assert.equal(authLog(dir).at(-1), 'Bearer fresh-token');
    assert.ok(!existsSync(join(dir, '.lf/secrets.yaml')));
  } finally {
    token.close();
  }
});

test('a credential can be made wholly from LF_SECRET__ variables, and they override the file', async () => {
  const fromEnv = project({ secrets: null });
  const env = { LF_SECRET__ACME__EXTERNAL: 'acme_crm', LF_SECRET__ACME__ACCESS_TOKEN: 'env-token' };
  const made = await lf(fromEnv, ['run', '--event', EVENT], env);
  assert.equal(made.code, 0, made.out);
  assert.equal(authLog(fromEnv).at(-1), 'Bearer env-token');

  const overridden = project();
  const won = await lf(overridden, ['run', '--event', EVENT], { LF_SECRET__ACME__ACCESS_TOKEN: 'env-wins' });
  assert.equal(won.code, 0, won.out);
  assert.equal(authLog(overridden).at(-1), 'Bearer env-wins');
  assert.match(readFileSync(join(overridden, '.lf/secrets.yaml'), 'utf8'), /stale-token/);
});

test('LF_SECRETS_FILE names the secrets file; a missing one is an error', async () => {
  const dir = project({ secrets: null });
  const file = join(dir, 'mounted.yaml');
  writeFileSync(file, credentialYaml());
  assert.equal((await lf(dir, ['run', '--event', EVENT], { LF_SECRETS_FILE: file })).code, 0);
  const missing = await lf(dir, ['run', '--event', EVENT], { LF_SECRETS_FILE: join(dir, 'nope.yaml') });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /LF_SECRETS_FILE .*nope\.yaml.* does not exist/);
});

test('a credential the program imports but nothing configures is named, with the file and where it was looked for', async () => {
  const dir = project({ secrets: null });
  const home = mkdtempSync(join(tmpdir(), 'lf-home-'));
  const run = await lf(dir, ['run', '--event', EVENT], { HOME: home });
  assert.equal(run.code, 1);
  assert.match(run.out, /credential "acme"/);
  assert.match(run.out, /companies\.mvt:2/);
  assert.match(run.out, /\.lf\/secrets\.yaml/);
  assert.match(run.out, /LF_SECRET__ACME__EXTERNAL/);

  const check = await lf(dir, ['check'], { HOME: home });
  assert.equal(check.code, 1);
  assert.match(check.out, /companies\.mvt:2:\d+ error MISSING_CREDENTIAL credential "acme"/);
});

test('the acting user is lf.yaml\'s, overridden by LF_USER / LF_USER_EMAIL, else the OS user', () => {
  const configured = { name: 'Ada', email: 'ada@example.com' };
  assert.deepEqual(localIdentity(configured, {}), { principal: { id: 'local:Ada', display: 'Ada' }, email: 'ada@example.com' });
  assert.deepEqual(localIdentity(configured, { LF_USER: 'bob', LF_USER_EMAIL: 'bob@x.io' }), {
    principal: { id: 'local:bob', display: 'bob' },
    email: 'bob@x.io',
  });
  assert.match(localIdentity({}, {}).email ?? '', /@localhost$/);

  const dir = project();
  writeFileSync(join(dir, 'lf.yaml'), `${readFileSync(join(dir, 'lf.yaml'), 'utf8')}user: { name: Ada, email: ada@example.com }\n`);
  assert.deepEqual(loadProject(dir).user, configured);
});

test('lf init writes the user field commented, and the file still loads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lf-init-'));
  initProject(dir);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), /# user: \{ name:/);
  assert.deepEqual(loadProject(dir).user, {});
});

test('READ of a FILE() artifact reads the stored text through resolveFileText', async () => {
  const dir = project();
  const movements = join(dir, 'movements/companies.mvt');
  writeFileSync(
    movements,
    readFileSync(movements, 'utf8').replace('Name: "Welcome ${company.Name}"', 'Name: coalesce(File.read(File.from("hello ${company.Name}", "text")), "unreadable")'),
  );
  const run = await lf(dir, ['run', '--event', EVENT]);
  assert.equal(run.code, 0, run.out);
  const state = readFileSync(join(dir, '.lf/externals/acme_crm/state.json'), 'utf8');
  assert.match(state, /"Name": "hello Vireo Robotics"/);
});

test('resolveFileText: text and json are read; a real PDF, a handle out of the folder, an external\'s file and a missing file are not', async () => {
  const dir = project();
  const documents = localDocumentStore(join(dir, '.lf'));
  const read = (file: FileRef) => localFileText({ file, redeem: () => redeemFileRef(file, { tenantId: 'local', documents }) });
  const stored = (name: string, bytes: string | Buffer, contentType?: string) =>
    documents.put({ tenantId: 'local', bytes: Buffer.from(bytes), name, contentType: contentType ?? '' });
  assert.deepEqual(await read(await stored('a.txt', 'hi', 'text/plain')), { text: 'hi' });
  assert.deepEqual(await read(await stored('a.json', '{"a":1}', 'application/json')), { text: '{"a":1}' });
  assert.deepEqual(await read(await stored('a.csv', 'x,y')), { text: 'x,y' });
  // `files.render` stores a "pdf" as its text.
  assert.deepEqual(await read(await stored('r.pdf', 'plain', 'application/pdf')), { text: 'plain' });
  assert.deepEqual(await read(await stored('real.pdf', Buffer.from('%PDF-1.7\n…'), 'application/pdf')), {
    unreadable: 'unsupported_type',
    detail: 'lf cannot extract text from a PDF yet',
  });
  assert.equal('unreadable' in (await read(await stored('p.png', 'x', 'image/png'))), true);

  writeFileSync(join(dir, 'secret.txt'), 'nope');
  const outside = await read({ __brand: 'FileRef', name: 'secret.txt', source: { store: 'document', objectUri: 'lf-files:../../secret.txt' } });
  assert.equal((outside as { unreadable?: string }).unreadable, 'bytes_unavailable');

  // An external's file is redeemed from the external that owns it; none is reachable here.
  const external = await read({ __brand: 'FileRef', name: 'x.txt', source: { adapterType: 'acme_crm', handle: 'h' } });
  assert.equal((external as { unreadable?: string }).unreadable, 'bytes_unavailable');

  const gone = await stored('gone.txt', 'x', 'text/plain');
  const goneSource = gone.source;
  assert.ok(goneSource !== undefined && 'objectUri' in goneSource);
  rmSync(join(dir, '.lf/files', goneSource.objectUri.replace(/^lf-files:/, '')));
  assert.equal((await read(gone) as { unreadable?: string }).unreadable, 'bytes_unavailable');
  await documents.close();
});

test('loadSecrets: environment names are matched lowercased and malformed ones are refused', () => {
  const dir = project({ secrets: null });
  const credentials = loadSecrets(loadProject(dir), { LF_SECRET__Acme__EXTERNAL: 'acme_crm', LF_SECRET__ACME__TOKEN: 't' });
  assert.deepEqual(credentials.get('acme')?.fields, { token: 't' });
  assert.throws(() => loadSecrets(loadProject(dir), { LF_SECRET__ACME: 'x' }), /LF_SECRET__<CREDENTIAL>__<FIELD>/);
  assert.throws(() => loadSecrets(loadProject(dir), { LF_SECRET__ACME__TOKEN: 'x' }), /LF_SECRET__ACME__EXTERNAL is not set/);
});
