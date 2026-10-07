// The directory every test file's evaluator counts are written to (see
// rust_eval_stats.setup.ts). Workers are spawned after this and inherit it.
const { mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = async function globalSetup() {
  process.env.MOVEMENT_RUST_EVAL_STATS_DIR = mkdtempSync(path.join(os.tmpdir(), 'movement-rust-eval-'));
};
