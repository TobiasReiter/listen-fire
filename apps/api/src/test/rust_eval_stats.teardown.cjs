// The run's evaluator counts and whole-run counts, summed over every test
// file, printed; and a Rust run in which Rust answered nothing fails, because
// then the switch is off and the corpus proved nothing about the Rust engine.
const { existsSync, readdirSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');

// Routing floors, under MOVEMENT_ENGINE=rust: the fewest runs each corpus must
// run whole in Rust. They catch a routing regression (a change to the
// allow-list, a decline, a shim fault) that leaves every case green because
// the TypeScript engine quietly took the runs back. Raise them deliberately,
// with the slice that routes more; never lower one to make a run pass.
// Measured at slice 2b (2026-10-07): v1 69, v2 75. Raised to exactly those
// with chunk 5B's admission in Rust (2026-10-08), which proved it admits what
// the shim's old allow-list did, run for run: any run lost now is a
// regression. Raised to v1 87, v2 95 with traversal blocks over adapter edges
// (chunk 5B task 4, 2026-10-08), exactly the counts they route. Raised to
// v1 93, v2 101 with nested blocks and heads off a hop alias (chunk 5B task
// 5: hop_narrowing's six), then to v1 114, v2 136 with the record verbs in
// and out of blocks (match, link, unlink, delete, a target's WHERE, writes
// off a traversed record), then to v1 117, v2 139 with bound blocks. Chunk
// 6A Task 2 (file-level declarations, plugin imports and file-level values
// admitted, 2026-10-09) runs v1 119, v2 141 whole; the floors are those less
// a margin of 2, so they stay v1 117, v2 139: the declarations unmasked the
// body constructs behind them (the extraction keyword, declared entries,
// plugin calls) more than they admitted whole runs. Chunk 6A Task 3b (the
// extraction keyword and plugin calls run in Rust, 2026-10-09) runs v1 223,
// v2 268 whole; the floors are those less a margin of 2. Chunk 6A Task 4
// (folds, EXISTS, IS tests and a record named twice, 2026-10-09) runs v1 289,
// v2 352 whole; the floors are those less a margin of 2. Chunk 7A Task 1
// (admission walks only the movements the fired one reaches, and names every
// reason, 2026-10-09) runs v1 290, v2 353 whole: an unreached helper no
// longer refuses its file; the floors are those less a margin of 2. Chunk
// 7A Task 2 (calls to helper movements, the graphs a run builds, lazy walks,
// shaped graphs, 2026-10-09) runs v1 394, v2 469 whole (the binding x
// consumer matrix's admitted cells among them: 48 and 50); the floors are
// those less a margin of 2. Chunk 7A Task 3 (records held as values,
// collection ops and the writes, links and walks over any record,
// 2026-10-09) runs v1 1006, v2 1309 whole; the floors are those less a
// margin of 2. Chunk 7A Task 4 (awaits, parallel and race, parks anywhere
// and every park state resumed, 2026-10-10) runs v1 1060, v2 1363 whole;
// the floors are those less a margin of 2. On cloud-native the v3 corpus
// came with the main merge that brought language version 4 (2026-10-10),
// and that merge refuses a version-99 case by that name at admission
// (language_version_unsupported) rather than running it to the check's
// refusal. The forward merge of cloud-native into chunk 7A (2026-10-10)
// runs v1 1060, v2 1362 (its version-99 case refused by that name), v3 1918
// whole; the floors are those less a margin of 2. Chunk 7A Task 4b (host
// data never read as an engine object, 2026-10-11) runs the same v1 1060,
// v2 1362, v3 1918 whole (no corpus program held a binding-shaped dict);
// the floors stay those less a margin of 2. Chunk 7A Task 4c (language
// version 4's four changed constructs run, 2026-10-11) runs the same v1
// 1060, v2 1362, v3 1918 whole (the corpora are pinned to versions 1 to 3,
// which it leaves untouched); the floors stay those less a margin of 2.
// Chunk 7A Task 5b (V8's date parser mirrored, the local zone a run input,
// 2026-10-11) runs the same v1 1060, v2 1362, v3 1918 whole: no corpus
// program was refused or handed back for a date (no `builtin_arg_record`
// over a date member, no `builtins.function` request; the five
// `builtins.compare` requests left in v2 and v3 are WITHIN's); the floors
// stay those less a margin of 2. Chunk 7A Task 6 (the burn-down: meta keys,
// field functions, AI() and the tier table as run input, FILE/READ, IS of a
// system's record, records-output plugins and every plugin argument form,
// concurrent collection members, closures called by name, the extraction
// call, nested calls, member-path write roots, 2026-10-11) runs v1 1188, v2
// 1499, v3 2556 whole; the floors are those less a margin of 2. The second
// forward merge of cloud-native (main's fix: data is never read as an engine
// object, 2026-10-11) leaves v1 1188, v2 1499, v3 2556 whole; the floors stay
// those less a margin of 2. The third forward merge of cloud-native (main's
// rule: a record nested in a field's value or a plugin argument is refused at
// validate, 2026-10-11) leaves v1 1188, v2 1499, v3 2556 whole: every corpus
// case passes as before, so no corpus program's check changed, and the 24 v3
// runs refused as write_field_record are values admission cannot tell from
// records (a closure's record parameter, a graph built from a spread, an
// awaited receipt), not records the rule refuses; the floors stay those less
// a margin of 2. PLAN-07A Task 4d (a file is what the envelope declares, never
// a shape the data carries, 2026-10-11) leaves v1 1182, v2 1493, v3 2549
// whole: the drop is the triaged corpus cases that handed the engine a
// descriptor-shaped dict as a file (6 / 6 / 7 of them ran whole), skipped now,
// not runs Rust newly refuses; the floors are those less a margin of 2. Its fix
// round 1 (every byte read through a document the tenant owns or an instance
// the run holds; the store owns its key) leaves v1 1180, v2 1491, v3 2547: the
// drop is the two triaged stdlib_file cases per corpus whose hand-built store
// predates the store's key reader; the floors are those less a margin of 2. A floor
// applies to a run of the whole corpus only: a run narrowed to some files or
// cases checks the rest (nothing declined, no shim fault, something admitted
// ran whole) but not it. PLAN-07A Task 6b (admission reads the checker's
// types for parameters, calls and spreads) leaves v1 1180, v2 1491 and v3
// 2570 whole: v3's 23 more are closures' position parameters read field by
// field, closure, movement and extraction calls' values, MAPs, GROUPBY and
// MEMBERS of values, and map spreads of records; the floors are those less a
// margin of 2. Its fix round 1 counts a run that ends mid-run naming a
// construct the engine does not run (MOVENG_UNSUPPORTED) apart, as
// failedByName, not as ranWhole: v1 6, v2 6, v3 4, each a corpus case that
// pins that very failure on both engines (an unadvertised DOMAIN_OF, a
// file-level extraction, a callback with no sink, a recursive movement call,
// a value passed as a position argument). That leaves v1 1174, v2 1485, v3
// 2566 whole; the floors are those less a margin of 2. Chunk 7A Task 7 (the
// instrument made honest, 2026-10-11) checks a Rust-routed program before
// its segment opens, where the TypeScript route checks it, so a program
// that fails its check (MOVENG_PARSE, MOVENG_CHECK, MOVENG_LANGUAGE_VERSION)
// never reaches the Rust engine and is counted apart, `endedAtCheck`: v1
// 152, v2 236, v3 417. Before, the Rust engine parsed and admitted such a
// program and then asked for the check, whose failure counted as a run it
// ran whole. That leaves v1 1023, v2 1251, v3 2152 whole: ranWhole plus
// endedAtCheck is v1 1175, v2 1487, v3 2569, the old count plus the few
// check failures admission used to refuse first. No run the Rust engine
// ran is lost; the floor is re-based to what it measures (a run the engine
// ran), not lowered to pass: the floors are those less a margin of 2. The
// forward merge of main's file rule (a file nested in a field's value is
// refused at the check, 2026-10-12) moves no corpus run: v1 1023 of 1193,
// v2 1251 of 1514, v3 2152 of 2662, check endings 152 / 236 / 417 as
// before; the floors stay those less a margin of 2.
// PLAN-08A Task 1 fix round 1 (2026-10-12) drops the margin: floors and
// ceilings move together with the measurement; never a margin. With the
// ceilings at today's counts a margin would let two runs per corpus slip
// back to the TypeScript engine unseen, so the floors are the measured v1
// 1023, v2 1251, v3 2152, and a task that lifts runs raises them to its new
// measurement in the same commit. PLAN-08A Task 2 (admission reads what it
// knows, 2026-10-12) lifts v1 2, v2 2, v3 7 (a plugin argument's function
// call held to its returns, a head off a kept walk, the arms a MAP builds,
// a closure called in another letter case, a graph entry picking a walk's
// record): v1 1025, v2 1253, v3 2159. The merge of main's record walk
// (group G: the checker sees a record through COALESCE, IF, MULTI, a through
// stage and a map lookup, 2026-10-12) moved no corpus run on cloud-native.
// PLAN-08A group C, first part (a movement call nested in an expression runs
// as the binding it means, its callee walked under what it passes; a
// recursion hands back the value it declares, 2026-10-12) lifts v3 13: v3
// 2172. Its second part (a collection op and a built-in's call forms inside
// an expression, at the call's own place in its slot, stamped by the check;
// a returned block, 2026-10-12) lifts v3 32: v3 2204. PLAN-08A group D (a
// head of many hops, a `_resources` head, a pick of many hops, a hop off a
// kept walk, 2026-10-12) lifts v1 5, v2 7, v3 11: v1 1030, v2 1260, v3 2215.
// PLAN-08A group F (the file scope: an imported library's movements called
// in the library's own scope, its shapes' words and types read there; a
// shape declared in a body, and parked, 2026-10-12) lifts v2 7, v3 11: v2
// 1267, v3 2226. PLAN-08A group E (a shape-rooted write as the in-memory
// position it makes, a graph spread of a value's member, a delete of what a
// node's edge holds, 2026-10-12) lifts v1 1, v2 1, v3 6: v1 1031, v2 1268,
// v3 2232. PLAN-08A group F′ (CHUNKS; an extraction call's shape bound to
// another name, its in-place words read in the body; the registry's chat
// models as a run input; a call whose value a member access reads staged as
// the TypeScript stages it, 2026-10-12) lifts v1 3, v2 3, v3 7: v1 1034, v2
// 1271, v3 2239. PLAN-08A group F′ part 2 (a GROUPBY over records read as a
// map of lists of them, so `AT` over it reads a key, 2026-10-12) lifts v3 1:
// v3 2240. The merge of main's language version 5 (Dancing Wren, 2026-10-13)
// freezes version 4's corpus, this branch's own live tests at c39a99d6,
// measured at v4 2275. The merge of main's checker gaps (B3, a record in a map
// spread into a graph refused on every version, 2026-10-13) triages two
// list_literal_record tests in that frozen copy, whose programs the checker
// now refuses: v4 2273. The merge of main's body closures by reference
// (26467db3, 2026-10-14) triages one call_value test in every frozen copy
// ("parks with the closure in scope — its body as AST, its capture as
// bindings", BODY_CLOSURE_PARK_FORMAT: it pins the old snapshot park
// format), each the one run it parked: v1 1033, v2 1270, v3 2239, v4 2272.
// v5-extract (2026-10-16) refuses the extraction keyword on every version
// as `legacy_extraction` and deletes the Rust code that ran it, by ruling:
// those runs go to the TypeScript engine. Measured at e46730ca, v1 107, v2
// 147, v3 152, v4 157 runs are refused so; each corpus lost exactly that
// many, ran whole plus mirrored (v1 106 + 1, v2 146 + 1, v3 151 + 1, v4
// 156 + 1: one keyword run per corpus had ended in the TypeScript's own
// MOVENG_UNSUPPORTED). The floors fall by the runs that left ran whole: v1
// 1033 - 106 = 927, v2 1270 - 146 = 1124, v3 2239 - 151 = 2088, v4 2272 -
// 156 = 2116.
// A floor is measured, never guessed.
const RAN_WHOLE_FLOOR = { v1: 927, v2: 1124, v3: 2088, v4: 2116 };

// Ceilings, beside the floors (PLAN-08A Task 1, 2026-10-12): the most runs
// each corpus may end in each class that is not a run the Rust engine ran.
// Zero refusals is every ceiling at 0. Each starts at the count measured
// when it was set, and each later task LOWERS it as it closes a reason; a
// ceiling never rises. A reason a closed one used to hide inside the same
// statement (`allReasons` counts each statement's first) gets its own
// ceiling at its first measurement, then is lowered like the rest. A
// ceiling is an upper bound, so it holds for a run narrowed to part of the
// corpus too. The classes:
//
//   - `refused`: runs refused at admission by name, under each run's first
//     reason (`notAdmitted`, the shim's input checks among them), summed;
//   - `everyReason`: the same runs under each statement's first reason
//     (`allReasons`), by reason; a reason not named here has a ceiling of 0;
//   - `declined`: runs admitted and then declined before any effect, by
//     reason; a reason not named here has a ceiling of 0;
//   - `unreproduced`: runs that ended mid-run, after an effect, in this
//     engine's own refusal of what the TypeScript engine runs on through
//     (the `done`'s marker): a divergence, so 0 always;
//   - `shimFaults`: runs that ended in a fault of the shim's own: 0 always;
//   - `handBacks`: what a whole run still asks the TypeScript to compute,
//     by kind: `builtins.function` and `builtins.compare` host calls, and
//     `fallback`, expressions the evaluator switch handed back. Zero
//     refusals is not zero TypeScript until these are 0 too;
//   - `evaluatorNotAdmitted`: expressions the evaluator switch kept for the
//     TypeScript evaluator, never sent to Rust. They come mostly from the
//     runs the TypeScript engine runs, so this falls as refused runs fall;
//   - `mirroredFailure`: runs that ended mid-run in the TypeScript engine's
//     own MOVENG_UNSUPPORTED, which both engines end the run with: the same
//     ending, but each is a corpus case a port may change, so it is held
//     where it was measured.
//
// Reported and allowed: `endedAtCheck` (the run failed its check before a
// segment opened: nothing ran). `failedCheckMidRun` (the run passed its check,
// ran a segment, then failed `check.compatible`) is its own class, ceilinged
// at its measured value per corpus.
//
// Measured at 47109a3733 (2026-10-12): refused v1 12, v2 21, v3 86 (every
// reason 12 / 23 / 95); declined v3 3 (`expression_does_not_lower`);
// unreproduced 0 (the 6 / 6 / 4 runs once counted `failedByName` are all
// mirrored); shim faults 0; hand-backs `builtins.compare` 0 / 5 / 5 (WITHIN's),
// `builtins.function` 0, evaluator fallbacks 0; evaluator not admitted 84 /
// 102 / 591; mirrored failures 6 / 6 / 4. Lowered by PLAN-08A Task 2
// (2026-10-12) to its measurement: refused 10 / 19 / 79 (every reason 10 /
// 21 / 88: plugin_call_form, block_head_value_root, aggregate:only and
// function:inc retired, write_field_record 4 to 2, the two left Task 3's
// nested movement calls); evaluator not admitted 79 / 97 / 580. Group A
// (TypeScript's own failures mirrored) moved no corpus run: v2's and v3's
// statement:call runs call a function an import binds. Lowered by PLAN-08A
// group C's first part (2026-10-12): v3 refused 79 to 66 (nested_movement_call
// 15, movement_call 2 and write_field_record 2 retired). expression_closure
// is 15 where it was 14: one statement (`if double(2) == 4 AND
// COUNT(MAP([1], (v) => v)) == 1`) held both, and was counted under the
// nested movement call it met first; its collection op is the reason the
// closed one hid, so it carries that ceiling's first measurement. Lowered by
// group C's second part (2026-10-12): v3 refused 66 to 34 (builtin_call_form
// 16, expression_closure 15 and rvalue:block 2 retired; the
// write_field_record its MAP over a named closure exposed is retired with
// them); evaluator not admitted v3 580 to 276. Lowered by group D
// (2026-10-12): refused 10 / 19 / 34 to 5 / 12 / 23 (block_multi_hop 4 / 4 /
// 8 and block_head_resources 1 / 3 / 3 retired); evaluator not admitted 79 /
// 97 / 276 to 62 / 72 / 242 (the expressions inside the walks it admits).
// Lowered by group F (2026-10-12): refused v2 12 to 5, v3 23 to 12
// (import_from_file 7 / 7, statement:shape 4 and statement:call 2 / 2
// retired; extract_call_shape 2 to 1, the statement:shape run having held
// both); evaluator not admitted v2 72 to 62, v3 242 to 202. Lowered by
// group E (2026-10-12): refused 5 / 5 / 12 to 3 / 3 / 5 (write_root_not_held
// 2 / 2 / 2, node_spread_path 4 and delete_not_record 1 retired); evaluator
// not admitted 62 / 62 / 202 to 58 / 58 / 174. mirroredFailure is 7 / 7 / 5
// where it was 6 / 6 / 4: one corpus case per corpus (`unique by` on a shape
// write) was refused as write_root_not_held and now ends in the TypeScript's
// own MOVENG_UNSUPPORTED on both engines, which is that guard's ending; a
// refusal turned into the same ending as the TypeScript's takes its first
// measurement, as a reason a closed one hid does, and the refused-plus-
// mirrored total still falls (11 / 11 / 16 to 10 / 10 / 10). Lowered by
// group F′ (2026-10-12): refused 3 / 3 / 5 to 0 / 0 / 1 (function:chunks 3 /
// 3 / 3, extract_call_shape 1, extract_call_model 1 retired); declined v3
// expression_does_not_lower 3 to 0; evaluator not admitted 58 / 58 / 174 to
// 47 / 47 / 128. at_record_key v3 1 is a reason one of the closed declines
// hid (`AT(keyed, FIRST(x.entries).name)`, a KEYBY over what an extraction
// call answered inside a MAP's member, which admission's holders read as
// anything): it carries its first measurement, and the refused-plus-declined
// total falls 5 to 1. Lowered by group F′ part 2 (2026-10-12): refused v3 1
// to 0, at_record_key retired (the run's reason was the GROUPBY beside the
// KEYBY: `AT(grouped, …)` over a GROUPBY of records, which admission read as
// anything; it now reads a map of lists of records); evaluator not admitted
// v3 128 to 67 (that run's expressions, asked of the evaluator while the
// TypeScript ran it). The v5 probe's closings (2026-10-15): a WITHIN is
// compared in the Rust engine, measured from the host clock, so
// `builtins.compare` is no longer a request and its hand-backs are 0.
// v5-extract (2026-10-16) refuses the extraction keyword on every version
// as `legacy_extraction`, by ruling, so these rise by that name and no
// other, measured at e46730ca. refused: v1 0 to 107, v2 0 to 147, v3 0 to
// 152, v4 0 to 157, every one under `legacy_extraction` first.
// write_field_record v1 3, v2 5, v3 5, v4 10 is a reason those same runs
// hold beside the keyword (no run outside them names it): a reason the
// keyword hid, at its first measurement. evaluatorNotAdmitted: v1 47 to
// 425, v2 47 to 577, v3 67 to 605, v4 79 to 660. Counted test by test, the
// tests whose runs were not refused ask exactly the old 47 / 47 / 67 / 79;
// the rise, 378 / 530 / 538 / 581, is all inside the refused keyword runs,
// now run on the TypeScript engine, which asks the evaluator each of their
// expressions: in v1, 347 of the 378 are traversals (`traverse`), which
// the evaluator takes on no run. It falls as those runs are rewritten.
// mirroredFailure falls with the one keyword run per corpus that ended so:
// v1 7 to 6, v2 7 to 6, v3 5 to 4, v4 7 to 6.
const CEILINGS = {
  v1: {
    refused: 107,
    everyReason: { legacy_extraction: 107, write_field_record: 3 },
    declined: {},
    unreproduced: 0,
    failedCheckMidRun: 0,
    shimFaults: 0,
    handBacks: { 'builtins.function': 0, 'builtins.compare': 0, fallback: 0 },
    evaluatorNotAdmitted: 425,
    mirroredFailure: 6,
  },
  v2: {
    refused: 147,
    everyReason: { legacy_extraction: 147, write_field_record: 5 },
    declined: {},
    unreproduced: 0,
    failedCheckMidRun: 0,
    shimFaults: 0,
    handBacks: { 'builtins.function': 0, 'builtins.compare': 0, fallback: 0 },
    evaluatorNotAdmitted: 577,
    mirroredFailure: 6,
  },
  v3: {
    refused: 152,
    everyReason: { legacy_extraction: 152, write_field_record: 5 },
    declined: {},
    unreproduced: 0,
    failedCheckMidRun: 0,
    shimFaults: 0,
    handBacks: { 'builtins.function': 0, 'builtins.compare': 0, fallback: 0 },
    evaluatorNotAdmitted: 605,
    mirroredFailure: 4,
  },
  v4: {
    refused: 157,
    everyReason: { legacy_extraction: 157, write_field_record: 10 },
    declined: {},
    unreproduced: 0,
    failedCheckMidRun: 0,
    shimFaults: 0,
    handBacks: { 'builtins.function': 0, 'builtins.compare': 0, fallback: 0 },
    evaluatorNotAdmitted: 660,
    mirroredFailure: 6,
  },
};

/**
 * Whether this run is the whole corpus: no file or case filter, and none of
 * jest's other ways of running a part of it (related or changed files, a
 * shard, a rerun of failures, paths named on the command line).
 */
function isWholeCorpus(globalConfig) {
  if (globalConfig === undefined) return false;
  return (
    !globalConfig.testPathPattern
    && !globalConfig.testNamePattern
    && !globalConfig.findRelatedTests
    && !globalConfig.onlyChanged
    && !globalConfig.onlyFailures
    && !globalConfig.changedSince
    && !globalConfig.lastCommit
    && globalConfig.shard == null
    && (globalConfig.nonFlagArgs ?? []).length === 0
  );
}

/** `counts` largest first, for reading. */
function sorted(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));
}

