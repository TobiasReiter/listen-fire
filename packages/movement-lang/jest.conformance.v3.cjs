// Language version 3's conformance corpus: the movement-lang tests as they
// stood at b3078e0053 (v0.10.9, the last commit before version 4), verbatim
// under `__conformance__/v3/`, run against the current code under language
// version 3. A failure is a version-3 behaviour the current code no longer
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
