// The conformance teardown's routing floor applies to a run of the whole
// corpus only: every way jest has of running part of it is narrowing.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const teardown: { isWholeCorpus(globalConfig: object | undefined): boolean } = require('../rust_eval_stats.teardown.cjs');

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
