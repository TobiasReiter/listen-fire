// On this branch the v3 corpus is its own pre-merge copy (35cd3a3ea8) of the version-3 tests, adapted to the host interface exactly as v1/v2 were carried.
// Language version 3's conformance corpus: the movement-lang tests as they
// stood before version 4 — on this branch, main's b3078e0053 (v0.10.9) tests as
// cloud-native carried them onto the Rust parser (35cd3a3ea8, the last commit
// before the merge that brought version 4; three files differ from main's),
// verbatim under `__conformance__/v3/`, run against the current code under
// language version 3. A failure is a version-3 behaviour the current code no longer
// preserves. The corpus files are never edited; a test that asserted a
// since-refactored internal shape is listed in `__conformance__/v3/triage.cjs`.
// Run via `pnpm test:conformance:v3` in this package.
const path = require('path');
const borrowed = require('./jest.config.borrowed.cjs');

const [tsJest, tsJestOptions] = borrowed.transform['^.+\\.tsx?$'];

module.exports = {
  ...borrowed,
  testMatch: ['<rootDir>/__conformance__/v3/**/*.unit.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  resolver: path.join(__dirname, 'conformance/resolver.cjs'),
  setupFilesAfterEnv: [
    path.join(__dirname, 'conformance/v3.setup.cjs'),
    path.join(__dirname, 'conformance/triage.setup.cjs'),
  ],
  // The corpus is typed against its own commit's tree, not today's: transpile only.
  transform: { '^.+\\.tsx?$': [tsJest, { ...tsJestOptions, isolatedModules: true }] },
};
