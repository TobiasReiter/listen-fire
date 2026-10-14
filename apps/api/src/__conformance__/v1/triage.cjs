// Version 1's engine corpus tests ruled out: each asserted an internal shape
// that has since been refactored, with no difference an author can observe
// through validate, run, story or MCP output. Anything an author could observe
// is a version conditional instead, never an entry here.
// `file` is relative to this directory; `test` is the test's (or describe's)
// own title.
const NODE_FIELD_ORDER =
  "hand-built synthesised node: a synthesised node now carries its fields' declaration order (`fieldOrder`), which this test's literal binding predates; runs build it themselves, so no movement observes the difference";

const HAND_BUILT_RECORD_IN_VALUE =
  "hand-built record inside a value: the test writes the records a value holds as plain object literals, which the engine once recognised by their shape; it now recognises only the objects it made itself, so a data payload can never be read as one. A run only ever holds records the engine made, so no movement observes the difference";

const BODY_CLOSURE_PARK_FORMAT =
  'body closures park their scope by reference (61a58921); the park format is not language semantics';

exports.triage = [
  {
    file: 'services/movement_engine/__test__/serialize.unit.test.ts',
    test: 'a synthesised node keeps its entries and its LANDED edges',
    reason: NODE_FIELD_ORDER,
  },
  {
    file: 'services/movement_engine/__test__/local_edge_adapter.unit.test.ts',
    test: 'an update merges into the matched landing in place',
    reason: NODE_FIELD_ORDER,
  },
  { file: 'services/movement_engine/__test__/serialize.unit.test.ts', test: "a MAP's answer of extract roots comes back as extract roots, children and all", reason: HAND_BUILT_RECORD_IN_VALUE },
  { file: 'services/movement_engine/__test__/serialize.unit.test.ts', test: "a GROUPBY's dict of records keeps each group's records", reason: HAND_BUILT_RECORD_IN_VALUE },
  { file: 'services/movement_engine/__test__/call_value.unit.test.ts', test: 'parks with the closure in scope — its body as AST, its capture as bindings', reason: BODY_CLOSURE_PARK_FORMAT },
];
