// On this branch the v4 corpus is its own pre-merge copy (c39a99d6) of the version-4 tests, adapted to the host interface exactly as v1-v3 were carried.
// Language version 4's conformance corpus: the movement-lang tests as they
// stood before version 5 — on this branch, cloud-native's own live tests at
// c39a99d6 (the last commit before the merge that brought version 5; five
// files differ from main's 3d9665b6df copy), verbatim under `__conformance__/v4/`, run against the current code under language
// version 4. A failure is a version-4 behaviour the current code no longer
// preserves. The corpus files are never edited; a test that asserted a
// since-refactored internal shape is listed in `__conformance__/v4/triage.cjs`.
// Run via `pnpm test:conformance:v4` in this package.
const path = require('path');
const borrowed = require('./jest.config.borrowed.cjs');

const [tsJest, tsJestOptions] = borrowed.transform['^.+\\.tsx?$'];

module.exports = {
  ...borrowed,
  testMatch: ['<rootDir>/__conformance__/v4/**/*.unit.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  resolver: path.join(__dirname, 'conformance/resolver.cjs'),
  setupFilesAfterEnv: [
    path.join(__dirname, 'conformance/v4.setup.cjs'),
    path.join(__dirname, 'conformance/triage.setup.cjs'),
  ],
  // The corpus is typed against its own commit's tree, not today's: transpile only.
  transform: { '^.+\\.tsx?$': [tsJest, { ...tsJestOptions, isolatedModules: true }] },
};
