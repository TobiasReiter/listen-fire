// On this branch the v3 corpus is its own pre-merge copy (35cd3a3ea8) of the version-3 tests, adapted to the host interface exactly as v1/v2 were carried.
// Language version 3's conformance corpus for the engine: the movement_engine
// unit tests as they stood before version 4 — on this branch, main's
// b3078e0053 (v0.10.9) tests as cloud-native carried them onto the host
// boundary (35cd3a3ea8, the last commit before the merge that brought version
// 4), verbatim under `src/__conformance__/v3/` at the positions they had there
// — run against the current code under language version 3 ("Steady Lynx"). A
// failure is a version-3 behaviour the current code no longer preserves. The
// corpus files are never edited; a test that asserted a since-refactored
// internal shape is listed in `src/__conformance__/v3/triage.cjs`. The resolver
// and setup files are movement-lang's — one mechanism for every corpus. Run via
// `pnpm test:conformance:v3`.
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ignoredPaths } = require('../../../../packages/movement-lang/conformance/triage_files.cjs');
import unitConfig from './jest-unit.config';

const CONFORMANCE = path.resolve(__dirname, '../../../../packages/movement-lang/conformance');
const HARVEST = 'src/services/movement_engine/conformance/harvest';

// eslint-disable-next-line local-rules/bottom-exports
export default {
  ...unitConfig,
  // The binding × consumer matrix is not a corpus: it is written against
  // today's tree and runs under every supported version, skipping the cells
  // whose syntax version 3 does not have.
  testMatch: [
    '<rootDir>/src/__conformance__/v3/**/*.unit.test.ts',
    '<rootDir>/src/services/movement_engine/__test__/binding_consumer_matrix.unit.test.ts',
  ],
  testPathIgnorePatterns: ['/node_modules/', ...ignoredPaths(path.resolve(__dirname, '../__conformance__/v3'))],
  resolver: path.join(CONFORMANCE, 'resolver.cjs'),
  setupFilesAfterEnv: [
    path.join(CONFORMANCE, 'v3.setup.cjs'),
    path.join(CONFORMANCE, 'triage.setup.cjs'),
    '<rootDir>/src/test/movement_lang_source.setup.ts',
    // Hands the corpus's version to every evaluation its context omits.
    '<rootDir>/src/test/conformance_pin.setup.ts',
    // Under UPDATE_ENGINE_RUNS=1: record every entry into the engine as a
    // host recording, folded into movement_engine/conformance/__fixtures__/
    // engine-runs.<version>.json by the teardown. Inert otherwise.
    `<rootDir>/${HARVEST}/record.setup.cjs`,
  ],
  // The host-recording harvest.
  globalSetup: `<rootDir>/${HARVEST}/global_setup.cjs`,
  globalTeardown: `<rootDir>/${HARVEST}/teardown.cjs`,
  // The corpus is typed against its own commit's tree, not today's: transpile only.
  transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }] },
};
