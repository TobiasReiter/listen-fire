// Folds the harvest's JSON lines (./harvest.setup.cjs) into the checks
// fixture: one record per distinct (source, snapshot, version, upgradingFrom),
// sorted by (version, source). A few hundred catalogs serve thousands of
// checks, so each snapshot is written once to checks.snapshots.json (one
// `{key, snapshot}` per line, keyed by the sha256 of its canonical form) and a
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

const OUT = path.resolve(__dirname, '../__test__/__fixtures__/checks.json');
const SNAPSHOTS_OUT = path.resolve(__dirname, '../__test__/__fixtures__/checks.snapshots.json');

// Must stay identical to `canonical` in parser/expression/__test__/lowering_fixture.ts.
function canonical(value) {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

const keyOf = (r) =>
  canonical({ source: r.source, snapshot: r.snapshot, version: r.version, parseVersion: r.parseVersion, upgradingFrom: r.upgradingFrom });

const byKey = new Map();
const stats = {};
for (const arg of process.argv.slice(2)) {
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
    if (!seen) {
      s.added += 1;
      const { file: where, ...rest } = record;
      // Where a noted record came from is what a reader needs to judge it.
      byKey.set(key, record.note ? { ...rest, file: where } : rest);
    }
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const records = [...byKey.entries()]
  .sort(([ka, a], [kb, b]) => a.version - b.version || cmp(a.source, b.source) || cmp(ka, kb))
  .map(([, r]) => r);

const snapshots = new Map();
const rows = records.map(({ snapshot, ...rest }) => {
  const key = crypto.createHash('sha256').update(canonical(snapshot)).digest('hex');
  const seen = snapshots.get(key);
  if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(snapshot)) {
    // Same catalog, another key order: one stored order would misreport the other's messages.
    throw new Error(`snapshot ${key} was recorded in two key orders`);
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
