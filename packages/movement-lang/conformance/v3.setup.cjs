// Runs a conformance corpus under language version 3 ("Steady Lynx", the
// language from v0.10.0 until version 4). Every parse, check, story and run that
// names no version compiles and executes under the current version, so making
// the current version 3 puts the whole verbatim corpus under 3 without
// touching a fixture.
const path = require('path');

const LANGUAGE_VERSION = path.resolve(__dirname, '../language_version.ts');

jest.mock(LANGUAGE_VERSION, () => ({
  ...jest.requireActual(LANGUAGE_VERSION),
  CURRENT_LANGUAGE_VERSION: 3,
}));
