// The conformance teardown's routing floor applies to a run of the whole
// corpus only: every way jest has of running part of it is narrowing. And a
// run that admitted something yet ran nothing whole fails, floor or not. Its
// ceilings apply to every run, narrowed or whole: a class over its ceiling
// fails it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface Ceilings {
  refused: number;
  everyReason: Record<string, number>;
  declined: Record<string, number>;
  unreproduced: number;
  shimFaults: number;
  handBacks: { 'builtins.function': number; 'builtins.compare': number; fallback: number };
}

interface Teardown {
  (globalConfig: object | undefined, projectConfig: object | undefined): Promise<void>;
  isWholeCorpus(globalConfig: object | undefined): boolean;
  CEILINGS: Record<'v1' | 'v2' | 'v3', Ceilings>;
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
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['MOVEMENT_ENGINE', saved.engine], ['MOVEMENT_RUST_EVAL_STATS_DIR', saved.dir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.restoreAllMocks();
  });

  /** The teardown of a v2 run narrowed to some files, over one file's stats. */
  function tearDownWith(
    runs: { routed: number; admitted: number; ranWhole: number; mirroredFailure?: number; unreproduced?: number; endedAtCheck?: number },
    reasons: {
      notAdmitted?: Record<string, number>;
      allReasons?: Record<string, number>;
      declined?: Record<string, number>;
      hostCalls?: Record<string, number>;
      fallback?: Record<string, number>;
    } = {},
  ) {
    const dir = mkdtempSync(path.join(tmpdir(), 'rust-stats-'));
    made.push(dir);
    const { fallback = {}, ...counts } = reasons;
    const stats = { notAdmitted: 0, admitted: 1, answered: 1, fallback, runs: { ...runs, shimFaults: 0, notAdmitted: {}, allReasons: {}, declined: {}, hostCalls: {}, ...counts }, file: 'x.unit.test.ts' };
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

  it('prints the runs not admitted by first reason, then by every reason each holds', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await tearDownWith(
      { routed: 3, admitted: 0, ranWhole: 0 },
      { notAdmitted: { statement_call: 2, name_not_value: 1 }, allReasons: { name_not_value: 3, statement_call: 2, block_park: 1 } },
      // Printed whatever the ceilings then say of these reasons.
    ).catch(() => undefined);
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toContain('Rust runs not admitted: {"statement_call":2,"name_not_value":1}');
    expect(lines).toContain('Rust runs not admitted, every reason: {"name_not_value":3,"statement_call":2,"block_park":1}');
  });

  it('prints every run with its denominator: ran whole N of M attempted, and how each other ended', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await tearDownWith(
      { routed: 9, admitted: 7, ranWhole: 4, mirroredFailure: 2, unreproduced: 1, endedAtCheck: 1 },
      { notAdmitted: { statement_call: 2, event_does_not_cross: 1 }, declined: { condition_does_not_lower: 1 } },
      // The line is printed whatever the ceilings then say of these counts.
    ).catch(() => undefined);
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toContain(
      'Rust runs, ran whole 4 of 12 runs attempted (3 refused at admission by name, 2 ended in the TypeScript\'s own failure by name, mirrored, 1 unreproduced mid-run, 1 declined, 1 failed their check before a segment opened, 0 shim faults)',
    );
  });

  describe('the ceilings', () => {
    const { v2 } = teardown.CEILINGS;
    const atCeiling = {
      notAdmitted: { statement_call: v2.refused },
      allReasons: v2.everyReason,
      declined: v2.declined,
      hostCalls: { 'builtins.function': v2.handBacks['builtins.function'], 'builtins.compare': v2.handBacks['builtins.compare'] },
      fallback: { a_reason: v2.handBacks.fallback },
    };

    it('passes every class at its ceiling, and prints each against it', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await expect(tearDownWith({ routed: 2, admitted: 1, ranWhole: 1 }, atCeiling)).resolves.toBeUndefined();
      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines).toContain(`Rust ceiling (v2): refused ${v2.refused} (ceiling ${v2.refused})`);
      expect(lines).toContain('Rust ceiling (v2): unreproduced 0 (ceiling 0)');
    });

    it.each([
      ['a run refused past the ceiling', { notAdmitted: { statement_call: v2.refused + 1 } }, `refused ${v2.refused + 1} > ${v2.refused}`],
      ['a reason no ceiling names', { allReasons: { a_new_reason: 1 } }, 'everyReason a_new_reason 1 > 0'],
      ['a decline no ceiling names', { declined: { condition_does_not_lower: 1 } }, 'declined condition_does_not_lower 1 > 0'],
      ['one more builtins.function hand-back', { hostCalls: { 'builtins.function': v2.handBacks['builtins.function'] + 1 } }, 'handBacks builtins.function'],
      ['one more evaluator fallback', { fallback: { a_reason: v2.handBacks.fallback + 1 } }, 'handBacks fallback'],
    ])('fails %s', async (_why, past, named) => {
      await expect(tearDownWith({ routed: 2, admitted: 1, ranWhole: 1 }, { ...atCeiling, ...past })).rejects.toThrow(named);
    });

    it('fails any run that ended unreproduced: a divergence', async () => {
      await expect(tearDownWith({ routed: 2, admitted: 2, ranWhole: 1, unreproduced: 1 })).rejects.toThrow('unreproduced 1 > 0');
    });

    it('allows a mirrored failure and a check ending', async () => {
      await expect(tearDownWith({ routed: 3, admitted: 3, ranWhole: 1, mirroredFailure: 2, endedAtCheck: 4 })).resolves.toBeUndefined();
    });
  });
});