/** Which corpus this run is, from its test match. */
function corpusOf(projectConfig) {
  const match = (projectConfig?.testMatch ?? []).join(' ');
  if (match.includes('__conformance__/v1')) return 'v1';
  if (match.includes('__conformance__/v2')) return 'v2';
  if (match.includes('__conformance__/v3')) return 'v3';
  if (match.includes('__conformance__/v4')) return 'v4';
  return undefined;
}

async function globalTeardown(globalConfig, projectConfig) {
  const dir = process.env.MOVEMENT_RUST_EVAL_STATS_DIR;
  if (process.env.MOVEMENT_ENGINE !== 'rust' || dir === undefined || !existsSync(dir)) return;
  const total = { notAdmitted: 0, admitted: 0, answered: 0, fallback: {} };
  const runs = { routed: 0, admitted: 0, ranWhole: 0, mirroredFailure: 0, unreproduced: 0, shimFaults: 0, endedAtCheck: 0, failedCheckMidRun: 0, notAdmitted: {}, allReasons: {}, declined: {}, hostCalls: {} };
  // The admission dry run asks only about runs MOVEMENT_ENGINE kept from
  // Rust: under rust, it must have asked about none.
  const dryRun = { firings: 0, sampled: 0 };
  const byFile = {};
  const refusedByFile = {};
  const add = (into, from) => {
    for (const [key, count] of Object.entries(from ?? {})) into[key] = (into[key] ?? 0) + count;
  };
  for (const file of readdirSync(dir)) {
    for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean)) {
      const stats = JSON.parse(line);
      total.notAdmitted += stats.notAdmitted;
      total.admitted += stats.admitted;
      total.answered += stats.answered;
      add(total.fallback, stats.fallback);
      runs.routed += stats.runs?.routed ?? 0;
      runs.admitted += stats.runs?.admitted ?? 0;
      runs.ranWhole += stats.runs?.ranWhole ?? 0;
      runs.shimFaults += stats.runs?.shimFaults ?? 0;
      runs.mirroredFailure += stats.runs?.mirroredFailure ?? 0;
      runs.unreproduced += stats.runs?.unreproduced ?? 0;
      runs.endedAtCheck += stats.runs?.endedAtCheck ?? 0;
      runs.failedCheckMidRun += stats.runs?.failedCheckMidRun ?? 0;
      if ((stats.runs?.ranWhole ?? 0) > 0 && stats.file) byFile[stats.file] = (byFile[stats.file] ?? 0) + stats.runs.ranWhole;
      add(runs.notAdmitted, stats.runs?.notAdmitted);
      add(runs.allReasons, stats.runs?.allReasons);
      if (Object.keys(stats.runs?.notAdmitted ?? {}).length > 0 && stats.file) add((refusedByFile[stats.file] ??= {}), stats.runs.notAdmitted);
      add(runs.declined, stats.runs?.declined);
      add(runs.hostCalls, stats.runs?.hostCalls);
      dryRun.firings += stats.runs?.dryRun?.firings ?? 0;
      dryRun.sampled += stats.runs?.dryRun?.sampled ?? 0;
    }
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`\nRust evaluator: ${JSON.stringify(total)}`);
  // Routed: segments the Rust engine started, its own admission's refusals
  // among them. Admitted: those its admission let by.
  console.log(`Rust runs: ${JSON.stringify({ runsRouted: runs.routed, runsAdmitted: runs.admitted, ranWhole: runs.ranWhole, mirroredFailure: runs.mirroredFailure, unreproduced: runs.unreproduced, shimFaults: runs.shimFaults, endedAtCheck: runs.endedAtCheck, failedCheckMidRun: runs.failedCheckMidRun, declined: runs.declined, hostCalls: runs.hostCalls })}`);
  // Every count with its denominator: each run the Rust route was entered
  // for ends in exactly one of these.
  console.log(`Rust runs, ${ranWholeOf(runs)}`);
  // Why every run that did not run in Rust ran on the TypeScript engine: the
  // shim's input checks and the engine's own admission, by reason.
  console.log(`Rust runs not admitted: ${JSON.stringify(sorted(runs.notAdmitted))}`);
  // The same runs under every reason each holds: what the first reason hides.
  console.log(`Rust runs not admitted, every reason: ${JSON.stringify(sorted(runs.allReasons))}`);
  console.log(`Admission dry runs (none under rust): ${JSON.stringify(dryRun)}`);
  // Which files' runs the Rust engine ran whole, for a report.
  if (process.env.MOVEMENT_RUST_RUNS_BY_FILE === '1') {
    console.log(`Rust runs by file: ${JSON.stringify(byFile)}`);
    // And why each file's other runs went to the TypeScript engine.
    console.log(`Rust runs not admitted by file: ${JSON.stringify(refusedByFile)}`);
  }
  if (total.answered === 0) {
    throw new Error('MOVEMENT_ENGINE=rust, and the Rust evaluator answered no expression in the whole run');
  }
  const corpus = corpusOf(projectConfig);
  if (corpus === undefined) return;
  const failures = [];
  if (runs.admitted > 0 && runs.ranWhole === 0) failures.push(`${runs.admitted} runs were admitted and none ran whole`);
  // A slot this engine's lowering misses and the check passes is declined
  // after the check (chunk 7A Task 6): the lowering's coverage, named. Any
  // other decline is a regression.
  const declined = Object.fromEntries(Object.entries(runs.declined).filter(([reason]) => !LOWERING_MISSES.includes(reason)));
  if (Object.keys(declined).length > 0) failures.push(`the corpus expects no declines but the lowering's misses, and these happened: ${JSON.stringify(declined)}`);
  if (runs.shimFaults > 0) failures.push(`${runs.shimFaults} runs ended in a shim fault`);
  // A corpus frozen before its counts were measured (v4 at the merge of
  // version 5) has no floor or ceilings yet: a whole run fails naming what it
  // measured, so the numbers are written in from a measurement, never a guess.
  // A narrowed run reports and passes.
  if (RAN_WHOLE_FLOOR[corpus] === undefined || CEILINGS[corpus] === undefined) {
    console.log(`Rust routing (${corpus}, not yet measured): ${ranWholeOf(runs)}`);
    console.log(`Rust counts (${corpus}, not yet measured): ${JSON.stringify(measured(total, runs))}`);
    if (isWholeCorpus(globalConfig)) {
      failures.push(`the ${corpus} corpus has no measured floor or ceilings yet: write RAN_WHOLE_FLOOR.${corpus} = ${runs.ranWhole} and CEILINGS.${corpus} from the counts above`);
    }
    if (failures.length > 0) throw new Error(`MOVEMENT_ENGINE=rust routing regression (${corpus}): ${failures.join('; ')}`);
    return;
  }
  if (isWholeCorpus(globalConfig) && runs.ranWhole < RAN_WHOLE_FLOOR[corpus]) {
    failures.push(`${runs.ranWhole} runs ran whole in Rust, under the ${corpus} floor of ${RAN_WHOLE_FLOOR[corpus]}`);
  }
  console.log(`Rust routing floor (${corpus}): ${ranWholeOf(runs)}; floor ${RAN_WHOLE_FLOOR[corpus]}`);
  const { lines, over } = againstCeilings(measured(total, runs), CEILINGS[corpus]);
  for (const line of lines) console.log(`Rust ceiling (${corpus}): ${line}`);
  if (over.length > 0) failures.push(`over a ceiling, which never rises: ${over.join('; ')}`);
  if (failures.length > 0) throw new Error(`MOVEMENT_ENGINE=rust routing regression (${corpus}): ${failures.join('; ')}`);
}

