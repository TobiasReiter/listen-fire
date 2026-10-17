// Google Sheets' performance gate (plan 22 #1: hosted p50/p99/RSS/boot within
// +5%), as Dealroom's: the same Sheets calls made the way the legacy line
// makes them (the adapter driven directly over a client and the grants) and
// the way the module line does (the module loaded in process over a host
// context, answers unvalidated as in hosted production; `validated` adds the
// development validation for reference). Each mode runs in its own process
// against one local fake Sheets, constructing the adapter per round as the
// hosted resolver does.
//
//   pnpm bench            all modes, interleaved, 5 runs each
//   pnpm bench <mode>     one run of one mode (JSON)

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ModuleKv } from 'module-kit';

const MODES = ['legacy', 'module', 'validated'] as const;
type Mode = (typeof MODES)[number];
const ROUNDS = 1500;
/** tsx, from the module kit (this package runs its sources as serve-module does). */
const TSX = require.resolve('tsx/cjs', { paths: [require.resolve('module-kit/package.json')] });
const WARMUP = 200;

const SPREADSHEET = {
  spreadsheetId: 'ss-1',
  properties: { title: 'Pipeline Sheet' },
  sheets: [
    {
      properties: { sheetId: 0, title: 'Companies', gridProperties: { columnCount: 26 } },
      tables: [
        {
          tableId: 'table-companies',
          name: 'Companies',
          range: { startRowIndex: 0, endRowIndex: 21, startColumnIndex: 0, endColumnIndex: 3 },
          columnProperties: [
            { columnIndex: 0, columnName: 'Name', columnType: 'TEXT' },
            { columnIndex: 1, columnName: 'Stage', columnType: 'TEXT' },
            { columnIndex: 2, columnName: 'Raised', columnType: 'CURRENCY' },
          ],
        },
      ],
    },
  ],
  namedRanges: [{ namedRangeId: 'nr-1', name: 'FX_Rate', range: { sheetId: 0, startRowIndex: 30, endRowIndex: 31, startColumnIndex: 1, endColumnIndex: 2 } }],
};
const ROWS = Array.from({ length: 20 }, (_, i) => [`Company ${i + 1}`, 'Seed', 1000 * (i + 1)]);

