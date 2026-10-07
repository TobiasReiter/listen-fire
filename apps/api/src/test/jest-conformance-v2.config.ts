// Language version 2's conformance corpus for the engine: the movement_engine
// unit tests as they stood on the last commit before version 3 (78d6893ddb),
// verbatim under `src/__conformance__/v2/`, run against the current code under
// language version 2 ("Bright Otter"). A failure is a version-2 behaviour the
// current code no longer preserves. The corpus files are never edited; a test
// that asserted a since-refactored internal shape is listed in
// `src/__conformance__/v2/triage.cjs`. The resolver and setup files are
// movement-lang's — one mechanism for every corpus. Run via
// `pnpm test:conformance:v2`.
import path from 'path';

import unitConfig from './jest-unit.config';

const CONFORMANCE = path.resolve(__dirname, '../../../../packages/movement-lang/conformance');

// eslint-disable-next-line local-rules/bottom-exports
export default {
  ...unitConfig,
  testMatch: ['<rootDir>/src/__conformance__/v2/**/*.unit.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  resolver: path.join(CONFORMANCE, 'resolver.cjs'),
  setupFilesAfterEnv: [
    path.join(CONFORMANCE, 'v2.setup.cjs'),
    path.join(CONFORMANCE, 'triage.setup.cjs'),
    // Under MOVEMENT_ENGINE=rust: count the Rust evaluator's answers, and
    // fail a run in which it answered none.
    '<rootDir>/src/test/rust_eval_stats.setup.ts',
  ],
  globalSetup: '<rootDir>/src/test/rust_eval_stats.global-setup.cjs',
  globalTeardown: '<rootDir>/src/test/rust_eval_stats.teardown.cjs',
  // The corpus is typed against its own commit's tree, not today's: transpile only.
  transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }] },
};
