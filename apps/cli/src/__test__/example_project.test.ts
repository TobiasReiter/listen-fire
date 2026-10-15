// The skeleton's end-to-end proof, through the real binary entry point: the
// example project (examples/lf-acme) checks clean, an event runs and its write
// lands in the sample external, the run parks on `await sleep` and `lf resume`
// finishes it, and `lf serve` takes one signed webhook.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { LF, companies, crmCompanies, externalPort, lf, project, served } from './example';

test('lf check: the example is clean', () => {
  const dir = project();
  const { code, out } = lf(dir, 'check');
  assert.equal(code, 0, out);
  assert.match(out, /1 file\(s\), 0 error\(s\)/);
});

test('lf run --event writes through the external, parks on sleep, and lf resume finishes it', () => {
  const dir = project();
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /companies:welcome parked — 1 write\(s\)/);
  assert.deepEqual(companies(dir), ['Welcome Vireo Robotics']);

  const resumed = lf(dir, 'resume');
  assert.equal(resumed.code, 0, resumed.out);
  assert.match(resumed.out, /companies:welcome completed/);
  assert.deepEqual(companies(dir), ['Welcome Vireo Robotics', 'Follow up Vireo Robotics']);

  assert.match(lf(dir, 'resume').out, /no parked runs/);
});

test('lf run --webhook refuses a delivery whose signature does not verify', () => {
  const dir = project();
  const { code, out } = lf(dir, 'run', '--ephemeral', '--webhook', 'acme_crm', '--body', 'events/webhook_body.json', '--header', 'x-listen-fire-signature:00');
  assert.equal(code, 1);
  assert.match(out, /signature did not verify/);
});

test('lf serve takes one signed webhook at /hooks/<external>/<install>', async () => {
  const dir = project();
  const server = spawn(process.execPath, [LF, 'serve', '--ephemeral', '--port', '0'], {
    cwd: dir,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      server.once('exit', (c) => reject(new Error(`lf serve exited ${c}`)));
      createInterface({ input: server.stdout! }).on('line', (line) => {
        const m = /serving on http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
        if (m?.[1] !== undefined) resolvePort(Number(m[1]));
      });
    });
    const body = readFileSync(join(dir, 'events/webhook_body.json'));
    const signature = createHmac('sha256', 'dev-acme-webhook-secret').update(body).digest('hex');
    const response = await fetch(`http://127.0.0.1:${port}/hooks/acme_crm/acme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-listen-fire-signature': signature },
      body,
    });
    assert.equal(response.status, 202);
    const answer = (await response.json()) as { runs: Array<{ status: string; writes: number }> };
    assert.deepEqual(answer.runs.map((r) => [r.status, r.writes]), [['parked', 1]]);
    assert.deepEqual(companies(dir), ['Welcome Kestrel Labs']);
  } finally {
    server.kill('SIGTERM');
  }
});

test('a park inside an `all` arm: each arm resumes in its own process, and the join uses both arms\' answers', async () => {
  const dir = project('join');
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /join:both parked — 0 write\(s\)/);

  // 90 minutes on: the one-hour arm is due, the two-hour arm is not.
  const serving = await served(dir, [], { LF_CLOCK_AHEAD_MS: String(90 * 60_000) });
  try {
    await serving.waitFor(/resumed .* join:both parked/);
  } finally {
    await serving.stop();
  }
  assert.match(lf(dir, 'runs').out, /join:both parked/);
  assert.deepEqual(companies(dir), []);

  // The other arm, in a fresh process: the first arm's answer comes back from the state.
  const resumed = lf(dir, 'resume');
  assert.equal(resumed.code, 0, resumed.out);
  assert.match(resumed.out, /join:both completed — 1 write\(s\)/);
  assert.deepEqual(companies(dir), ['early late Vireo Robotics']);
});

test('lf serve: the external emits a company, the run awaits its first comment, and the external\'s wake resumes it', async () => {
  const dir = project('await');
  const serving = await served(dir);
  try {
    const crm = `http://127.0.0.1:${externalPort(dir)}`;
    const door = `http://127.0.0.1:${serving.port}/api/public/adapter/acme_crm`;

    // The emit door fires the listen; the run parks on the await.
    const created = await fetch(`${crm}/dev/companies`, { method: 'POST', body: JSON.stringify({ Name: 'Osprey' }) });
    const company = (await created.json()) as { id: string; pushed: { status: number; body: { accepted: number } } };
    assert.deepEqual(company.pushed, { status: 202, body: { accepted: 1 } });
    await serving.waitFor(/run .* await:discuss parked/);
    const discussion = crmCompanies(dir).find((c) => c.fields.Name === 'Discuss Osprey');
    assert.ok(discussion, JSON.stringify(crmCompanies(dir)));

    // A wake presenting a credential no install holds is refused, and wakes nothing.
    const forged = await fetch(`${door}/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-token' },
      body: JSON.stringify({ keys: [`thread:${discussion.externalId}`] }),
    });
    assert.equal(forged.status, 401);
    const malformed = await fetch(`${door}/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-acme-token' },
      body: JSON.stringify({ keys: [] }),
    });
    assert.equal(malformed.status, 400);
    assert.match(lf(dir, 'runs').out, /await:discuss parked/);

    // The comment lands; the CRM pushes its wake; the drain resumes the run with the answer.
    const commented = await fetch(`${crm}/dev/comments`, { method: 'POST', body: JSON.stringify({ company: discussion.externalId, text: 'yes please' }) });
    assert.deepEqual(((await commented.json()) as { pushed: unknown }).pushed, { status: 202, body: { accepted: 1 } });
    await serving.waitFor(/resumed .* await:discuss completed/);
    assert.deepEqual(companies(dir), ['Osprey', 'Discuss Osprey', 'Answered yes please']);
  } finally {
    await serving.stop();
  }
});

test('lf serve drains a due timer: the example\'s hour-long sleep, judged two hours on', async () => {
  const dir = project();
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  const serving = await served(dir, [], { LF_CLOCK_AHEAD_MS: String(2 * 60 * 60_000) });
  try {
    await serving.waitFor(/resumed .* companies:welcome completed/);
  } finally {
    await serving.stop();
  }
  assert.deepEqual(companies(dir), ['Welcome Vireo Robotics', 'Follow up Vireo Robotics']);
});

test('a webhook delivery carrying comments wakes the awaits parked on their threads (wakeKeys)', async () => {
  const dir = project('await');
  const run = lf(dir, 'run', '--event', 'events/company_created.json');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /await:discuss parked/);
  const discussion = crmCompanies(dir).find((c) => c.fields.Name === 'Discuss Vireo Robotics');
  assert.ok(discussion);

  // The comment is in the CRM; its delivery names the thread and no company.
  const stateFile = join(dir, '.lf/externals/acme_crm/state.json');
  const crm = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(stateFile, JSON.stringify({ ...crm, comments: [{ id: 'comment-1', thread: discussion.externalId, Text: 'on it' }] }));
  const body = Buffer.from(JSON.stringify({ comments: [{ thread: discussion.externalId, text: 'on it' }] }));

  const serving = await served(dir);
  try {
    const response = await fetch(`http://127.0.0.1:${serving.port}/hooks/acme_crm/acme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-listen-fire-signature': createHmac('sha256', 'dev-acme-webhook-secret').update(body).digest('hex') },
      body,
    });
    assert.equal(response.status, 202);
    await serving.waitFor(/resumed .* await:discuss completed/);
  } finally {
    await serving.stop();
  }
  assert.deepEqual(companies(dir), ['Discuss Vireo Robotics', 'Answered on it']);
});
