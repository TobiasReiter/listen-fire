// Folds the harvest's JSON lines (./harvest.setup.cjs) into the checks
// fixture: one record per distinct (source, snapshot, version, upgradingFrom),
// sorted by (version, source). A few hundred catalogs serve thousands of
// checks, so each snapshot is written once to checks.snapshots.json (one
// `{key, snapshot}` per line, keyed by the sha256 of its canonical form, or of
// its recorded form when a second key order of one catalog turns up) and a
// record names its snapshot by that key.
//
// Schema field order is observable in diagnostic messages ("it has: Title,
// Colour"), so a stored snapshot keeps the order the catalog answered in:
// neither side may sort schema keys — which also binds the Rust catalog types
// to insertion-ordered maps. Only the key hashes the canonical (sorted) form.
//
// Usage, from packages/movement-lang:
//
//   node checker/harvest/build_fixture.cjs v1=<a.jsonl> v2=<b.jsonl> current=<c.jsonl>
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { beats, canonical } = require('./dedupe.cjs');

const OUT = path.resolve(__dirname, '../__test__/__fixtures__/checks.json');
const SNAPSHOTS_OUT = path.resolve(__dirname, '../__test__/__fixtures__/checks.snapshots.json');

const keyOf = (r) =>
  canonical({ source: r.source, snapshot: r.snapshot, version: r.version, parseVersion: r.parseVersion, upgradingFrom: r.upgradingFrom });

const byKey = new Map();
const stats = {};
const inputs = process.argv.slice(2);
if (inputs.length === 0 || inputs.some((a) => !a.includes('=') || !fs.existsSync(a.split('=')[1]))) {
  console.error('usage: node checker/harvest/build_fixture.cjs <corpus>=<harvest.jsonl>... (every file must exist); refusing to overwrite the fixture');
  process.exit(1);
}
for (const arg of inputs) {
  const [corpus, file] = arg.split('=');
  const s = (stats[corpus] = { harvested: 0, skipped: 0, added: 0 });
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.harvestError) throw new Error(`harvest failed in ${record.file}: ${record.harvestError}`);
    if (record.skipped) {
      s.skipped += 1;
      continue;
    }
    s.harvested += 1;
    const key = keyOf(record);
    const seen = byKey.get(key);
    if (seen && canonical(seen.diagnostics) !== canonical(record.diagnostics)) {
      throw new Error(
        `non-deterministic check: version ${record.version} source ${JSON.stringify(record.source.slice(0, 200))} gave ${canonical(seen.diagnostics)} and ${canonical(record.diagnostics)}`,
      );
    }
    const { file: where, ...rest } = record;
    // Where a noted record came from is what a reader needs to judge it.
    const candidate = record.note ? { ...rest, file: where } : rest;
    if (!seen) s.added += 1;
    // Equal records differ only in note/file/key order, and jest worker order
    // varies, so the kept one is chosen by content: a noted record, then the
    // lowest canonical JSON.
    if (!seen || beats(candidate, seen)) byKey.set(key, candidate);
  }
}

if (byKey.size === 0) {
  console.error(`no harvest records found in ${inputs.join(', ')}; refusing to overwrite ${path.relative(process.cwd(), OUT)}`);
  process.exit(1);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const records = [...byKey.entries()]
  .sort(([ka, a], [kb, b]) => a.version - b.version || cmp(a.source, b.source) || cmp(ka, kb))
  .map(([, r]) => r);

const snapshots = new Map();
const rows = records.map(({ snapshot, ...rest }) => {
  let key = crypto.createHash('sha256').update(canonical(snapshot)).digest('hex');
  const seen = snapshots.get(key);
  if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(snapshot)) {
    // Same catalog, another key order (two tests that build one adapter spec
    // in different field orders): one stored order would misreport the
    // other's messages, so the later order (records are sorted) is stored
    // under the hash of its recorded form.
    key = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const twin = snapshots.get(key);
    if (twin !== undefined && JSON.stringify(twin) !== JSON.stringify(snapshot)) throw new Error(`snapshot ${key} collides`);
  }
  snapshots.set(key, snapshot);
  const { source, version, parseVersion, upgradingFrom, note, file, diagnostics } = rest;
  return { source, snapshot: key, version, parseVersion, upgradingFrom, note, file, diagnostics };
});

const lines = (items) => items.map((r) => JSON.stringify(r)).join('\n') + '\n';
const text = lines(rows);
const snapshotText = lines([...snapshots.entries()].sort(([a], [b]) => cmp(a, b)).map(([key, snapshot]) => ({ key, snapshot })));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
fs.writeFileSync(SNAPSHOTS_OUT, snapshotText);
console.log(JSON.stringify(stats));
console.log(
  `${records.length} records (${records.filter((r) => r.note).length} noted), ${Buffer.byteLength(text)} bytes → ${path.relative(process.cwd(), OUT)}`,
);
console.log(`${snapshots.size} distinct snapshots, ${Buffer.byteLength(snapshotText)} bytes → ${path.relative(process.cwd(), SNAPSHOTS_OUT)}`);
