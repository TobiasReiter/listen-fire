// Version 4's corpus tests ruled out: each asserted an internal shape that has
// since been refactored, a reworded message, or a fact about the release rather
// than the language — none a difference in what a valid version-4 movement
// does. Anything that changes what a movement does is a version conditional
// instead, never an entry here.
// `file` is relative to this directory; `test` is the test's (or describe's)
// own title.
const VERSIONS = 'checker/__test__/language_version.unit.test.ts';
const RELEASE_TABLE =
  "the release's version table (which versions exist, which is current), not version 4's behaviour; a release with version 5 in it says otherwise, and no movement observes it";

const FILE_RULE_B5 =
  "pinned as accepted the plugin arguments of a declared value type that a file reached (`tag(label: f)`, `tag(label: { a: f })`, `ocr(doc: { a: f })`), each handing the plugin the engine's description of the file; since B5 they are refused on every language version (a bug fix, as the structured-data argument's rule already was). Its other rows run under the current release's versions, 5 among them, where a file joined into a text is MOV_FILE_IN_TEXT; under 1 to 4 it is still accepted, pinned by the current tree's file_in_field_value test, which also carries this block's closed conditional row";

exports.triage = [
  { file: VERSIONS, test: 'names each integer once; the current version is the newest and supported', reason: RELEASE_TABLE },
  { file: VERSIONS, test: 'the default release is this one', reason: RELEASE_TABLE },
  { file: 'checker/__test__/file_in_field_value.unit.test.ts', test: 'KNOWN GAP: under language version %i, a file the field rule does not reach', reason: FILE_RULE_B5 },
];
