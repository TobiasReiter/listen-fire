// Version 3's corpus tests ruled out: each asserted an internal shape that has
// since been refactored, a reworded message, or a fact about the release rather
// than the language — none a difference in what a valid version-3 movement
// does. Anything that changes what a movement does is a version conditional
// instead, never an entry here.
// `file` is relative to this directory; `test` is the test's (or describe's)
// own title.
const VERSIONS = 'checker/__test__/language_version.unit.test.ts';
const RELEASE_TABLE =
  "the release's version table (which versions exist, which is current, how a newer one is named), not version 3's behaviour; a release with version 4 in it says otherwise, and no movement observes it";

const HAND_BUILT_FILE =
  "hand-built file (PLAN-07A Task 4d): the test hands TEXT.SERIALISE a plain object literal spelling a file (`__brand: 'FileRef'`), which the serialiser once printed as a file by its keys; a file is now only one the engine made at an envelope that declares one, so a dict carrying those keys prints as the dict it is. A run's files are the engine's own, so no movement observes the difference";

exports.triage = [
  { file: VERSIONS, test: 'names each integer once; the current version is the newest and supported', reason: RELEASE_TABLE },
  { file: VERSIONS, test: 'a version outside the supported set is an error naming it and the fix', reason: RELEASE_TABLE },
  { file: VERSIONS, test: 'the default release is this one', reason: RELEASE_TABLE },
  { file: 'expression/__test__/stdlib.unit.test.ts', test: 'a file is a descriptor, never its contents', reason: HAND_BUILT_FILE },
];
