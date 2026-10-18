// The run host's units in lf: `manual` (fired by `lf run <movement>`) and
// `cron` (ticks fired by `lf serve` and `lf drain`), in scope with no import
// from language version 5 — and `lf init`'s starter, which needs nothing else.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { lf, lfCommand, served } from './example';

function initialised(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lf-units-'));
  assert.equal(lf(dir, 'init', dir).code, 0);
  return dir;
}

const TICK = [
  'function tock(t: <cron-[:Tick]->>) {',
  '  fail("tick ${t.`Fired at`} on ${t.`Schedule`}")',
  '}',
  'listen to cron { schedule: "* * * * *" } fire tock',
  '',
].join('\n');

function ticks(dir: string): number {
  return lf(dir, 'runs').out.split('\n').filter((l) => l.includes('tick:tock')).length;
}

test('lf init → check → run works with nothing installed', () => {
  const dir = initialised();
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const run = lf(dir, 'run', 'hello');
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /hello:hello completed/);
});

test('lf run <movement> hands the movement a manual invocation; a movement no manual listen fires is refused', () => {
  const dir = initialised();
  writeFileSync(
    join(dir, 'movements/hello.mvt'),
    'function hello(run: <manual-[:Invocation]->>) {\n  fail("by ${run.`Run by (name)`} at ${run.`Fired at`}")\n}\nlisten to manual fire hello\n',
  );
  assert.match(spawnLf(dir, ['run', 'hello']), /MOVENG_ERROR: by Ada at \d{4}-\d\d-\d\dT/);
  const missing = lf(dir, 'run', 'nope');
  assert.equal(missing.code, 1);
  assert.match(missing.out, /no listen fires 'nope' on manual/);
});

test('a cron tick missed while no worker ran fires once on the next drain, never twice', () => {
  const dir = initialised();
  writeFileSync(join(dir, 'movements/tick.mvt'), TICK);
  // A listen's first drain owes nothing from before it.
  assert.equal(lf(dir, 'drain', '--until-idle').code, 0);
  assert.equal(ticks(dir), 0);
  // Ten minutes on, ten occurrences were missed: the latest one fires, once.
  const drained = spawnLf(dir, ['drain', '--until-idle'], 600_000);
  assert.match(drained, /tick:tock failed/);
  assert.match(drained, /MOVENG_ERROR: tick \S+:00\.000Z on \* \* \* \* \*/);
  assert.equal(ticks(dir), 1);
  spawnLf(dir, ['drain', '--until-idle'], 600_000);
  spawnLf(dir, ['resume'], 600_000);
  assert.equal(ticks(dir), 1);
  // The next occurrence is the next tick.
  spawnLf(dir, ['drain', '--until-idle'], 660_000);
  assert.equal(ticks(dir), 2);
});

test('lf serve fires a cron listen when its schedule comes due', async () => {
  const dir = initialised();
  writeFileSync(join(dir, 'movements/tick.mvt'), TICK);
  assert.equal(lf(dir, 'drain', '--until-idle').code, 0);
  // A minute on, the schedule has come due once.
  const server = await served(dir, [], { LF_CLOCK_AHEAD_MS: '60000' });
  try {
    await server.waitFor(/^run \S+ tick:tock failed — MOVENG_ERROR: tick /);
  } finally {
    await server.stop();
  }
  assert.equal(ticks(dir), 1);
});

/** `lf <args>` in `dir` as Ada, its clock `aheadMs` ahead. */
function spawnLf(dir: string, args: string[], aheadMs = 0): string {
  const env = { ...process.env, LF_USER: 'Ada', LF_CLOCK_AHEAD_MS: String(aheadMs) };
  const run = spawnSync(...lfCommand(args), { cwd: dir, encoding: 'utf8', env });
  return `${run.stdout}${run.stderr}`;
}
