// Version 4's engine corpus tests ruled out: each asserted an internal shape
// that has since been refactored, with no difference an author can observe
// through validate, run, story or MCP output. Anything an author could observe
// is a version conditional instead, never an entry here.
// `file` is relative to this directory; `test` is the test's (or describe's)
// own title.
const UNSUPPORTED_SITES = 'services/movement_engine/__test__/interpretable_unsupported_sites.unit.test.ts';
const SOURCE_SCAN =
  "reads the engine's and checker's SOURCE files by a path relative to where the test sits, which inside the corpus names no file; it audits the code's own registry of unsupported sites, not anything a version-4 movement does";

const RESULT_WRITE_RECORD_OLD =
  "asserted the run result's write record carried the engine's own `old` handle; since 1ac170cf (B1) the handle keeps `old` while the run lasts and the result is assembled without it. `-[:@old]->` reads the same, so no movement observes the difference (the test was stale at the corpus's own commit)";

exports.triage = [
  { file: UNSUPPORTED_SITES, test: 'only the registered files throw it', reason: SOURCE_SCAN },
  { file: UNSUPPORTED_SITES, test: 'expression.ts: the registry lists exactly the call sites in the file', reason: SOURCE_SCAN },
  { file: UNSUPPORTED_SITES, test: 'run.ts: the registry lists exactly the call sites in the file', reason: SOURCE_SCAN },
  { file: UNSUPPORTED_SITES, test: 'a checker cover names diagnostic codes the checker really has', reason: SOURCE_SCAN },
  { file: 'services/movement_engine/__test__/run.unit.test.ts', test: 'creates on first run, updates the resolved candidate on the second', reason: RESULT_WRITE_RECORD_OLD },
];
