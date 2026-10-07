// The run's evaluator counts and whole-run counts, summed over every test
// file, printed; and a Rust run in which Rust answered nothing fails, because
// then the switch is off and the corpus proved nothing about the Rust engine.
const { existsSync, readdirSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');

module.exports = async function globalTeardown() {
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
};
