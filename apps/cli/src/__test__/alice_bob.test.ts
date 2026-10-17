// Henry's acceptance for provider credentials per connection, in lf: one
// separately run HubSpot-like module (served by serve-module, a process lf
// reaches over protocol 2), ONE install holding its server secret and the
// OAuth app, and two user credentials. A movement reads as Alice and writes as
// Bob. Alice's token has expired: the host refreshes it with the install's
// OAuth app and writes the rotated tokens back to Alice's entry, and only hers.
// A connection naming another module's or another declaration's credential,
// or the install itself, is refused at check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { lfCommand } from './example';
import { startFakeHubSpot, type FakeHubSpot } from './hubspot/fake_hubspot';
import { dealCreatedEvent } from './hubspot/module';

const MODULE = resolve(__dirname, 'hubspot/module.ts');
const SERVER_SECRET = 'install-server-secret';
const CLIENT = { clientId: 'listen-fire-app', clientSecret: 'listen-fire-app-secret' };

function lfAsync(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(...lfCommand(args), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => done({ code: code ?? -1, out }));
  });
}

const MIRROR = `import { hubspot } from adapters
import { alice_hubspot, bob_hubspot } from credentials

hs_alice = connect hubspot using alice_hubspot
hs_bob = connect hubspot using bob_hubspot

function mirror(deal: <hs_alice-[:Deal]->>) {
  write hs_bob-[:Deal]-> { Name: "Mirror of \${deal.Name}" }
}

listen to hs_alice { events: ["deal.created"] } fire mirror
`;

function hubspotProject(fake: FakeHubSpot): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-alice-bob-'));
  writeFileSync(join(dir, 'lf.yaml'), 'engine: 0.11.0\nmovements: movements\nexternals: externals\n');
  mkdirSync(join(dir, 'externals/hubspot'), { recursive: true });
  writeFileSync(
    join(dir, 'externals/hubspot/lf-external.yaml'),
    stringify({
      name: 'hubspot',
      module: MODULE,
      auth: { kind: 'bearer', field: 'server_secret' },
      // serve-module checks every call carries the install's server secret.
      env: { MODULE_TOKEN: SERVER_SECRET, MODULE_BASE_URL_OVERRIDE: fake.base, HUBSPOT_PROVIDER_URL: fake.base },
    }),
  );
  mkdirSync(join(dir, 'movements'));
  writeFileSync(join(dir, 'movements/mirror.mvt'), MIRROR);
  mkdirSync(join(dir, '.lf'));
  writeFileSync(
    join(dir, '.lf/secrets.yaml'),
    stringify({
      hubspot_install: { module: 'hubspot', server_secret: SERVER_SECRET, client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret },
      alice_hubspot: { module: 'hubspot', credential: 'oauth', ...fake.signIn('alice', { expired: true }) },
      bob_hubspot: { module: 'hubspot', credential: 'oauth', ...fake.signIn('bob') },
    }),
  );
  return dir;
}

function secrets(dir: string): Record<string, Record<string, string>> {
  return parse(readFileSync(join(dir, '.lf/secrets.yaml'), 'utf8')) as Record<string, Record<string, string>>;
}

test('one install, two users: the movement reads as Alice and writes as Bob; Alice’s rotated token lands on her entry', async () => {
  const fake = await startFakeHubSpot(CLIENT);
  try {
    const dir = hubspotProject(fake);
    const before = secrets(dir);
    fake.deals.push({ id: 'deal-1', Name: 'Acme expansion', owner: 'alice' });
    writeFileSync(join(dir, 'deal.json'), JSON.stringify({ external: 'hubspot', event: dealCreatedEvent({ id: 'deal-1', Name: 'Acme expansion' }) }));

    const check = await lfAsync(dir, 'check');
    assert.equal(check.code, 0, check.out);
    const run = await lfAsync(dir, 'run', '--event', 'deal.json');
    assert.equal(run.code, 0, run.out);

    assert.deepEqual(
      fake.calls.filter((c) => c.as !== undefined).map((c) => `${c.method} ${c.path} as ${c.as}`),
      ['GET /deals/deal-1 as alice', 'POST /deals as bob'],
    );
    assert.deepEqual(fake.deals.map((d) => `${d.Name} (${d.owner})`), ['Acme expansion (alice)', 'Mirror of Acme expansion (bob)']);
    // The host refreshed Alice's expired token once, with its own OAuth app.
    assert.deepEqual(fake.refreshes, ['alice']);

    const after = secrets(dir);
    assert.equal(after.alice_hubspot?.refresh_token, fake.refreshTokenOf('alice'));
    assert.notEqual(after.alice_hubspot?.access_token, before.alice_hubspot?.access_token);
    assert.equal(after.alice_hubspot?.credential, 'oauth');
    assert.deepEqual(after.bob_hubspot, before.bob_hubspot);
    assert.deepEqual(after.hubspot_install, before.hubspot_install);
  } finally {
    await fake.close();
  }
});

test('a connection naming the install, another declaration’s credential or another module’s is refused at check', async () => {
  const fake = await startFakeHubSpot(CLIENT);
  try {
    const dir = hubspotProject(fake);
    const file = secrets(dir);
    file.alice_key = { module: 'hubspot', credential: 'api_key', api_key: 'k' };
    file.acme = { external: 'acme_crm', token: 't' };
    writeFileSync(join(dir, '.lf/secrets.yaml'), stringify(file));
    const refused = async (using: string): Promise<string> => {
      writeFileSync(join(dir, 'movements/mirror.mvt'), MIRROR.replace('connect hubspot using alice_hubspot', `connect hubspot using ${using}`).replace('import { alice_hubspot, bob_hubspot }', `import { ${using}, bob_hubspot }`));
      const check = await lfAsync(dir, 'check');
      assert.notEqual(check.code, 0, check.out);
      return check.out;
    };
    assert.match(await refused('alice_key'), /'alice_key' is hubspot's 'api_key' credential, which 'hubspot' does not declare/);
    assert.match(await refused('acme'), /'acme' is a acme_crm credential — 'hubspot' needs a hubspot credential/);
    assert.match(await refused('hubspot_install'), /MOV_IMPORT_UNKNOWN Unknown credential 'hubspot_install'/);
  } finally {
    await fake.close();
  }
});
