// Runs one test corpus with ./harvest.setup.cjs recording every whole program
// parsed. HARVEST_CORPUS picks the corpus — `v1`, `v2`, `v3` (the conformance
// corpora, under their own language version) or `current` (this package's own
// tests, under the current version); HARVEST_OUT names the JSON lines file to
// append to. ./build_fixture.cjs folds the output into the programs fixture.
// From packages/movement-lang:
//
//   HARVEST_CORPUS=v1 HARVEST_OUT=/tmp/programs.jsonl \
//     node ../../apps/api/node_modules/jest/bin/jest.js \
//     --config parser/harvest/jest.harvest.cjs
const path = require('path');

const PACKAGE = path.resolve(__dirname, '../..');
const CONFIGS = {
  v1: 'jest.conformance.v1.cjs',
  v2: 'jest.conformance.v2.cjs',
  v3: 'jest.conformance.v3.cjs',
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
  setupFilesAfterEnv: [...(base.setupFilesAfterEnv ?? []), path.join(__dirname, 'harvest.setup.cjs')],
};
