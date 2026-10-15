// Scratch (not committed): TS diagnostics for one source. args: <srcfile> <version> <snapshotKey|@needle>
import { checkNow, loadSnapshots } from '../../../packages/movement-lang/conformance/checks_corpus';
declare function require(id: string): any;
declare const process: { argv: string[] };
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../../..');
const table = loadSnapshots(path.join(ROOT, 'packages/movement-lang/checker/__test__/__fixtures__/checks.snapshots.json'));
const source = fs.readFileSync(process.argv[2], 'utf8');
const version = Number(process.argv[3]);
const snapshot = process.argv[4];
for (const d of checkNow({ source, snapshot, version, diagnostics: [] } as any, table) as any[]) console.log(d.code, JSON.stringify(d.span), d.message);
