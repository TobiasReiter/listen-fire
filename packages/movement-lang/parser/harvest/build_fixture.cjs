// Folds the harvest's JSON lines (./harvest.setup.cjs) into the programs
// fixture: one record per distinct (source, version), sorted by (version,
// source). Usage, from packages/movement-lang:
//
//   node parser/harvest/build_fixture.cjs v1=<a.jsonl> v2=<b.jsonl> current=<c.jsonl>
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(__dirname, '../__test__/__fixtures__/programs.json');

const outcome = (record) => (record.error ? JSON.stringify(record.error) : record.ast_sha256);

const byKey = new Map();
for (const arg of process.argv.slice(2)) {
  const [, file] = arg.split('=');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    const key = `${record.version}\u0000${record.source}`;
    const seen = byKey.get(key);
    if (seen && outcome(seen) !== outcome(record)) {
      throw new Error(
        `non-deterministic parse: version ${record.version} source ${JSON.stringify(record.source)} gave ${outcome(seen)} and ${outcome(record)}`,
      );
    }
    if (!seen) byKey.set(key, record);
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const records = [...byKey.values()].sort((a, b) => a.version - b.version || cmp(a.source, b.source));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`${records.length} records → ${path.relative(process.cwd(), OUT)}`);
