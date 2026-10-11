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
// ran whole) but not it.
const RAN_WHOLE_FLOOR = { v1: 1178, v2: 1489, v3: 2545 };

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
  return undefined;
}

async function globalTeardown(globalConfig, projectConfig) {
  const dir = process.env.MOVEMENT_RUST_EVAL_STATS_DIR;
  if (process.env.MOVEMENT_ENGINE !== 'rust' || dir === undefined || !existsSync(dir)) return;
  const total = { notAdmitted: 0, admitted: 0, answered: 0, fallback: {} };
  const runs = { routed: 0, admitted: 0, ranWhole: 0, shimFaults: 0, notAdmitted: {}, allReasons: {}, declined: {}, hostCalls: {} };
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
  console.log(`Rust runs: ${JSON.stringify({ runsRouted: runs.routed, runsAdmitted: runs.admitted, ranWhole: runs.ranWhole, shimFaults: runs.shimFaults, declined: runs.declined, hostCalls: runs.hostCalls })}`);
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
  if (isWholeCorpus(globalConfig) && runs.ranWhole < RAN_WHOLE_FLOOR[corpus]) {
    failures.push(`${runs.ranWhole} runs ran whole in Rust, under the ${corpus} floor of ${RAN_WHOLE_FLOOR[corpus]}`);
  }
  console.log(`Rust routing floor (${corpus}): ran whole ${runs.ranWhole}, floor ${RAN_WHOLE_FLOOR[corpus]}`);
  if (failures.length > 0) throw new Error(`MOVEMENT_ENGINE=rust routing regression (${corpus}): ${failures.join('; ')}`);
}

/** The declines a passing check leaves for a slot the lowering misses. */
const LOWERING_MISSES = ['condition_does_not_lower', 'expression_does_not_lower', 'block_head_does_not_lower'];

module.exports = globalTeardown;
module.exports.isWholeCorpus = isWholeCorpus;