async function fakeSheets(): Promise<{ url: string; close(): void }> {
  const spreadsheet = JSON.stringify(SPREADSHEET);
  const values = JSON.stringify({ values: ROWS });
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const path = req.url ?? '/';
      res.end(req.method === 'POST' ? JSON.stringify({ replies: [] }) : path.includes('/values/') ? values : spreadsheet);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

/** The install's grants, as either host keeps them. */
const grants: ModuleKv = {
  get: async (key) => (key === 'team/emails' ? [] : undefined),
  set: async () => {},
  delete: async () => {},
  list: async () => [{ key: 'granted/ss-1', value: { mimeType: 'application/vnd.google-apps.spreadsheet', name: 'Pipeline Sheet' } }],
};

async function runOne(mode: Mode): Promise<Record<string, number>> {
  const bootStart = process.hrtime.bigint();
  const rssBefore = process.memoryUsage().rss;
  /* eslint-disable @typescript-eslint/no-require-imports */
  const sheets: typeof import('../index') = require('../index');
  const kit: typeof import('module-kit') | undefined = mode === 'legacy' ? undefined : require('module-kit');
  const { makeMetaPosition, makeStablePosition } = require('movement-engine/public/catalog') as typeof import('movement-engine/public/catalog');
  const fake = await fakeSheets();
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };

  const adapterFor = (token: string) => {
    if (kit === undefined) {
      const client = new sheets.GoogleSheetsApiClient({ accessToken: async () => token, fetch, baseUrl: fake.url });
      return new sheets.GoogleSheetsAdapter({ client: async () => client, kv: grants, log: quiet, tenant: 't' });
    }
    // As the platform's secrets family answers: the same fields until they change.
    const fields = { access_token: token, refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z' };
    return kit.adapterInProcess(sheets.googleSheetsModule, {
      tenant: 't',
      credential: { name: 'google', fields: async () => fields, update: async () => {} },
      log: quiet,
      files: kit.refusingFiles('none'),
      kv: grants,
      baseUrlOverride: fake.url,
      validateResults: mode === 'validated',
    }).adapter;
  };
  // Boot: the code loaded and the first adapter constructed.
  adapterFor('boot');
  const bootMs = Number(process.hrtime.bigint() - bootStart) / 1e6;

  const meta = makeMetaPosition('google_sheets');
  const pipeline = makeStablePosition({ adapterType: 'google_sheets', recordType: 'Spreadsheet', recordId: 'ss-1', data: { Title: 'Pipeline Sheet' } });
  const mutationContext = { source: { type: 'api' as const }, occurredAt: '2026-10-17T00:00:00.000Z' };
  const samples: number[] = [];
  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const start = process.hrtime.bigint();
    const adapter = adapterFor(`token-${round}-a`);
    await adapter.getRelated({ position: meta, fieldId: 'Spreadsheet', direction: 'outgoing' });
    await adapter.edgesFrom?.(pipeline);
    await adapter.getRelated({ position: pipeline, fieldId: 'Companies (table)', direction: 'outgoing' });
    await adapterFor(`token-${round}-b`).createRecord({
      recordType: 'Companies (table)',
      fields: { Name: 'New Co', Stage: 'Seed', Raised: 5000 },
      parentLinks: [{ recordType: 'Spreadsheet', externalId: 'ss-1', edgeName: 'Companies (table)' }],
      mutationContext,
    });
    if (round >= WARMUP) samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  fake.close();
  samples.sort((a, b) => a - b);
  return {
    p50: percentile(samples, 50),
    p99: percentile(samples, 99),
    rssMb: process.memoryUsage().rss / 1e6,
    rssGrowthMb: (process.memoryUsage().rss - rssBefore) / 1e6,
    bootMs,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function main(): Promise<void> {
  const [mode] = process.argv.slice(2);
  if (mode !== undefined) {
    if (!(MODES as readonly string[]).includes(mode)) throw new Error(`mode is one of ${MODES.join(', ')}`);
    process.stdout.write(`${JSON.stringify(await runOne(mode as Mode))}\n`);
    return;
  }
  // Interleaved, five rounds of every mode, so a busy machine slows each
  // mode alike; the median of each figure is reported.
  const runs: Record<string, Array<Record<string, number>>> = {};
  for (let i = 0; i < 5; i++) {
    for (const m of MODES) {
      const child = spawnSync(process.execPath, ['--require', TSX, __filename, m], { cwd: __dirname, encoding: 'utf8' });
      if (child.status !== 0) throw new Error(child.stderr);
      (runs[m] ??= []).push(JSON.parse(child.stdout.trim().split('\n').pop() ?? '{}'));
    }
  }
  const results: Record<string, Record<string, number>> = {};
  for (const m of MODES) {
    const mine = runs[m] ?? [];
    results[m] = Object.fromEntries(Object.keys(mine[0] ?? {}).map((k) => [k, Number(median(mine.map((r) => r[k] ?? 0)).toFixed(3))]));
  }
  const base = results.legacy ?? {};
  for (const m of MODES) {
    const row = results[m] ?? {};
    const delta = (k: string) => (base[k] ? `${(((row[k] ?? 0) / base[k] - 1) * 100).toFixed(1)}%` : '');
    console.log(`${m.padEnd(10)} p50 ${row.p50}ms (${delta('p50')})  p99 ${row.p99}ms (${delta('p99')})  rss ${row.rssMb}MB (${delta('rssMb')})  boot ${row.bootMs}ms (${delta('bootMs')})`);
  }
}

void main();
