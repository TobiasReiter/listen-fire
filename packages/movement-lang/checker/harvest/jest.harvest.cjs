// Runs one test corpus with ./harvest.setup.cjs recording every program
// checked. HARVEST_CORPUS picks the corpus — `v1`, `v2` (the conformance
// corpora, under their own language version) or `current` (this package's own
// tests, under the current version); HARVEST_OUT names the JSON lines file to
// append to. ./build_fixture.cjs folds the output into the checks fixture.
// From packages/movement-lang:
//
//   HARVEST_CORPUS=v1 HARVEST_OUT=/tmp/checks.jsonl \
//     node ../../apps/api/node_modules/jest/bin/jest.js \
//     --config checker/harvest/jest.harvest.cjs
const path = require('path');

const PACKAGE = path.resolve(__dirname, '../..');
const CONFIGS = {
  v1: 'jest.conformance.v1.cjs',
  v2: 'jest.conformance.v2.cjs',
  current: 'jest.config.borrowed.cjs',
};

const corpus = process.env.HARVEST_CORPUS;
if (!corpus || !(corpus in CONFIGS)) {
  throw new Error(`HARVEST_CORPUS must be one of ${Object.keys(CONFIGS).join(', ')}`);
}
const base = require(path.join(PACKAGE, CONFIGS[corpus]));

module.exports = {
  ...base,
  rootDir: PACKAGE,
  // The regression replays the fixture this run rebuilds; a stale fixture
  // must not fail the harvest that is about to replace it.
  testPathIgnorePatterns: [...(base.testPathIgnorePatterns ?? []), '/checker/__test__/checks_regression'],
  setupFilesAfterEnv: [...(base.setupFilesAfterEnv ?? []), path.join(__dirname, 'harvest.setup.cjs')],
};
