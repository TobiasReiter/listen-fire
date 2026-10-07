// Version 1's engine corpus tests ruled out: each asserted an internal shape
// that has since been refactored, with no difference an author can observe
// through validate, run, story or MCP output. Anything an author could observe
// is a version conditional instead, never an entry here.
// `file` is relative to this directory; `test` is the test's (or describe's)
// own title.
const NODE_FIELD_ORDER =
  "hand-built synthesised node: a synthesised node now carries its fields' declaration order (`fieldOrder`), which this test's literal binding predates; runs build it themselves, so no movement observes the difference";

const FILE_DESCRIPTOR =
  "asserts the parked FileRef's byte-channel closure is rebound on rehydrate; a FileRef is now a descriptor that parks and rehydrates as it stands, its bytes redeemed on the host when something reads them, so a resumed run reads the same file and no movement observes the difference";

exports.triage = [
  {
    file: 'services/movement_engine/__test__/serialize.unit.test.ts',
    test: "resource's FileRef has its retrieve() rebound (closure does not survive the wire)",
    reason: FILE_DESCRIPTOR,
  },
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
];
