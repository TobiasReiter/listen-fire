// On this branch the v4 corpus is its own pre-merge copy (c39a99d6) of the version-4 tests, adapted to the host interface exactly as v1-v3 were carried.
// Runs a conformance corpus under language version 4 ("Luminous Owl", the
// language from v0.11.0 until version 5). Every parse, check, story and run that
// names no version compiles and executes under the current version, so making
// the current version 4 puts the whole verbatim corpus under 4 without
// touching a fixture.
const path = require('path');
const { assertSourcesResolve } = require('./source_tripwire.cjs');

assertSourcesResolve(require.resolve);

const LANGUAGE_VERSION = path.resolve(__dirname, '../language_version.ts');

jest.mock(LANGUAGE_VERSION, () => ({
  ...jest.requireActual(LANGUAGE_VERSION),
  CURRENT_LANGUAGE_VERSION: 4,
}));
