// Language version 1's conformance corpus for the engine: v0.6.0's own
// movement_engine unit tests, verbatim under `src/__conformance__/v1/`, run
// against the current code under language version 1 ("Quiet Heron"). A
// failure is a v0.6.0 behaviour the current code no longer preserves. The
// corpus files are never edited; a test that asserted a since-refactored
// internal shape is listed in `src/__conformance__/v1/triage.cjs`. The
// resolver and setup files are movement-lang's — one mechanism for every
// corpus. Run via `pnpm test:conformance:v1`.
import path from "node:path";

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
  // whose syntax version 1 does not have.
  testMatch: [
    '<rootDir>/src/__conformance__/v1/**/*.unit.test.ts',
    '<rootDir>/src/services/movement_engine/__test__/binding_consumer_matrix.unit.test.ts',
  ],
  testPathIgnorePatterns: ['/node_modules/', ...ignoredPaths(path.resolve(__dirname, '../__conformance__/v1'))],
  resolver: path.join(CONFORMANCE, 'resolver.cjs'),
  setupFilesAfterEnv: [
    path.join(CONFORMANCE, 'v1.setup.cjs'),
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
  // The corpus is typed against v0.6.0's tree, not today's: transpile only.
  transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }] },
};
