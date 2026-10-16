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
const SYSTEM_IS_ITS_ADDRESS =
  "pinned that two instances constructed the same way (the same adapter, credential and arguments) are two graphs; since B12 a system is its address, not the name a file binds it to, so a record of one passes to a parameter typed by the other (in one file or across a file import) and the effect row lists the system once. A refusal turned into an acceptance — no movement that validated under this version does anything different (the rule of 8c9ee246: a refusal relaxed is never gated). The current tree's tests pin both halves with two different credentials";

// A table over the current release's versions runs a version 5 row in the
// spelling this corpus was written in; only that row is ruled out.
const WRITTEN_IN_V4 = "written in the v4 surface; version 5 respells it — the v5 behaviour is held by the rewritten current suites";
const VERSION_5_ROW = (row) => (Array.isArray(row) ? row[0] : row) === 5;

exports.triage = [
  { file: VERSIONS, test: 'names each integer once; the current version is the newest and supported', reason: RELEASE_TABLE },
  { file: VERSIONS, test: 'a version outside the supported set is an error naming it and the fix', reason: RELEASE_TABLE },
  { file: VERSIONS, test: 'the default release is this one', reason: RELEASE_TABLE },
  { file: 'expression/__test__/stdlib.unit.test.ts', test: 'a file is a descriptor, never its contents', reason: HAND_BUILT_FILE },
  { file: 'checker/__test__/check_typed.unit.test.ts', test: 'MOV_CALL_ARG_TYPE across two instances of the same adapter — a parameter is typed against ITS instance', reason: SYSTEM_IS_ITS_ADDRESS },
  { file: 'checker/__test__/effect_row.unit.test.ts', test: 'two instances of the SAME adapter are two entries — identity is the graph, not the adapter', reason: SYSTEM_IS_ITS_ADDRESS },
  { file: 'checker/__test__/effect_row.unit.test.ts', test: 'the entry IS the graph token the type checker compares by, not the spelling', reason: SYSTEM_IS_ITS_ADDRESS },
  { file: 'checker/__test__/one_grammar_rulings.unit.test.ts', test: 'a bare walk is its landings in any value position (version %d)', rows: VERSION_5_ROW, reason: WRITTEN_IN_V4 },
];
