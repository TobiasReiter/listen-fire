// The skeleton's end-to-end proof, through the real binary entry point: the
// example project (examples/lf-acme) checks clean, an event runs and its write
// lands in the sample external, the run parks on `await sleep` and `lf resume`
// finishes it, and `lf serve` takes one signed webhook.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const LF = resolve(__dirname, '../../bin/lf.cjs');
const EXAMPLE = resolve(__dirname, '../../../../examples/lf-acme');

/** The example project; with a fixture, its movements replaced by the
 *  fixture's folder (movements/<name>). */
function project(fixture?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-example-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !src.includes(`${EXAMPLE}/.lf`) });
  mkdirSync(join(dir, '.lf'), { recursive: true });
  cpSync(join(dir, 'secrets.example.yaml'), join(dir, '.lf', 'secrets.yaml'));
  if (fixture !== undefined) {
    rmSync(join(dir, 'movements'), { recursive: true });
    cpSync(resolve(__dirname, 'movements', fixture), join(dir, 'movements'), { recursive: true });
  }
  return dir;
}

function lf(dir: string, ...args: string[]): { code: number; out: string } {
  const run = spawnSync(process.execPath, [LF, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

interface Served {
  port: number;
  lines: string[];
  /** Resolves with the first output line matching, or rejects after `ms`. */
  waitFor(pattern: RegExp, ms?: number): Promise<string>;
  stop(): Promise<void>;
}

/** `lf serve` on a free port, its output collected. */
async function served(dir: string, args: string[] = [], env: Record<string, string> = {}): Promise<Served> {
  const server = spawn(process.execPath, [LF, 'serve', '--port', '0', ...args], {
    cwd: dir,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines: string[] = [];
  const waiters: Array<{ pattern: RegExp; resolve: (line: string) => void }> = [];
  createInterface({ input: server.stdout! }).on('line', (line) => {
    lines.push(line);
    for (const w of [...waiters]) {
      if (w.pattern.test(line)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(line);
      }
    }
  });
  const waitFor = (pattern: RegExp, ms = 20_000) =>
    new Promise<string>((resolveLine, reject) => {
      const seen = lines.find((l) => pattern.test(l));
      if (seen !== undefined) return resolveLine(seen);
      const timer = setTimeout(() => reject(new Error(`no line matching ${pattern} in ${ms}ms; saw:\n${lines.join('\n')}`)), ms);
      waiters.push({ pattern, resolve: (line) => (clearTimeout(timer), resolveLine(line)) });
    });
  const exited = new Promise<void>((resolveExit) => server.once('exit', () => resolveExit()));
  const line = await Promise.race([
    waitFor(/serving on http:\/\/127\.0\.0\.1:(\d+)/),
    exited.then(() => {
      throw new Error(`lf serve exited:\n${lines.join('\n')}`);
    }),
  ]);
  const port = Number(/:(\d+)\//.exec(line)?.[1]);
  return {
    port,
    lines,
    waitFor,
    stop: async () => {
      server.kill('SIGTERM');
      await exited;
    },
  };
}

/** The port the started external listens on, read from its own state. */
function externalPort(dir: string): number {
  return Number(readFileSync(join(dir, '.lf/externals/acme_crm/port'), 'utf8'));
}

function crmCompanies(dir: string): Array<{ externalId: string; fields: { Name: string } }> {
  const file = join(dir, '.lf/externals/acme_crm/state.json');
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, 'utf8')) as { companies: Array<{ externalId: string; fields: { Name: string } }> }).companies;
}

function companies(dir: string): string[] {
  return crmCompanies(dir).map((c) => c.fields.Name);
}

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
