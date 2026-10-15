// Version 1's engine corpus tests ruled out: each asserted an internal shape
// that has since been refactored, with no difference an author can observe
// through validate, run, story or MCP output. Anything an author could observe
// is a version conditional instead, never an entry here.
// `file` is relative to this directory; `test` is the test's (or describe's)
// own title. An entry `{ file, wholeFile: true, reason }` (no `test`) rules out
// a file that cannot load; the jest config leaves it unopened.
const RUN_HOST_CORE =
  "mocks hosted resume modules the shared run-host core replaced (packages/movement-engine/services/run_host); the await/resume behaviour is now held by the run-host contract suite, run against both the Postgres and SQLite backends, so no movement observes the difference";

const NODE_FIELD_ORDER =
  "hand-built synthesised node: a synthesised node now carries its fields' declaration order (`fieldOrder`), which this test's literal binding predates; runs build it themselves, so no movement observes the difference";

const FILE_DESCRIPTOR =
  "asserts the parked FileRef's byte-channel closure is rebound on rehydrate; a FileRef is now a descriptor that parks and rehydrates as it stands, its bytes redeemed on the host when something reads them, so a resumed run reads the same file and no movement observes the difference";

const HAND_BUILT_RECORD_IN_VALUE =
  "hand-built record inside a value: the test writes the records a value holds as plain object literals, which the engine once recognised by their shape; it now recognises only the objects it made itself, so a data payload can never be read as one. A run only ever holds records the engine made, so no movement observes the difference";

const FILE_IDENTITY =
  "object identity of an adapter's descriptor (PLAN-07A Task 4d): the engine now makes its own file from the descriptor the adapter answered at a field the catalog types `file`, so the file written onward is an equal file, not the adapter's very object. What a movement writes is unchanged, and no movement observes object identity";

const HAND_BUILT_FILE =
  "hand-built file (PLAN-07A Task 4d): the test binds a file as a plain object literal spelling a descriptor (`__brand: 'FileRef'`), which the engine once recognised by its keys; a file is now only what an envelope declares one (a field the catalog types `file`, a resource's `fileRef`, a plugin output's declared file, a parked `file`), so a data payload can never be read as one. A run reads its files from such a field, so no movement observes the difference";

const HAND_BUILT_STORE =
  "a hand-built document store (PLAN-07A Task 4d fix round 1): the test's fake store predates the store's own key reader (`keyOf`), which every read and ownership check now goes through, so the store reads one key per URI and a file is the team's on that same reading; the real stores carry it, so no movement observes the difference";

