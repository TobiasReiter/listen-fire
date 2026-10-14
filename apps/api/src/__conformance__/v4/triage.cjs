// Version 4's engine corpus tests ruled out: each asserted an internal shape
// that has since been refactored, with no difference an author can observe
// through validate, run, story or MCP output. Anything an author could observe
// is a version conditional instead, never an entry here.
// `file` is relative to this directory; `test` is the test's (or describe's)
// own title. On this branch the corpus is cloud-native's own live tests at
// c39a99d6 (the last commit before the merge that brought version 5), whose
// run.unit.test.ts already says the result's write record carries no `old`
// (B1), so main's entry for its stale copy has no test to name here.
const UNSUPPORTED_SITES = 'services/movement_engine/__test__/interpretable_unsupported_sites.unit.test.ts';
const SOURCE_SCAN =
  "reads the engine's and checker's SOURCE files by a path relative to where the test sits, which inside the corpus names no file; it audits the code's own registry of unsupported sites, not anything a version-4 movement does";

const GRAPH_SPREAD_RECORD =
  "pinned the run failing at the spread of a map that holds a record into a graph; since B3 (MOV_GRAPH_SPREAD_RECORD) the checker refuses that program where it is written, on every language version — a bug fix: the program failed on every run that reached the spread, now it fails its check first. The current tree's copy of this test pins the refusal";

const BODY_CLOSURE_PARK_FORMAT =
  'body closures park their scope by reference (61a58921); the park format is not language semantics';

exports.triage = [
  { file: UNSUPPORTED_SITES, test: 'only the registered files throw it', reason: SOURCE_SCAN },
  { file: UNSUPPORTED_SITES, test: 'expression.ts: the registry lists exactly the call sites in the file', reason: SOURCE_SCAN },
  { file: UNSUPPORTED_SITES, test: 'run.ts: the registry lists exactly the call sites in the file', reason: SOURCE_SCAN },
  { file: UNSUPPORTED_SITES, test: 'a checker cover names diagnostic codes the checker really has', reason: SOURCE_SCAN },
  { file: 'services/movement_engine/__test__/list_literal_record.unit.test.ts', test: 'with no shape: an engine error naming the key, never the record stored as a field', reason: GRAPH_SPREAD_RECORD },
  { file: 'services/movement_engine/__test__/list_literal_record.unit.test.ts', test: 'with a shape declaring the key a child, holding records by key: the same engine error', reason: GRAPH_SPREAD_RECORD },
  { file: 'services/movement_engine/__test__/call_value.unit.test.ts', test: 'parks with the closure in scope — its body as AST, its capture as bindings', reason: BODY_CLOSURE_PARK_FORMAT },
];
