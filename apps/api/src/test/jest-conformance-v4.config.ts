// Language version 4's conformance corpus for the engine: the movement_engine
// unit tests as they stood at 3d9665b6df (the last commit before
// version 5), verbatim under `src/__conformance__/v4/`, run against the current
// code under language version 4 ("Luminous Owl"). A failure is a version-4
// behaviour the current code no longer preserves. The corpus files are never
// edited; a test that asserted a since-refactored internal shape is listed in
// `src/__conformance__/v4/triage.cjs`. The resolver and setup files are
// movement-lang's — one mechanism for every corpus. Run via
// `pnpm test:conformance:v4`.
import path from 'path';

import unitConfig from './jest-unit.config';

const CONFORMANCE = path.resolve(__dirname, '../../../../packages/movement-lang/conformance');

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
  ],
  // The corpus is typed against its own commit's tree, not today's: transpile only.
  transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }] },
};
