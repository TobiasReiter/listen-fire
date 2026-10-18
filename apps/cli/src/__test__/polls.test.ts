// A polled source in lf: a module whose manifest declares `poll` is polled per
// listen — by `lf serve` on its interval, by `lf drain` when a poll is due, and
// by `lf run --poll <movement>` at once. Its checkpoint is kept per listen, an
// event whose idempotencyKey a listen has run is not run again, and two
// workers draining one state never poll one listen at the same time.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { lf, lfCommand, served } from './example';
import { feed, feedProject, polls } from './feed';

function seen(dir: string): number {
  return lf(dir, 'runs').out.split('\n').filter((l) => l.includes('notes:seen')).length;
}

function lfAt(dir: string, args: string[], aheadMs = 0): { code: number; out: string } {
  const run = spawnSync(...lfCommand(args), { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', LF_CLOCK_AHEAD_MS: String(aheadMs) } });
  return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

function lfAsync(dir: string, args: string[]): Promise<string> {
  return new Promise((done) => {
    const child = spawn(...lfCommand(args), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', () => done(out));
  });
}

test('a polled listen checks clean', () => {
  const dir = feedProject();
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
});

test('drain polls a due listen once, its checkpoint advancing; a poll missed while no worker ran is one poll', () => {
  const dir = feedProject();
  // Seen for the first time: polled now, with no checkpoint.
  const first = lfAt(dir, ['drain', '--until-idle']);
  assert.match(first.out, /MOVENG_ERROR: seen First/);
  assert.match(first.out, /MOVENG_ERROR: seen Second/);
  assert.deepEqual(polls(dir), [null]);
  assert.equal(seen(dir), 2);
  // Not due again for its interval.
  lfAt(dir, ['drain', '--until-idle']);
  assert.deepEqual(polls(dir), [null]);
  // Ten intervals on: one poll, from where the last one ended.
  feed(dir, [
    { id: 'n1', title: 'First', at: 1 },
    { id: 'n2', title: 'Second', at: 2 },
    { id: 'n3', title: 'Third', at: 3 },
  ]);
  const caught = lfAt(dir, ['drain', '--until-idle'], 600_000);
  assert.match(caught.out, /MOVENG_ERROR: seen Third/);
  assert.deepEqual(polls(dir), [null, 2]);
  assert.equal(seen(dir), 3);
});

test('lf run --poll polls at once; an event a listen has run is not run again', () => {
  const dir = feedProject();
  assert.equal(seen(dir), 0);
  lf(dir, 'run', '--poll', 'seen');
  assert.equal(seen(dir), 2);
  // The provider hands back everything again: nothing new runs.
  writeFileSync(join(dir, 'externals/feed/replay'), '');
  const again = lf(dir, 'run', '--poll', 'seen');
  assert.match(again.out, /has run the event n1 before: this delivery runs nothing/);
  assert.equal(seen(dir), 2);
  assert.deepEqual(polls(dir), [null, 2]);
  const none = lf(dir, 'run', '--poll', 'nope');
  assert.equal(none.code, 1);
  assert.match(none.out, /no listen on a polled source fires 'nope'/);
});

test('two drains at once poll a listen once', async () => {
  const dir = feedProject();
  await Promise.all([lfAsync(dir, ['drain', '--until-idle']), lfAsync(dir, ['drain', '--until-idle'])]);
  assert.deepEqual(polls(dir), [null]);
  assert.equal(seen(dir), 2);
});

test('lf serve polls on the interval and fires each new event', async () => {
  const dir = feedProject();
  writeFileSync(join(dir, 'externals/feed/fast'), '');
  const server = await served(dir);
  try {
    await server.waitFor(/^run \S+ notes:seen failed — MOVENG_ERROR: seen Second/);
    feed(dir, [
      { id: 'n2', title: 'Second', at: 2 },
      { id: 'n3', title: 'Third', at: 3 },
    ]);
    await server.waitFor(/^run \S+ notes:seen failed — MOVENG_ERROR: seen Third/);
  } finally {
    await server.stop();
  }
  assert.equal(seen(dir), 3);
  assert.equal(polls(dir)[1], 2);
});

test('a listen\'s `every` is its poll interval, over the source\'s', () => {
  const dir = feedProject('listen to f { every: 5m } fire seen');
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  lfAt(dir, ['drain', '--until-idle']);
  assert.deepEqual(polls(dir), [null]);
  // Two minutes on is past the source's minute, but not the listen's five.
  lfAt(dir, ['drain', '--until-idle'], 120_000);
  assert.deepEqual(polls(dir), [null]);
  lfAt(dir, ['drain', '--until-idle'], 600_000);
  assert.equal(polls(dir).length, 2);
});

test('the old `pollIntervalSeconds` spelling is refused from v5, with the fix', () => {
  const dir = feedProject('listen to f { pollIntervalSeconds: 300 } fire seen');
  const check = lf(dir, 'check');
  assert.notEqual(check.code, 0);
  assert.match(check.out, /MOV_V5_SPELLING/);
  assert.match(check.out, /every: 5m/);
});
