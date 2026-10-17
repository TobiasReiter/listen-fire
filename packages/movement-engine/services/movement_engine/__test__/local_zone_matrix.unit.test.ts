// The tests that read a date text with no offset (rust_run) must answer the
// same in every zone the process may run in: a version 5 date-time with no
// offset is UTC, never the process's zone. Jest hands every suite a copy of
// the environment, so a test assigning `TZ` moves no clock, and a process's
// zone is fixed when it starts: each zone is a jest of its own, `TZ` set.
//
// The zones: one on each side of UTC, one with a half hour offset, one that
// crosses the date line (a date there differs from UTC's by a day), and
// `GMT+3`, a POSIX zone `Intl` cannot name (three hours WEST of UTC): the run
// sends no zone, so a run there goes on and reads as it does everywhere.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PACKAGE = path.resolve(__dirname, '../../..');
const JEST = path.resolve(PACKAGE, '../../apps/api/node_modules/jest/bin/jest.js');

const ZONES = ['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata', 'Pacific/Apia', 'GMT+3'];

describe("the date tests, in each process's zone", () => {
  // Nested runs: each is a jest of the suite, a few seconds apiece.
  jest.setTimeout(600_000);

  it.each(ZONES)('TZ=%j', (zone) => {
    const run = spawnSync(
      process.execPath,
      [JEST, '--config', 'jest.config.borrowed.cjs', '--runInBand', '--testPathPattern', 'rust_run\\.unit', '-t', 'in any process zone'],
      { cwd: PACKAGE, env: { ...process.env, TZ: zone }, encoding: 'utf8' },
    );
    const summary = /Tests: +(?:(\d+) failed, )?.*?(\d+) passed/.exec(run.stderr);
    expect([zone, run.status, summary?.[1] ?? '0']).toEqual([zone, 0, '0']);
    expect(Number(summary?.[2])).toBeGreaterThanOrEqual(2);
  });
});
