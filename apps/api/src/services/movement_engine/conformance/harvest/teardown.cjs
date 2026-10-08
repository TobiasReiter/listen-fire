// A conformance corpus's global teardown: the Rust evaluator's counts and
// routing floors (src/test/rust_eval_stats.teardown.cjs), then, under
// UPDATE_ENGINE_RUNS=1, the fold of every worker's host recordings into the
// corpus's fixture, ../__fixtures__/engine-runs.v<n>.json — one recording per
// line, one per distinct entry (its entry point and canonical input), sorted
// by that key. Of equal inputs the recording kept is chosen by content (the
// lowest canonical JSON), since worker order varies. Only a run of the whole
// corpus rewrites the fixture: a narrowed run would shrink it.
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const rustStats = require('../../../../test/rust_eval_stats.teardown.cjs');
const { canonical } = require('./canonical.cjs');

const FIXTURES = path.resolve(__dirname, '../__fixtures__');

function corpusOf(projectConfig) {
  const match = (projectConfig?.testMatch ?? []).join(' ');
  const found = match.match(/__conformance__\/(v\d+)/);
  return found ? found[1] : undefined;
}

function fold(dir, corpus) {
  const byKey = new Map();
  let harvested = 0;
  for (const name of readdirSync(dir)) {
    for (const line of readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      harvested += 1;
      const { recording } = row;
      const key = canonical({ entry: recording.entry, input: recording.input });
      const text = canonical(recording);
      const seen = byKey.get(key);
      if (seen === undefined || text < seen.text) byKey.set(key, { text, line: JSON.stringify(recording) });
    }
  }
  if (byKey.size === 0) throw new Error(`no host recordings were harvested from the ${corpus} corpus; refusing to overwrite its fixture`);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const rows = [...byKey.entries()].sort(([a], [b]) => cmp(a, b)).map(([, { line }]) => line);
  const text = rows.join('\n') + '\n';
  const out = path.join(FIXTURES, `engine-runs.${corpus}.json`);
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(out, text);
  console.log(`Engine runs (${corpus}): ${harvested} recorded, ${rows.length} distinct, ${Buffer.byteLength(text)} bytes → ${path.relative(process.cwd(), out)}`);
}

module.exports = async function globalTeardown(globalConfig, projectConfig) {
  const dir = process.env.ENGINE_RUNS_HARVEST_DIR;
  try {
    await rustStats(globalConfig, projectConfig);
  } finally {
    if (process.env.UPDATE_ENGINE_RUNS === '1' && dir !== undefined && existsSync(dir)) {
      try {
        const corpus = corpusOf(projectConfig);
        if (corpus === undefined) throw new Error('UPDATE_ENGINE_RUNS=1 outside a conformance corpus');
        if (!rustStats.isWholeCorpus(globalConfig)) {
          throw new Error(`UPDATE_ENGINE_RUNS=1 rewrites engine-runs.${corpus}.json only from a run of the whole corpus`);
        }
        fold(dir, corpus);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
};
