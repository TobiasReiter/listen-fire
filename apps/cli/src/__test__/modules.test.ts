// Modules as externals: an `lf-external.yaml` that names a `module` is served
// by serve-module, the same module the platform loads in process. A plugin
// module's package is imported by its tag and called; an adapter module (the
// Dealroom pilot, `@lf/dealroom`) is connected and walked with the
// credential the secrets file names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { companies, lf, lfCommand, project } from './example';

const MODULE_KIT = resolve(__dirname, '../../../../packages/module-kit');
const DEALROOM = resolve(__dirname, '../../../../modules/dealroom');

/** The example with a plugin external serving `@lf/shout`, and its one
 *  movement calling it. */
function shoutProject(): string {
  const dir = project();
  mkdirSync(join(dir, 'externals/shout'));
  writeFileSync(join(dir, 'externals/shout/lf-external.yaml'), 'name: shout\nkind: plugin\nmodule: ./shout.ts\n');
  writeFileSync(
    join(dir, 'externals/shout/shout.ts'),
    `const { defineModule } = require(${JSON.stringify(join(MODULE_KIT, 'define.ts'))});
module.exports = defineModule({
  kind: 'plugin',
  name: '@lf/shout',
  credentials: [],
  plugins: [{
    priced: false,
    signature: {
      name: 'shout-out',
      params: [{ name: 'text', type: { kind: 'string' }, required: true }],
      dataDependency: 'none',
      additions: {},
      effects: {},
      output: { kind: 'value', type: { kind: 'string' } },
    },
  }],
  create: () => ({
    invokePlugin: async ({ config }) => ({ text: String(config.text).toUpperCase() }),
  }),
});
`,
  );
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(
    join(dir, 'movements/shout.mvt'),
    `import { acme_crm } from adapters
import { \`@lf/shout\` as shout } from plugins
import { acme } from credentials

crm = connect acme_crm using acme

function welcome(company: <crm-[:Company]->>) {
  loud = shout.shoutOut(company.Name)
  write crm-[:Company]-> { Name: "Welcome \${loud}" }
}

listen to crm { events: ["company.created"] } fire welcome
`,
  );
  return dir;
}

test('a plugin module external: its package is imported by tag, checked and called', () => {
  const dir = shoutProject();
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(companies(dir), ['Welcome VIREO ROBOTICS']);
});

test('a plugin the package does not have is refused at check, naming its members', () => {
  const dir = shoutProject();
  writeFileSync(join(dir, 'movements/shout.mvt'), `import { \`@lf/shout\` as shout } from plugins\n\nfunction go(t: <text>) {\n  x = shout.whisper(t)\n}\n`);
  const check = lf(dir, 'check');
  assert.notEqual(check.code, 0, check.out);
  assert.match(check.out, /`shout` has no member `whisper` \(its members: `shoutOut`\)/);
});

/** `lf <args>` without blocking this process, which serves the fake the run
 *  reaches. */
function lfAsync(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(...lfCommand(args), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => done({ code: code ?? -1, out }));
  });
}

/** A Dealroom that knows one company, keeping each request's auth. */
async function fakeDealroom(): Promise<{ url: string; auth: string[]; close(): void }> {
  const auth: string[] = [];
  const server = createServer((req, res) => {
    auth.push(req.headers.authorization ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ total: 1, items: [{ id: 3, name: 'Vaultwise', website_url: 'https://vaultwise.de' }] }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, auth, close: () => server.close() };
}

test('an adapter module external: @lf/dealroom, connected and walked with its declared credential', async () => {
  const dealroom = await fakeDealroom();
  try {
    const dir = project();
    mkdirSync(join(dir, 'externals/dealroom'));
    writeFileSync(join(dir, 'externals/dealroom/lf-external.yaml'), `name: dealroom\nmodule: ${JSON.stringify(DEALROOM)}\n`);
    appendFileSync(join(dir, '.lf/secrets.yaml'), `\ndr:\n  external: dealroom\n  apiKey: dr-key\n  baseUrl: ${dealroom.url}\n`);
    rmSync(join(dir, 'movements/companies.mvt'));
    writeFileSync(
      join(dir, 'movements/found.mvt'),
      `import { acme_crm, \`@lf/dealroom\` as dealroom } from adapters
import { acme, dr } from credentials

crm = connect acme_crm using acme
dr_api = connect dealroom using dr

function found(company: <crm-[:Company]->>) {
  names = Text.join(dr_api-[c:Companies WHERE c.Website == "vaultwise.de" ORDER BY c.Name]->.Name, ", ")
  write crm-[:Company]-> { Name: "Found \${names}" }
}

listen to crm { events: ["company.created"] } fire found
`,
    );
    const check = await lfAsync(dir, 'check');
    assert.equal(check.code, 0, check.out);
    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(companies(dir), ['Found Vaultwise']);
    assert.ok(dealroom.auth.length > 0 && dealroom.auth.every((a) => a === `Basic ${Buffer.from('dr-key:').toString('base64')}`), dealroom.auth.join());
  } finally {
    dealroom.close();
  }
});

const TELEGRAM = resolve(__dirname, '../../../../modules/telegram');

test("a module's inbound declaration verifies its deliveries: @lf/telegram's secret token", () => {
  const dir = project();
  mkdirSync(join(dir, 'externals/telegram'));
  writeFileSync(join(dir, 'externals/telegram/lf-external.yaml'), `name: telegram\nmodule: ${JSON.stringify(TELEGRAM)}\n`);
  appendFileSync(join(dir, '.lf/secrets.yaml'), '\ntg:\n  module: telegram\n  webhook_secret: tok\n');
  const update = { update_id: 1, message: { message_id: 5, date: 1760000000, chat: { id: 42, type: 'private' }, from: { id: 7, is_bot: false, first_name: 'Ada' }, text: 'hi' } };
  writeFileSync(join(dir, 'update.json'), JSON.stringify(update));
  const deliver = (...header: string[]) => lf(dir, 'run', '--ephemeral', '--webhook', 'telegram', '--body', 'update.json', ...header);

  for (const refused of [deliver(), deliver('--header', 'x-telegram-bot-api-secret-token:nope')]) {
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /signature did not verify for external "telegram"/);
  }
  // The token Telegram echoes, compared whole: not an HMAC of the body.
  const accepted = deliver('--header', 'x-telegram-bot-api-secret-token:tok');
  assert.equal(accepted.code, 0, accepted.out);
  assert.match(accepted.out, /no listen matched/);
});
