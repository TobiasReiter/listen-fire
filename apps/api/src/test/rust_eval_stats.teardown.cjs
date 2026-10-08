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
// regression. A floor applies to a run of the whole corpus only: a run
// narrowed to some files or cases checks the rest (nothing declined, no shim
// fault, something admitted ran whole) but not it.
const RAN_WHOLE_FLOOR = { v1: 69, v2: 75 };

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
  return undefined;
}

async function globalTeardown(globalConfig, projectConfig) {
  const dir = process.env.MOVEMENT_RUST_EVAL_STATS_DIR;
  if (process.env.MOVEMENT_ENGINE !== 'rust' || dir === undefined || !existsSync(dir)) return;
  const total = { notAdmitted: 0, admitted: 0, answered: 0, fallback: {} };
  const runs = { routed: 0, admitted: 0, ranWhole: 0, shimFaults: 0, notAdmitted: {}, declined: {}, hostCalls: {} };
  const byFile = {};
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
      add(runs.declined, stats.runs?.declined);
      add(runs.hostCalls, stats.runs?.hostCalls);
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
  // Which files' runs the Rust engine ran whole, for a report.
  if (process.env.MOVEMENT_RUST_RUNS_BY_FILE === '1') console.log(`Rust runs by file: ${JSON.stringify(byFile)}`);
  if (total.answered === 0) {
    throw new Error('MOVEMENT_ENGINE=rust, and the Rust evaluator answered no expression in the whole run');
  }
  const corpus = corpusOf(projectConfig);
  if (corpus === undefined) return;
  const failures = [];
  if (runs.admitted > 0 && runs.ranWhole === 0) failures.push(`${runs.admitted} runs were admitted and none ran whole`);
  if (Object.keys(runs.declined).length > 0) failures.push(`the corpus expects no declines, and these happened: ${JSON.stringify(runs.declined)}`);
  if (runs.shimFaults > 0) failures.push(`${runs.shimFaults} runs ended in a shim fault`);
  if (isWholeCorpus(globalConfig) && runs.ranWhole < RAN_WHOLE_FLOOR[corpus]) {
    failures.push(`${runs.ranWhole} runs ran whole in Rust, under the ${corpus} floor of ${RAN_WHOLE_FLOOR[corpus]}`);
  }
  console.log(`Rust routing floor (${corpus}): ran whole ${runs.ranWhole}, floor ${RAN_WHOLE_FLOOR[corpus]}`);
  if (failures.length > 0) throw new Error(`MOVEMENT_ENGINE=rust routing regression (${corpus}): ${failures.join('; ')}`);
}

module.exports = globalTeardown;
module.exports.isWholeCorpus = isWholeCorpus;
