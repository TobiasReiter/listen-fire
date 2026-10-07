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
// Measured at slice 2b (2026-10-07): v1 69, v2 75. A floor applies to a run
// of the whole corpus only: a run narrowed to some files or cases checks the
// rest (nothing declined, no shim fault, something ran whole) but not it.
const RAN_WHOLE_FLOOR = { v1: 60, v2: 70 };

/** Which corpus this run is, from its test match. */
function corpusOf(projectConfig) {
  const match = (projectConfig?.testMatch ?? []).join(' ');
  if (match.includes('__conformance__/v1')) return 'v1';
  if (match.includes('__conformance__/v2')) return 'v2';
  return undefined;
}

module.exports = async function globalTeardown(globalConfig, projectConfig) {
  const dir = process.env.MOVEMENT_RUST_EVAL_STATS_DIR;
  if (process.env.MOVEMENT_ENGINE !== 'rust' || dir === undefined || !existsSync(dir)) return;
  const total = { notAdmitted: 0, admitted: 0, answered: 0, fallback: {} };
  const runs = { routed: 0, ranWhole: 0, shimFaults: 0, declined: {}, hostCalls: {} };
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
      runs.ranWhole += stats.runs?.ranWhole ?? 0;
      runs.shimFaults += stats.runs?.shimFaults ?? 0;
      if ((stats.runs?.ranWhole ?? 0) > 0 && stats.file) byFile[stats.file] = (byFile[stats.file] ?? 0) + stats.runs.ranWhole;
      add(runs.declined, stats.runs?.declined);
      add(runs.hostCalls, stats.runs?.hostCalls);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`\nRust evaluator: ${JSON.stringify(total)}`);
  console.log(`Rust runs: ${JSON.stringify({ runsRouted: runs.routed, ranWhole: runs.ranWhole, shimFaults: runs.shimFaults, declined: runs.declined, hostCalls: runs.hostCalls })}`);
  // Which files' runs the Rust engine ran whole, for a report.
  if (process.env.MOVEMENT_RUST_RUNS_BY_FILE === '1') console.log(`Rust runs by file: ${JSON.stringify(byFile)}`);
  if (total.answered === 0) {
    throw new Error('MOVEMENT_ENGINE=rust, and the Rust evaluator answered no expression in the whole run');
  }
  const corpus = corpusOf(projectConfig);
  if (corpus === undefined) return;
  const failures = [];
  if (runs.routed > 0 && runs.ranWhole === 0) failures.push(`${runs.routed} runs were routed and none ran whole`);
  if (Object.keys(runs.declined).length > 0) failures.push(`the corpus expects no declines, and these happened: ${JSON.stringify(runs.declined)}`);
  if (runs.shimFaults > 0) failures.push(`${runs.shimFaults} runs ended in a shim fault`);
  const whole = !globalConfig?.testPathPattern && !globalConfig?.testNamePattern;
  if (whole && runs.ranWhole < RAN_WHOLE_FLOOR[corpus]) {
    failures.push(`${runs.ranWhole} runs ran whole in Rust, under the ${corpus} floor of ${RAN_WHOLE_FLOOR[corpus]}`);
  }
  console.log(`Rust routing floor (${corpus}): ran whole ${runs.ranWhole}, floor ${RAN_WHOLE_FLOOR[corpus]}`);
  if (failures.length > 0) throw new Error(`MOVEMENT_ENGINE=rust routing regression (${corpus}): ${failures.join('; ')}`);
};