const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

/** `ran whole N of M runs attempted (…)`: M is every run the Rust route was
 *  entered for, each under exactly one ending. */
function ranWholeOf(runs) {
  const refused = sum(runs.notAdmitted);
  const declined = sum(runs.declined);
  const attempted = runs.ranWhole + refused + runs.mirroredFailure + runs.unreproduced + declined + runs.endedAtCheck + runs.failedCheckMidRun + runs.shimFaults;
  return `ran whole ${runs.ranWhole} of ${attempted} runs attempted (${refused} refused at admission by name, ${runs.mirroredFailure} ended in the TypeScript's own failure by name, mirrored, ${runs.unreproduced} unreproduced mid-run, ${declined} declined, ${runs.endedAtCheck} failed their check before a segment opened, ${runs.failedCheckMidRun} failed a check mid-run (check.compatible), ${runs.shimFaults} shim faults)`;
}

/** What the run's counts say of each ceilinged class (`CEILINGS`). */
function measured(total, runs) {
  return {
    refused: sum(runs.notAdmitted),
    everyReason: runs.allReasons,
    declined: runs.declined,
    unreproduced: runs.unreproduced,
    failedCheckMidRun: runs.failedCheckMidRun,
    shimFaults: runs.shimFaults,
    handBacks: {
      'builtins.function': runs.hostCalls['builtins.function'] ?? 0,
      'builtins.compare': runs.hostCalls['builtins.compare'] ?? 0,
      fallback: sum(total.fallback),
    },
    evaluatorNotAdmitted: total.notAdmitted,
    mirroredFailure: runs.mirroredFailure,
  };
}

