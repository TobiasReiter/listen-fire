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

const SYSTEM_IS_ITS_ADDRESS =
  "pinned that two instances constructed the same way (the same adapter, credential and arguments) are two graphs; since B12 a system is its address, not the name a file binds it to, so a record of one passes to a parameter typed by the other (in one file or across a file import) and the effect row lists the system once. A refusal turned into an acceptance — no movement that validated under this version does anything different (the rule of 8c9ee246: a refusal relaxed is never gated). The current tree's tests pin both halves with two different credentials";

const RECEIPT_RECORD = "pinned as accepted a `parallel` receipt whose literal arm returns a record, written into a json field — the engine's own handle object written as data (`{\"kind\":\"handle\",…}` on TypeScript, null under 3 and 4). Since the receipt-records fix a receipt holds what its arms return, as `[a(), b()]` does, and the field rule refuses it on every language version (a bug fix: the form always leaked an engine object). The current tree's record_in_field_value and receipt_record_in_field tests pin the refusal; arms built at run time stay accepted, pinned by the same block. The same block's 'arms built at run time' example is a MAP of closures, which the follow-up fix (a named arm list or a MAP of closures types the receipt) now refuses too";

const PARALLEL_RETIRED_ROW =
  "a table over the current release's versions, and its version 5 row writes `await parallel(arms)`: `parallel` is retired under Dancing Wren (5) (MOV_PARALLEL_RETIRED — MAP over the functions, calling each, is the join), a version 5 rule, not a version 4 behaviour. Its rows under 3 and 4 still check clean, pinned by the current tree's record_in_field_value test, which checks the version 5 row as the retirement's rewrite (`MAP(arms, { concurrency: 2 }, (f) => f())`) and finds it clean too";

// A table over the current release's versions runs a version 5 row in the
// spelling this corpus was written in; only that row is ruled out.
const WRITTEN_IN_V4 = "written in the v4 surface; version 5 respells it — the v5 behaviour is held by the rewritten current suites";
const VERSION_5_ROW = (row) => (Array.isArray(row) ? row[0] : row) === 5;

const EXTRACT_KEYWORD_V5_ROW =
  "a table over the current release's versions whose version 5 row extracts with the retired `extract from [...] { ... }` keyword (MOV_EXTRACT_KEYWORD_RETIRED from 5 on; `extract(content, Shape)` replaces it) and writes the v4 surface; a version 5 rule, not this version's behaviour. Its rows under 1 to 4 still run; the v5 behaviour is held by the current tree's absent_equality_and_conditions suite";

exports.triage = [
  { file: VERSIONS, test: 'names each integer once; the current version is the newest and supported', reason: RELEASE_TABLE },
  { file: VERSIONS, test: 'the default release is this one', reason: RELEASE_TABLE },
  { file: 'checker/__test__/record_in_field_value.unit.test.ts', test: 'under language version %i, a literal arm: accepted today', reason: RECEIPT_RECORD },
  { file: 'checker/__test__/record_in_field_value.unit.test.ts', test: 'under language version %i, arms built at run time: accepted today', reason: RECEIPT_RECORD },
  { file: 'checker/__test__/file_in_field_value.unit.test.ts', test: 'KNOWN GAP: under language version %i, a file the field rule does not reach', reason: FILE_RULE_B5 },
  { file: 'checker/__test__/record_in_field_value.unit.test.ts', test: 'under language version %i, an awaited one writes under a key', reason: PARALLEL_RETIRED_ROW },
  { file: 'checker/__test__/check_typed.unit.test.ts', test: 'MOV_CALL_ARG_TYPE across two instances of the same adapter — a parameter is typed against ITS instance', reason: SYSTEM_IS_ITS_ADDRESS },
  { file: 'checker/__test__/effect_row.unit.test.ts', test: 'two instances of the SAME adapter are two entries — identity is the graph, not the adapter', reason: SYSTEM_IS_ITS_ADDRESS },
  { file: 'checker/__test__/effect_row.unit.test.ts', test: 'the entry IS the graph token the type checker compares by, not the spelling', reason: SYSTEM_IS_ITS_ADDRESS },
  { file: 'checker/__test__/one_grammar_rulings.unit.test.ts', test: 'a bare walk is its landings in any value position (version %d)', rows: VERSION_5_ROW, reason: WRITTEN_IN_V4 },
  { file: 'checker/__test__/record_in_field_value.unit.test.ts', test: "under language version %i, a record inside a field's value is refused", rows: VERSION_5_ROW, reason: WRITTEN_IN_V4 },
  { file: 'checker/__test__/record_in_field_value.unit.test.ts', test: 'under language version %i', rows: VERSION_5_ROW, reason: WRITTEN_IN_V4 },
  { file: 'checker/__test__/record_in_field_value.unit.test.ts', test: "under language version %i, a record inside a plugin argument's value is refused", rows: VERSION_5_ROW, reason: WRITTEN_IN_V4 },
  { file: 'checker/__test__/record_in_field_value.unit.test.ts', test: 'under language version %i, a conditional of a record and a map', rows: VERSION_5_ROW, reason: WRITTEN_IN_V4 },
  { file: 'checker/__test__/file_in_field_value.unit.test.ts', test: "under language version %i, a file inside a field's value is refused", rows: VERSION_5_ROW, reason: WRITTEN_IN_V4 },
  { file: 'checker/__test__/file_in_field_value.unit.test.ts', test: 'under language version %i, a file field takes a file and never a record', rows: VERSION_5_ROW, reason: WRITTEN_IN_V4 },
  { file: 'checker/__test__/file_in_field_value.unit.test.ts', test: 'under language version %i', rows: VERSION_5_ROW, reason: WRITTEN_IN_V4 },
  { file: 'checker/__test__/file_in_field_value.unit.test.ts', test: 'under language version %i, a record\'s file field, spread', rows: VERSION_5_ROW, reason: WRITTEN_IN_V4 },
  { file: 'checker/__test__/file_in_field_value.unit.test.ts', test: "under language version %i, a file in a plugin's structured argument is refused", rows: VERSION_5_ROW, reason: WRITTEN_IN_V4 },
  { file: 'checker/__test__/absent_equality_and_conditions.unit.test.ts', test: 'under language version %s', rows: VERSION_5_ROW, reason: EXTRACT_KEYWORD_V5_ROW },
];
