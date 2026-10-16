// The tests that read dates in "this process's zone" (rust_run),
// run once per zone: jest hands every suite a copy of the environment, so a
// test assigning `TZ` moves no clock, and a process's zone is fixed when it
// starts. Each zone is a jest of its own, `TZ` set: the IANA zones the shim
// hands the Rust engine (both engines then read a date text alike), and the
// `TZ` values whose zone `Intl` cannot name as `Date` reads it (the run is
// refused by name, never diverges).

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const API = path.resolve(__dirname, '../../../..');
const JEST = path.join(API, 'node_modules/jest/bin/jest.js');

/** Each `TZ`, and whether `Intl` names the zone `Date` reads in. */
const ZONES: Array<[string, 'named' | 'unverified']> = [
  ['UTC', 'named'], ['Europe/London', 'named'], ['America/New_York', 'named'], ['Asia/Kolkata', 'named'], ['Pacific/Apia', 'named'],
  // Intl names none of these, or names Etc/Unknown (""): tried as UTC.
  ['utc', 'named'], ['Utc', 'named'], ['', 'named'],
  // Intl names them itself: UTC, UTC, +00:00.
  ['Etc/UTC', 'named'], ['Zulu', 'named'], ['GMT', 'named'],
  // Intl says +03:00 where Date reads three hours west; names none for UTC+3.
  ['GMT+3', 'unverified'], ['UTC+3', 'unverified'],
];

describe("the date tests, in each process's zone", () => {
  // Nested runs: each is a jest of the suite, a few seconds apiece.
  jest.setTimeout(600_000);

  it.each(ZONES)('TZ=%j: %s', (zone, expected) => {
    const run = spawnSync(
      process.execPath,
      [JEST, '--config', 'src/test/jest-unit.config.ts', '--runInBand', '--testPathPattern', 'rust_run\\.unit', '-t', "in this process's zone"],
      { cwd: API, env: { ...process.env, TZ: zone, EXPECT_LOCAL_ZONE: expected }, encoding: 'utf8' },
    );
    const summary = /Tests: +(?:(\d+) failed, )?.*?(\d+) passed/.exec(run.stderr);
    expect([zone, run.status, summary?.[1] ?? '0']).toEqual([zone, 0, '0']);
    expect(Number(summary?.[2])).toBeGreaterThanOrEqual(3);
  });
});
