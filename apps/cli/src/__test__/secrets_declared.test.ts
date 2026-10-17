// An external whose manifest declares its credential (protocol `credentials`):
// lf sends the install's credential on each call, with only the fields the
// declaration names, refreshes an `oauth2` one from the declaration's token
// URL, and writes the refreshed token back to the secrets file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lfCommand } from './example';

const EXAMPLE = resolve(__dirname, '../../../../examples/lf-acme');
const EVENT = 'events/company_created.json';

async function tokenServer(): Promise<{ url: string; forms: URLSearchParams[]; authorizations: (string | undefined)[]; close(): void }> {
  const forms: URLSearchParams[] = [];
  const authorizations: (string | undefined)[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      forms.push(new URLSearchParams(body));
      authorizations.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600, refresh_token: 'r2' }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}/token`, forms, authorizations, close: () => server.close() };
}

/** The example, its external declaring an `oauth2` credential and logging the
 *  `credential` each request carries. */
function project(tokenUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-declared-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !src.includes(`${EXAMPLE}/.lf`) });
  mkdirSync(join(dir, '.lf'), { recursive: true });
  const manifest = join(dir, 'externals/acme_crm/lf-external.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('field: token', 'field: access_token').replace('env:\n', 'env:\n  CREDENTIAL_LOG: "{lf}/credential.log"\n'));
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const source = readFileSync(server, 'utf8');
  const methods = "    methods: Object.keys(METHODS).filter((m) => m !== 'manifest'),\n";
  const parse = '      const { method, params } = JSON.parse(body);\n';
  assert.ok(source.includes(methods) && source.includes(parse), 'the example external changed; update this test patch');
  const declaration = JSON.stringify([
    { name: 'acme', kind: 'oauth2', fields: [{ name: 'webhook_secret' }], oauth2: { authorizeUrl: 'https://acme.example.test/authorize', tokenUrl } },
  ]);
  writeFileSync(
    server,
    source
      .replace(methods, `${methods}    credentials: ${declaration},\n`)
      .replace(parse, `${parse}      (await import('node:fs')).appendFileSync(process.env.CREDENTIAL_LOG, JSON.stringify(JSON.parse(body).credential ?? null) + '\\n');\n`),
  );
  writeFileSync(
    join(dir, '.lf/secrets.yaml'),
    'acme:\n  external: acme_crm\n  access_token: stale-token\n  refresh_token: r1\n  client_id: cid\n  client_secret: csecret\n  webhook_secret: w\n  expires_at: 2000-01-01T00:00:00Z\n',
  );
  return dir;
}

function lf(dir: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(...lfCommand(args), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => done({ code: code ?? -1, out }));
  });
}

test('a declared oauth2 credential is refreshed from the declaration, sent with its declared fields only, and written back', async () => {
  const token = await tokenServer();
  try {
    const dir = project(token.url);
    const run = await lf(dir, ['run', '--event', EVENT]);
    assert.equal(run.code, 0, run.out);
    assert.equal(token.forms.length, 1, 'one refresh');
    assert.equal(token.forms[0]?.get('refresh_token'), 'r1');
    // The protocol's default client auth for a declared credential: HTTP Basic.
    assert.equal(token.authorizations[0], `Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    const sent = readFileSync(join(dir, '.lf/credential.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { name: string; fields: Record<string, string> } | null)
      .filter((c) => c !== null);
    assert.ok(sent.length > 0, 'the run made calls carrying the credential');
    const last = sent.at(-1);
    assert.equal(last?.name, 'acme');
    assert.deepEqual(Object.keys(last?.fields ?? {}).sort(), ['access_token', 'expires_at', 'refresh_token', 'webhook_secret']);
    assert.equal(last?.fields.access_token, 'fresh-token');
    const file = readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8');
    assert.match(file, /access_token: fresh-token/);
    assert.match(file, /refresh_token: r2/);
    assert.match(file, /client_secret: csecret/);
  } finally {
    token.close();
  }
});
