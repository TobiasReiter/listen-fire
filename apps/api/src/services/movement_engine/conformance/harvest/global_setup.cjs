// A conformance corpus's global setup: under UPDATE_ENGINE_RUNS=1 the
// directory every worker appends its host recordings to (./record.setup.cjs).
// Workers are spawned after this and inherit it.
const { mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = async function globalSetup() {
  if (process.env.UPDATE_ENGINE_RUNS === '1') {
    process.env.ENGINE_RUNS_HARVEST_DIR = mkdtempSync(path.join(os.tmpdir(), 'engine-runs-'));
  }
};