const BODY_CLOSURE_PARK_FORMAT =
  'body closures park their scope by reference (61a58921); the park format is not language semantics';

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
  { file: 'services/movement_engine/__test__/serialize.unit.test.ts', test: "a MAP's answer of extract roots comes back as extract roots, children and all", reason: HAND_BUILT_RECORD_IN_VALUE },
  { file: 'services/movement_engine/__test__/serialize.unit.test.ts', test: "a GROUPBY's dict of records keeps each group's records", reason: HAND_BUILT_RECORD_IN_VALUE },
  { file: "services/movement_engine/__test__/call_value.unit.test.ts", test: "the callee's bindings ARE the value: FileRef identity and source provenance survive the call", reason: FILE_IDENTITY },
  { file: "services/movement_engine/__test__/chunks_builtin.unit.test.ts", test: "a file nothing could read yields no pieces, not a failure", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/chunks_builtin.unit.test.ts", test: "keeps the file among the origins — a piece still came from the attachment", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/chunks_builtin.unit.test.ts", test: "reads the attachment, cuts its text, and traces both", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/extraction-file.unit.test.ts", test: "an OCR-empty file contributes NO extraction text but STILL a FILE resource (carry-forward)", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/extraction-file.unit.test.ts", test: "attaches the source FILE as a node resource (Layer 5 provenance) carrying the live FileRef", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/extraction-file.unit.test.ts", test: "bounds ONE file's text in the prompt, and says so — to the model and on the trace", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/extraction-file.unit.test.ts", test: "counts what a readable file contributed", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/extraction-file.unit.test.ts", test: "de-duplicates the same attachment — text is extracted once even if the file appears twice", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/extraction-file.unit.test.ts", test: "exercises the scanned/OCR path — text from the resolver still reaches the extractor", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/extraction-file.unit.test.ts", test: "feeds the extractor the file TEXT (not a stringified handle) and stamps a file provenance origin", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/extraction-file.unit.test.ts", test: "names the file it could not read on the trace, even when the extraction is skipped for want of any source", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/extraction-file.unit.test.ts", test: "raises the ceiling from the environment", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/extraction-file.unit.test.ts", test: "reports the unreadable file on the call it still made from the text source", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/extraction.unit.test.ts", test: "an OCR-EMPTY source file still becomes a node resource AND carries forward to a file field", reason: FILE_IDENTITY },
  { file: "services/movement_engine/__test__/extraction.unit.test.ts", test: "persists the source file as node resources AND writes it to a file field with the FileRef intact", reason: FILE_IDENTITY },
  { file: "services/movement_engine/__test__/extraction.unit.test.ts", test: "the WHERE is a real expression — resource fields and AND compose", reason: FILE_IDENTITY },
  { file: "services/movement_engine/__test__/extraction.unit.test.ts", test: "the documented `type == \"FILE\"` filter form selects ONLY the file resource", reason: FILE_IDENTITY },
  { file: "services/movement_engine/__test__/node_synthesis.unit.test.ts", test: "a FileRef entry reaches the callee as the SAME handle — nothing materialises", reason: FILE_IDENTITY },
  { file: "services/movement_engine/__test__/node_synthesis.unit.test.ts", test: "a lazy edge hands the source FileRef to a callee that writes it onward", reason: FILE_IDENTITY },
  { file: "services/movement_engine/__test__/node_synthesis.unit.test.ts", test: "the callee reads the MAPPING’s names and writes the source’s own FileRef onward", reason: FILE_IDENTITY },
  { file: "services/movement_engine/__test__/node_synthesis.unit.test.ts", test: "the eager form closes it too — same landings, walked at the literal", reason: FILE_IDENTITY },
  { file: "services/movement_engine/__test__/node_synthesis.unit.test.ts", test: "the eager form maps at the literal — same landings, walked once", reason: FILE_IDENTITY },
  { file: "services/movement_engine/__test__/read_builtin.unit.test.ts", test: "a file nothing could read is ABSENT, with the reason and detail on the trace", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/read_builtin.unit.test.ts", test: "an empty file says `no_text` rather than answering with nothing silently", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/read_builtin.unit.test.ts", test: "answers with the file text and records what it read on the trace", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/read_builtin.unit.test.ts", test: "carries a `file` provenance origin — rawTextId, handle and all", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/read_builtin.unit.test.ts", test: "extracts from the file text, and the call still sees the file origin", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/read_builtin.unit.test.ts", test: "no seam in scope fails loud — \"nothing can read it\" is not \"it had no text\"", reason: HAND_BUILT_FILE },
  { file: "services/movement_engine/__test__/stdlib_file.unit.test.ts", test: "captures the artifact ref and the deterministic stdlib values", reason: HAND_BUILT_STORE },
  { file: "services/movement_engine/__test__/stdlib_file.unit.test.ts", test: "streams text/plain bytes that are the digest verbatim", reason: HAND_BUILT_STORE },
  { file: 'services/movement_engine/__test__/call_value.unit.test.ts', test: 'parks with the closure in scope — its body as AST, its capture as bindings', reason: BODY_CLOSURE_PARK_FORMAT },
  { file: 'services/movement_engine/__test__/await_resume.unit.test.ts', wholeFile: true, reason: RUN_HOST_CORE },
];
