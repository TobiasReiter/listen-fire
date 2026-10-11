// Version 3's engine corpus tests ruled out: each asserted an internal shape
// that has since been refactored, with no difference an author can observe
// through validate, run, story or MCP output. Anything an author could observe
// is a version conditional instead, never an entry here.
// `file` is relative to this directory; `test` is the test's (or describe's)
// own title.
const UNSUPPORTED_SITES = 'services/movement_engine/__test__/interpretable_unsupported_sites.unit.test.ts';
const SOURCE_SCAN =
  "reads the engine's and checker's SOURCE files by a path relative to where the test sits, which inside the corpus names no file; it audits the code's own registry of unsupported sites, not anything a version-3 movement does";

const HAND_BUILT_RECORD_IN_VALUE =
  "hand-built record inside a value: the test writes the records a value holds as plain object literals, which the engine once recognised by their shape; it now recognises only the objects it made itself, so a data payload can never be read as one. A run only ever holds records the engine made, so no movement observes the difference";

exports.triage = [
  { file: UNSUPPORTED_SITES, test: 'only the registered files throw it', reason: SOURCE_SCAN },
  { file: UNSUPPORTED_SITES, test: 'expression.ts: the registry lists exactly the call sites in the file', reason: SOURCE_SCAN },
  { file: UNSUPPORTED_SITES, test: 'run.ts: the registry lists exactly the call sites in the file', reason: SOURCE_SCAN },
  { file: UNSUPPORTED_SITES, test: 'a checker cover names diagnostic codes the checker really has', reason: SOURCE_SCAN },
  { file: 'services/movement_engine/__test__/serialize.unit.test.ts', test: "a MAP's answer of extract roots comes back as extract roots, children and all", reason: HAND_BUILT_RECORD_IN_VALUE },
  { file: 'services/movement_engine/__test__/serialize.unit.test.ts', test: "a GROUPBY's dict of records keeps each group's records", reason: HAND_BUILT_RECORD_IN_VALUE },
  { file: 'services/movement_engine/__test__/serialize.unit.test.ts', test: 'a file beside records, and a file in a synthesised record, both come back readable', reason: HAND_BUILT_RECORD_IN_VALUE },
];
