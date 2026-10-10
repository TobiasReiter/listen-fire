// Runs a conformance corpus under language version 2 ("Bright Otter", the
// language from v0.7.0 until version 3). Every parse, check, story and run that
// names no version compiles and executes under the current version, so making
// the current version 2 puts the whole verbatim corpus under 2 without
// touching a fixture.
const path = require('path');
const { assertSourcesResolve } = require('./source_tripwire.cjs');

assertSourcesResolve(require.resolve);

const LANGUAGE_VERSION = path.resolve(__dirname, '../language_version.ts');

jest.mock(LANGUAGE_VERSION, () => ({
  ...jest.requireActual(LANGUAGE_VERSION),
  CURRENT_LANGUAGE_VERSION: 2,
}));
