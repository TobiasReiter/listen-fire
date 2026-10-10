// Runs a conformance corpus under language version 1 ("Quiet Heron", the
// language as of v0.6.0). Every parse, check, story and run that names no
// version compiles and executes under the current version, so making the
// current version 1 puts the whole verbatim corpus under 1 without touching a
// fixture.
const path = require('path');
const { assertSourcesResolve } = require('./source_tripwire.cjs');

assertSourcesResolve(require.resolve);

const LANGUAGE_VERSION = path.resolve(__dirname, '../language_version.ts');

jest.mock(LANGUAGE_VERSION, () => ({
  ...jest.requireActual(LANGUAGE_VERSION),
  CURRENT_LANGUAGE_VERSION: 1,
}));
