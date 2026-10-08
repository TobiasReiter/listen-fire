// A conformance corpus's global setup: the Rust evaluator's counts
// (src/test/rust_eval_stats.global-setup.cjs), and under UPDATE_ENGINE_RUNS=1
// the directory every worker appends its host recordings to
// (./record.setup.cjs). Workers are spawned after this and inherit both.
const { mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rustStats = require('../../../../test/rust_eval_stats.global-setup.cjs');

module.exports = async function globalSetup(globalConfig, projectConfig) {
  await rustStats(globalConfig, projectConfig);
  if (process.env.UPDATE_ENGINE_RUNS === '1') {
    if (process.env.MOVEMENT_ENGINE === 'rust') {
      throw new Error('UPDATE_ENGINE_RUNS records the TypeScript engine\'s conversations: run it without MOVEMENT_ENGINE=rust');
    }
    process.env.ENGINE_RUNS_HARVEST_DIR = mkdtempSync(path.join(os.tmpdir(), 'engine-runs-'));
  }
};
