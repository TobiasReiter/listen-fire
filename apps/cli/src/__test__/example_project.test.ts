// The skeleton's end-to-end proof, through the real binary entry point: the
// example project (examples/lf-acme) checks clean, an event runs and its write
// lands in the sample external, the run parks on `await sleep` and `lf resume`
// finishes it, and `lf serve` takes one signed webhook.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const LF = resolve(__dirname, '../../bin/lf.cjs');
const EXAMPLE = resolve(__dirname, '../../../../examples/lf-acme');

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-example-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !src.includes(`${EXAMPLE}/.lf`) });
  mkdirSync(join(dir, '.lf'), { recursive: true });
  cpSync(join(dir, 'secrets.example.yaml'), join(dir, '.lf', 'secrets.yaml'));
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

function companies(dir: string): string[] {
  const state = JSON.parse(readFileSync(join(dir, '.lf/externals/acme_crm/state.json'), 'utf8')) as {
    companies: Array<{ fields: { Name: string } }>;
  };
  return state.companies.map((c) => c.fields.Name);
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
