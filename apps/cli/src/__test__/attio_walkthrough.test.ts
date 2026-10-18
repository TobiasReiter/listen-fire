// The "local Attio sync with lf" walkthrough (examples/lf-attio/README.md),
// every step as a person types it, against the fake Attio in
// apps/fake-channels: its Attio API, its OAuth provider, and its control door
// that delivers Attio's signed webhooks to whatever lf serve registered.
//
//   lf init → lf connect @lf/attio (pointed at the fake) → lf credential add
//   --headless → the example's movement → lf check → lf run --event --dry-run
//   → publicUrl → lf serve (registers the webhook) → a signed delivery runs
//   the movement, a duplicate runs nothing, the movement's own write echoing
//   back as record.updated runs nothing, a second user's update runs it →
//   lf runs → restarts keep the webhook, a removed listen removes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { lf as lfSync, served } from './example';
import { lf, ok } from './interactive';

const REPO = resolve(__dirname, '../../../..');
const EXAMPLE = join(REPO, 'examples/lf-attio');
const FAKE = join(REPO, 'apps/fake-channels');

interface Fake {
  url: string;
  json(path: string, body?: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

/** apps/fake-channels on a free port, its state in a folder of its own. */
async function fakeChannels(): Promise<Fake> {
  const cwd = mkdtempSync(join(tmpdir(), 'lf-attio-fake-'));
  const child: ChildProcess = spawn(process.execPath, [join(FAKE, 'node_modules/tsx/dist/cli.mjs'), join(FAKE, 'src/index.ts')], {
    cwd,
    env: { ...process.env, FAKE_CHANNELS_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  const url = await new Promise<string>((found, failed) => {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const port = /running on http:\/\/localhost:(\d+)/.exec(line)?.[1];
      if (port !== undefined) found(`http://127.0.0.1:${port}`);
    });
    void exited.then(() => failed(new Error('fake-channels exited before listening')));
  });
  const json = async (path: string, body?: unknown) => {
    const answer = await fetch(`${url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(answer.status, 200, `${path}: ${await answer.clone().text()}`);
    return answer.json() as Promise<unknown>;
  };
  return { url, json, stop: async () => (child.kill('SIGTERM'), exited) };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

/** Wait, up to 20s, for `holds` to hold over the server's output. */
async function until(holds: () => boolean, lines: string[]): Promise<void> {
  for (const deadline = Date.now() + 20_000; !holds(); ) {
    if (Date.now() > deadline) throw new Error(`timed out; saw:\n${lines.join('\n')}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

interface Webhook {
  target_url: string;
  subscriptions: Array<{ event_type: string }>;
  id: string;
}

interface Company {
  id: { record_id: string };
  values: { name?: Array<{ value: string }>; description?: Array<{ value: string }> };
}

test('the Attio walkthrough, end to end against the fake Attio', async () => {
  const fake = await fakeChannels();
  try {
    const F = fake.url;
    const dir = join(mkdtempSync(join(tmpdir(), 'lf-attio-')), 'attio-sync');

    // 1. A project.
    assert.equal(lfSync(join(dir, '..'), 'init', 'attio-sync').code, 0);

    // 2. The module, pointed at the fake: enter generates the webhook secret.
    const connected = await ok(
      lf(dir, ['connect', '@lf/attio', '--base-url', `${F}/attio`, '--oauth-authorize-url', `${F}/oauth/authorize`, '--oauth-token-url', `${F}/oauth/token`], {
        answers: ['', 'lf-attio-app', 'lf-attio-secret', '8976'],
      }),
    );
    assert.match(connected, /installed @lf\/attio as externals\/attio/);
    assert.match(connected, /http:\/\/127\.0\.0\.1:8976\/callback/);

    // 3. Henry signs in, headless: the browser's redirect pasted back.
    const adding = lf(dir, ['credential', 'add', '--module', '@lf/attio', 'henry_attio', '--headless'], { answers: ['', ''] });
    const authorize = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)).trim();
    assert.equal(new URL(authorize).searchParams.get('redirect_uri'), 'http://127.0.0.1:8976/callback');
    const consent = await fetch(authorize, { redirect: 'manual' });
    const location = consent.headers.get('location');
    assert.ok(location !== null, 'the fake provider redirects back with a code');
    await adding.line(/paste the URL your browser was sent back to/);
    adding.answer(location);
    assert.match(await ok(adding), /added henry_attio \(attio, credential attio\)/);

    // 4. The example's movement, and its event for a company in the fake.
    cpSync(join(EXAMPLE, 'movements/sync.mvt'), join(dir, 'movements/sync.mvt'));
    const vireo = ((await fake.json('/attio/v2/objects/companies/records', { data: { values: { name: 'Vireo Robotics' } } })) as { data: Company }).data;
    const event = JSON.parse(readFileSync(join(EXAMPLE, 'events/created.json'), 'utf8')) as { event: { externalId: string; payload: { id: { record_id: string } } } };
    event.event.externalId = vireo.id.record_id;
    event.event.payload.id.record_id = vireo.id.record_id;
    mkdirSync(join(dir, 'events'));
    writeFileSync(join(dir, 'events/created.json'), JSON.stringify(event));

    // 5. Checked against the fake's schema.
    const checked = lfSync(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    // 6. A dry run reads the fake and writes nothing.
    const dry = lfSync(dir, 'run', '--event', 'events/created.json', '--dry-run');
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /sync:stamp completed/);
    assert.match(dry.out, /dry run, not written: .*"kind":"update".*"Description":"Seen by lf"/);
    const companies = async () => (await fake.json('/admin/attio/record:companies/state')) as Company[];
    const named = async (name: string) => (await companies()).find((c) => c.values.name?.[0]?.value === name);
    assert.equal((await named('Vireo Robotics'))?.values.description, undefined);

    // 7. Where the fake reaches lf serve.
    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    appendFileSync(join(dir, 'lf.yaml'), `publicUrl: ${publicUrl}\n`);
    const door = `${publicUrl}/api/public/webhook-sync/attio/henry_attio`;
    const webhooks = async () => (await fake.json('/admin/attio/webhook/state')) as Webhook[];

    // 8. lf serve registers the webhook, and a signed delivery runs the movement.
    let serving = await served(dir, ['--port', String(port)]);
    try {
      await serving.waitFor(/^attio: registered webhook fake-webhook-\d+ for record\.created,record\.updated at /);
      const registered = await webhooks();
      assert.equal(registered.length, 1);
      assert.equal(registered[0]?.target_url, door);
      assert.deepEqual(registered[0]?.subscriptions.map((s) => s.event_type), ['record.created', 'record.updated']);

      const northwind = ((await fake.json('/attio/v2/objects/companies/records', { data: { values: { name: 'Northwind Labs' } } })) as { data: Company }).data;
      const created = { events: [{ event_type: 'record.created', id: { object_id: 'companies', record_id: northwind.id.record_id } }] };
      const first = (await fake.json('/attio/control/deliver', created)) as { deliveries: Array<{ targetUrl: string; status: number }> };
      assert.deepEqual(first.deliveries.map((d) => [d.targetUrl, d.status]), [[door, 200]]);
      await serving.waitFor(/^run \S+ sync:stamp completed$/);
      assert.equal((await named('Northwind Labs'))?.values.description?.[0]?.value, 'Seen by lf');

      // The same delivery again: accepted, and nothing runs.
      const again = (await fake.json('/attio/control/deliver', created)) as { deliveries: Array<{ status: number }> };
      assert.deepEqual(again.deliveries.map((d) => d.status), [200]);
      await serving.waitFor(/sync:stamp has run the event attio:record\.created:companies:\S+ before: this delivery runs nothing/);
      assert.equal(serving.lines.filter((l) => /^run \S+ sync:stamp/.test(l)).length, 1);

      // The movement's own write comes back as record.updated (Attio says a
      // workspace member, as it may): the record is as the write left it, so
      // it is only the echo, and runs nothing.
      const updated = { events: [{ event_type: 'record.updated', id: { object_id: 'companies', record_id: northwind.id.record_id } }] };
      const echo = (await fake.json('/attio/control/deliver', updated)) as { deliveries: Array<{ status: number }> };
      assert.deepEqual(echo.deliveries.map((d) => d.status), [200]);
      await serving.waitFor(/sync:stamp wrote the record \S+ and it is unchanged since: this event is that write's echo and runs nothing/);
      assert.equal(serving.lines.filter((l) => /^run \S+ sync:stamp/.test(l)).length, 1);

      // A second user changes the description: the same event now runs the
      // movement, which writes its description back; that write's echo runs
      // nothing again.
      const edited = await fetch(`${F}/attio/v2/objects/companies/records/${northwind.id.record_id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { values: { description: 'Edited by Bob' } } }),
      });
      assert.equal(edited.status, 200, await edited.clone().text());
      await fake.json('/attio/control/deliver', { events: [{ ...updated.events[0], actor: { type: 'workspace-member', id: 'fake-member-2' } }] });
      await until(() => serving.lines.filter((l) => /^run \S+ sync:stamp completed$/.test(l)).length === 2, serving.lines);
      assert.equal((await named('Northwind Labs'))?.values.description?.[0]?.value, 'Seen by lf');
      await fake.json('/attio/control/deliver', updated);
      await until(() => serving.lines.filter((l) => /this event is that write's echo and runs nothing/.test(l)).length === 2, serving.lines);
      assert.equal(serving.lines.filter((l) => /^run \S+ sync:stamp/.test(l)).length, 2);

      // A delivery not signed by the webhook's secret is refused.
      const forged = await fetch(door, { method: 'POST', headers: { 'content-type': 'application/json', 'attio-signature': 'f00d' }, body: JSON.stringify({ webhook_id: 'x', events: [] }) });
      assert.equal(forged.status, 401);
    } finally {
      await serving.stop();
    }

    // 9. The runs: the dry run, the created company, and the second user's update.
    const runs = lfSync(dir, 'runs');
    assert.equal(runs.code, 0, runs.out);
    assert.equal(runs.out.split('\n').filter((l) => /sync:stamp completed/.test(l)).length, 3, runs.out);

    // A restart keeps the webhook it registered.
    serving = await served(dir, ['--port', String(port)]);
    try {
      await serving.waitFor(/^attio: webhook fake-webhook-\d+ is registered for record\.created,record\.updated at /);
      assert.equal((await webhooks()).length, 1);
    } finally {
      await serving.stop();
    }

    // The listen removed: the next start removes its webhook.
    renameSync(join(dir, 'movements/sync.mvt'), join(dir, 'sync.mvt.off'));
    serving = await served(dir, ['--port', String(port)]);
    try {
      await serving.waitFor(/^attio: no listen needs its webhook any more; removed webhook fake-webhook-\d+$/);
      assert.deepEqual(await webhooks(), []);
    } finally {
      await serving.stop();
    }
  } finally {
    await fake.stop();
  }
});
