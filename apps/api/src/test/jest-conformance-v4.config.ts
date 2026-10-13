// On this branch the v4 corpus is its own pre-merge copy (c39a99d6) of the version-4 tests, carried verbatim.
// Language version 4's conformance corpus for the engine: the movement_engine
// unit tests as they stood before version 5 — on this branch, cloud-native's
// own live tests at c39a99d6 (the last commit before the merge that brought
// version 5), verbatim under `src/__conformance__/v4/` at the positions they
// had there — run against the current code under language version 4
// ("Luminous Owl"). A failure is a version-4 behaviour the current code no
// longer preserves. The corpus files are never edited; a test that asserted a
// since-refactored internal shape is listed in
// `src/__conformance__/v4/triage.cjs`. The resolver and setup files are
// movement-lang's — one mechanism for every corpus. Run via
// `pnpm test:conformance:v4`.
import path from 'node:path';

import unitConfig from './jest-unit.config';

const CONFORMANCE = path.resolve(__dirname, '../../../../packages/movement-lang/conformance');
const HARVEST = 'src/services/movement_engine/conformance/harvest';

// eslint-disable-next-line local-rules/bottom-exports
export default {
  ...unitConfig,
  // The binding × consumer matrix is not a corpus: it is written against
  // today's tree and runs under every supported version, skipping the cells
  // whose syntax version 4 does not have.
  testMatch: [
    '<rootDir>/src/__conformance__/v4/**/*.unit.test.ts',
    '<rootDir>/src/services/movement_engine/__test__/binding_consumer_matrix.unit.test.ts',
  ],
  testPathIgnorePatterns: ['/node_modules/'],
  resolver: path.join(CONFORMANCE, 'resolver.cjs'),
  setupFilesAfterEnv: [
    path.join(CONFORMANCE, 'v4.setup.cjs'),
    path.join(CONFORMANCE, 'triage.setup.cjs'),
    '<rootDir>/src/test/movement_lang_source.setup.ts',
    // Hands the corpus's version to every evaluation its context omits.
    '<rootDir>/src/test/conformance_pin.setup.ts',
    // Under MOVEMENT_ENGINE=rust: count the Rust evaluator's answers, and
    // fail a run in which it answered none.
    '<rootDir>/src/test/rust_eval_stats.setup.ts',
    // Under UPDATE_ENGINE_RUNS=1: record every entry into the engine as a
    // host recording, folded into movement_engine/conformance/__fixtures__/
    // engine-runs.<version>.json by the teardown. Inert otherwise.
    `<rootDir>/${HARVEST}/record.setup.cjs`,
  ],
  // The Rust evaluator's counts, and the host-recording harvest, chained.
  globalSetup: `<rootDir>/${HARVEST}/global_setup.cjs`,
  globalTeardown: `<rootDir>/${HARVEST}/teardown.cjs`,
  // The corpus is typed against its own commit's tree, not today's: transpile only.
  transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }] },
};
