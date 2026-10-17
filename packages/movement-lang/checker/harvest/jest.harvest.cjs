// Runs one test corpus with ./harvest.setup.cjs recording every program
// checked. HARVEST_CORPUS picks the corpus — `v1` to `v4` (this package's
// conformance corpora, under their own language version), `current` (this
// package's own tests, under the current version), `api-v4` (the engine's
// version-4 conformance corpus in apps/api), `api-current` (the engine's tests
// that need the platform, in apps/api, under the current version) or `engine`
// (the engine package's own tests), or `readers` / `engine-readers` (below);
// HARVEST_OUT names the JSON
// lines file to append to. ./build_fixture.cjs folds the output into the
// checks pin; ./harvest.sh runs every corpus and the fold. From
// packages/movement-lang:
//
//   HARVEST_CORPUS=v1 HARVEST_OUT=/tmp/checks.jsonl \
//     node ../../apps/api/node_modules/jest/bin/jest.js \
//     --config checker/harvest/jest.harvest.cjs
const path = require('path');

const PACKAGE = path.resolve(__dirname, '../..');
const API = path.resolve(PACKAGE, '../../apps/api');
const ENGINE = path.resolve(PACKAGE, '../movement-engine');
// The engine's tests reach the checker through the program check, so every
// program they check (with the catalog it was checked against) is harvested
// the same way as this package's.
const ENGINE_TESTS = '<rootDir>/src/services/movement_engine/**/*.unit.test.ts';
const CORPORA = {
  v1: { root: PACKAGE, config: 'jest.conformance.v1.cjs' },
  v2: { root: PACKAGE, config: 'jest.conformance.v2.cjs' },
  v3: { root: PACKAGE, config: 'jest.conformance.v3.cjs' },
  v4: { root: PACKAGE, config: 'jest.conformance.v4.cjs' },
  current: { root: PACKAGE, config: 'jest.config.borrowed.cjs' },
  'api-v4': { root: API, config: 'src/test/jest-conformance-v4.config.ts' },
  'api-current': { root: API, config: 'src/test/jest-unit.config.ts', testMatch: [ENGINE_TESTS] },
  engine: { root: ENGINE, config: 'jest.config.borrowed.cjs', testMatch: ['<rootDir>/services/**/*.unit.test.ts'] },
  // The tests that read the assembled corpus (CHECKS_CORPUS=1) and check
  // programs of their own made from it: the upgrade loop's rewrites and the
  // engine oracles' programs respelled to version 5. ./harvest.sh runs them
  // second, over the corpus the first pass assembled.
  readers: { root: PACKAGE, config: 'jest.config.borrowed.cjs', testMatch: ['<rootDir>/checker/__test__/upgrade_corpus.unit.test.ts'] },
  'engine-readers': { root: ENGINE, config: 'jest.config.borrowed.cjs', testMatch: ['<rootDir>/services/movement_engine/__test__/reachability.unit.test.ts'] },
};

const corpus = process.env.HARVEST_CORPUS;
if (!corpus || !(corpus in CORPORA)) {
  throw new Error(`HARVEST_CORPUS must be one of ${Object.keys(CORPORA).join(', ')}`);
}
const { root, config, testMatch } = CORPORA[corpus];
if (config.endsWith('.ts')) {
  // apps/api writes its jest configs in TypeScript, which jest compiles only
  // for a config it is handed directly.
  require(path.join(API, 'node_modules/ts-node')).register({
    transpileOnly: true,
    compilerOptions: { module: 'commonjs', esModuleInterop: true },
  });
}
const loaded = require(path.join(root, config));
const base = loaded.default ?? loaded;

module.exports = {
  ...base,
  // A config's relative rootDir is relative to its own file, not this one.
  rootDir: root,
  ...(testMatch ? { testMatch } : {}),
  // The regression replays the fixture this run rebuilds; a stale fixture
  // must not fail the harvest that is about to replace it.
  testPathIgnorePatterns: [...(base.testPathIgnorePatterns ?? []), '/checker/__test__/checks_regression'],
  // First, so its mocks of the parser and checker are registered before any
  // other setup file loads movement-lang (the engine's version pin imports it,
  // which would otherwise cache the unrecorded checker for the whole file).
  setupFilesAfterEnv: [path.join(__dirname, 'harvest.setup.cjs'), ...(base.setupFilesAfterEnv ?? [])],
};
