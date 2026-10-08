// The conformance teardown's routing floor applies to a run of the whole
// corpus only: every way jest has of running part of it is narrowing. And a
// run that admitted something yet ran nothing whole fails, floor or not.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface Teardown {
  (globalConfig: object | undefined, projectConfig: object | undefined): Promise<void>;
  isWholeCorpus(globalConfig: object | undefined): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const teardown: Teardown = require('../rust_eval_stats.teardown.cjs');

describe('the routing floor', () => {
  it('applies to a run of the whole corpus', () => {
    expect(teardown.isWholeCorpus({ testPathPattern: '', nonFlagArgs: [], findRelatedTests: false, onlyChanged: false })).toBe(true);
  });

  it.each([
    ['a path pattern', { testPathPattern: 'refs' }],
    ['a name pattern', { testNamePattern: 'parks' }],
    ['related tests', { findRelatedTests: true }],
    ['changed files', { onlyChanged: true }],
    ['changes since a ref', { changedSince: 'main' }],
    ['the last commit', { lastCommit: true }],
    ['failures only', { onlyFailures: true }],
    ['a shard', { shard: { shardIndex: 1, shardCount: 2 } }],
    ['positional paths', { nonFlagArgs: ['refs.unit'] }],
  ])('does not apply to a run narrowed by %s', (_why, narrowed) => {
    expect(teardown.isWholeCorpus({ nonFlagArgs: [], ...narrowed })).toBe(false);
  });
});

describe('the teardown', () => {
  const saved = { engine: process.env.MOVEMENT_ENGINE, dir: process.env.MOVEMENT_RUST_EVAL_STATS_DIR };
  afterEach(() => {
    for (const [key, value] of [['MOVEMENT_ENGINE', saved.engine], ['MOVEMENT_RUST_EVAL_STATS_DIR', saved.dir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.restoreAllMocks();
  });

  /** The teardown of a v2 run narrowed to some files, over one file's stats. */
  function tearDownWith(runs: { routed: number; admitted: number; ranWhole: number }) {
    const dir = mkdtempSync(path.join(tmpdir(), 'rust-stats-'));
    const stats = { notAdmitted: 0, admitted: 1, answered: 1, fallback: {}, runs: { ...runs, shimFaults: 0, notAdmitted: {}, declined: {}, hostCalls: {} }, file: 'x.unit.test.ts' };
    writeFileSync(path.join(dir, '1.jsonl'), `${JSON.stringify(stats)}\n`);
    process.env.MOVEMENT_ENGINE = 'rust';
    process.env.MOVEMENT_RUST_EVAL_STATS_DIR = dir;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    return teardown({ testPathPattern: 'some', nonFlagArgs: [] }, { testMatch: ['**/__conformance__/v2/**/*.test.ts'] });
  }

  it('fails a run that admitted runs and ran none whole', async () => {
    await expect(tearDownWith({ routed: 4, admitted: 3, ranWhole: 0 })).rejects.toThrow(
      'MOVEMENT_ENGINE=rust routing regression (v2): 3 runs were admitted and none ran whole',
    );
  });

  it('passes a narrowed run that admitted nothing, below the floor', async () => {
    await expect(tearDownWith({ routed: 4, admitted: 0, ranWhole: 0 })).resolves.toBeUndefined();
  });
});