/** Each class measured against its ceiling, a line apiece, and every count
 *  over one. A key a by-key ceiling does not name has a ceiling of 0. */
function againstCeilings(counts, ceilings) {
  const lines = [];
  const over = [];
  for (const [kind, ceiling] of Object.entries(ceilings)) {
    const count = counts[kind];
    if (typeof ceiling === 'number') {
      lines.push(`${kind} ${count} (ceiling ${ceiling})`);
      if (count > ceiling) over.push(`${kind} ${count} > ${ceiling}`);
      continue;
    }
    lines.push(`${kind} ${JSON.stringify(sorted(count))} (ceilings ${JSON.stringify(ceiling)})`);
    for (const [key, n] of Object.entries(count)) {
      if (n > (ceiling[key] ?? 0)) over.push(`${kind} ${key} ${n} > ${ceiling[key] ?? 0}`);
    }
  }
  return { lines, over };
}

/** The declines a passing check leaves for a slot the lowering misses. */
const LOWERING_MISSES = ['condition_does_not_lower', 'expression_does_not_lower', 'block_head_does_not_lower'];

module.exports = globalTeardown;
module.exports.isWholeCorpus = isWholeCorpus;
module.exports.ranWholeOf = ranWholeOf;
module.exports.CEILINGS = CEILINGS;
