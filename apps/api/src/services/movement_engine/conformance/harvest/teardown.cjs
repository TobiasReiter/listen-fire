// A conformance corpus's global teardown: under UPDATE_ENGINE_RUNS=1, the fold of every worker's host recordings into the
// corpus's fixture, ../__fixtures__/engine-runs.v<n>.json — one recording per
// line, one per distinct conversation (its entry point, canonical input and
// canonical requests: the same input answered differently is another
// conversation), sorted by that key. Of equal conversations the recording
// kept is chosen by content (the lowest canonical JSON), since worker order
// varies. A host request made after its entry ended refuses the harvest.
// Only a run of the whole corpus rewrites the fixture: a narrowed run would
// shrink it.
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const { canonical } = require('./canonical.cjs');

const FIXTURES = path.resolve(__dirname, '../__fixtures__');

function corpusOf(projectConfig) {
  const match = (projectConfig?.testMatch ?? []).join(' ');
  const found = match.match(/__conformance__\/(v\d+)/);
  return found ? found[1] : undefined;
}

function fold(dir, corpus) {
  const byKey = new Map();
  const late = [];
  let harvested = 0;
  for (const name of readdirSync(dir)) {
    for (const line of readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.late !== undefined) {
        late.push(`${row.file}: ${row.late}`);
        continue;
      }
      harvested += 1;
      const { recording } = row;
      const key = canonical({ entry: recording.entry, input: recording.input, requests: recording.requests });
      const text = canonical(recording);
      const seen = byKey.get(key);
      if (seen === undefined || text < seen.text) byKey.set(key, { text, line: JSON.stringify(recording) });
    }
  }
  if (late.length > 0) {
    throw new Error(`the ${corpus} corpus made host requests after their entry ended; refusing to overwrite its fixture:\n${late.join('\n')}`);
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

/** Whether jest ran every test file of the corpus, unfiltered. */
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

module.exports = async function globalTeardown(globalConfig, projectConfig) {
  const dir = process.env.ENGINE_RUNS_HARVEST_DIR;
  if (process.env.UPDATE_ENGINE_RUNS !== '1' || dir === undefined || !existsSync(dir)) return;
  try {
    const corpus = corpusOf(projectConfig);
    if (corpus === undefined) throw new Error('UPDATE_ENGINE_RUNS=1 outside a conformance corpus');
    if (!isWholeCorpus(globalConfig)) {
      throw new Error(`UPDATE_ENGINE_RUNS=1 rewrites engine-runs.${corpus}.json only from a run of the whole corpus`);
    }
    fold(dir, corpus);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
