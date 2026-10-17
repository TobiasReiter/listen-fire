// Folds the harvest's JSON lines (./harvest.setup.cjs) into the checks pin
// (../../conformance/checks_pin.ts): one record per distinct (source,
// snapshot, version, upgradingFrom), sorted by (version, source). A few
// hundred catalogs serve thousands of checks, so each snapshot is written once
// to checks.snapshots.json (one `{key, snapshot}` per line, keyed by the sha256
// of its canonical form, or of its recorded form when a second key order of
// one catalog turns up) and a record names its snapshot by that key.
//
// Schema field order is observable in diagnostic messages ("it has: Title,
// Colour"), so a stored snapshot keeps the order the catalog answered in:
// neither side may sort schema keys — which also binds the Rust catalog types
// to insertion-ordered maps. Only the key hashes the canonical (sorted) form.
//
// The pin holds no program text. Every run writes the programs the harvest
// found (hash, text, the tests it came from) and the corpus assembled from the
// pin and them to target/checks/ (checks_pin.ts says what reads it):
//
//   --pin       rewrite the pin from this harvest (a re-harvest);
//   (default)   keep the pin, and refuse when a pinned program was not found;
//   --partial   keep the pin, and assemble what was found (./harvest.sh's
//               first pass, which the corpus's own readers then extend).
//
// Run by ./harvest.sh, from packages/movement-lang, under ts-node (the pin's
// format is checks_pin.ts):
//
//   node -r <ts-node>/register/transpile-only checker/harvest/build_fixture.cjs [--pin | --partial] <corpus>=<harvest.jsonl>...
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { beats, canonical } = require('./dedupe.cjs');

const pin = require('../../conformance/checks_pin.ts');

const SNAPSHOTS_OUT = pin.SNAPSHOT_TABLE_FILE;

const keyOf = (r) =>
  canonical({ source: r.source, snapshot: r.snapshot, version: r.version, parseVersion: r.parseVersion, upgradingFrom: r.upgradingFrom });

const byKey = new Map();
const stats = {};
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const inputs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const mode = flags.includes('--pin') ? 'pin' : flags.includes('--partial') ? 'partial' : 'keep';
if (
  inputs.length === 0 ||
  inputs.some((a) => !a.includes('=') || !fs.existsSync(a.split('=')[1])) ||
  flags.some((f) => f !== '--pin' && f !== '--partial') ||
  flags.length > 1
) {
  console.error('usage: build_fixture.cjs [--pin | --partial] <corpus>=<harvest.jsonl>... (every file must exist); refusing to write anything');
  process.exit(1);
}
/** Each harvested text by its hash, with the tests it came from. */
const programs = new Map();
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
    const programKey = pin.programKey(record.source);
    const found = programs.get(programKey) ?? { source: record.source, files: new Set() };
    if (record.file) found.files.add(record.file);
    programs.set(programKey, found);
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
  console.error(`no harvest records found in ${inputs.join(', ')}; refusing to write anything`);
  process.exit(1);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const lines = (items) => items.map((r) => JSON.stringify(r)).join('\n') + '\n';
console.log(JSON.stringify(stats));

if (mode === 'pin') {
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

  const snapshotText = lines([...snapshots.entries()].sort(([a], [b]) => cmp(a, b)).map(([key, snapshot]) => ({ key, snapshot })));
  pin.writePin(rows);
  fs.writeFileSync(SNAPSHOTS_OUT, snapshotText);
  console.log(`${records.length} records (${records.filter((r) => r.note).length} noted) → ${path.relative(process.cwd(), pin.PIN_DIR)}`);
  console.log(`${snapshots.size} distinct snapshots, ${Buffer.byteLength(snapshotText)} bytes → ${path.relative(process.cwd(), SNAPSHOTS_OUT)}`);
}

fs.mkdirSync(pin.CORPUS_DIR, { recursive: true });
fs.writeFileSync(
  pin.PROGRAMS_FILE,
  lines([...programs.entries()].sort(([a], [b]) => cmp(a, b)).map(([program, { source, files }]) => ({ program, source, files: [...files].sort() }))),
);
const { records, missing } = pin.assemble(pin.readPin(), new Map([...programs].map(([key, { source }]) => [key, source])));
pin.writeCorpus(records);
console.log(`${programs.size} programs → ${path.relative(process.cwd(), pin.PROGRAMS_FILE)}`);
console.log(`${records.length} pinned checks assembled with their text → ${path.relative(process.cwd(), pin.CORPUS_FILE)}`);
if (missing.length > 0) {
  const shown = missing.slice(0, 10).map((m) => `  v${m.version} program ${m.program} snapshot ${m.snapshot}`).join('\n');
  const message = `${missing.length} pinned checks name a program no harvested test produced:\n${shown}`;
  if (mode === 'partial') console.log(`(first pass) ${message}`);
  else {
    console.error(`${message}\nthe pin is stale: re-harvest (pnpm harvest:checks) and read the diff`);
    process.exit(1);
  }
}
