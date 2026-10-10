// Version 3's engine corpus tests ruled out: each asserted an internal shape
// that has since been refactored, with no difference an author can observe
// through validate, run, story or MCP output. Anything an author could observe
// is a version conditional instead, never an entry here.
// `file` is relative to this directory; `test` is the test's (or describe's)
// own title.
const UNSUPPORTED_SITES = 'services/movement_engine/__test__/interpretable_unsupported_sites.unit.test.ts';
const SOURCE_SCAN =
  "reads the engine's and checker's SOURCE files by a path relative to where the test sits, which inside the corpus names no file; it audits the code's own registry of unsupported sites, not anything a version-3 movement does";

exports.triage = [
  { file: UNSUPPORTED_SITES, test: 'only the registered files throw it', reason: SOURCE_SCAN },
  { file: UNSUPPORTED_SITES, test: 'expression.ts: the registry lists exactly the call sites in the file', reason: SOURCE_SCAN },
  { file: UNSUPPORTED_SITES, test: 'run.ts: the registry lists exactly the call sites in the file', reason: SOURCE_SCAN },
  { file: UNSUPPORTED_SITES, test: 'a checker cover names diagnostic codes the checker really has', reason: SOURCE_SCAN },
];
