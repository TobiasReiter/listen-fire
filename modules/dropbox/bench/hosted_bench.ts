// Dropbox's performance gate (plan 22 #1: hosted p50/p99/RSS/boot within
// +5%): the same Dropbox calls made the way the legacy line makes them (the
// adapter driven directly over a client) and the way the module line does
// (the module loaded in process over a host context, answers unvalidated as in
// hosted production; `validated` adds the development validation for
// reference). Each mode runs in its own process against one local fake
// Dropbox, constructing the adapter per round as the hosted resolver does.
//
//   pnpm bench            all modes, interleaved, 5 runs each
//   pnpm bench <mode>     one run of one mode (JSON)

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const MODES = ['legacy', 'module', 'validated'] as const;
type Mode = (typeof MODES)[number];
const ROUNDS = 1500;
/** tsx, from the module kit (this package runs its sources as serve-module does). */
const TSX = require.resolve('tsx/cjs', { paths: [require.resolve('module-kit/package.json')] });
const WARMUP = 200;

const ENTRIES = [
  ...Array.from({ length: 10 }, (_, i) => ({ '.tag': 'folder', name: `Folder ${i + 1}`, path_display: `/Folder ${i + 1}` })),
  ...Array.from({ length: 10 }, (_, i) => ({ '.tag': 'file', name: `file-${i + 1}.txt`, path_display: `/file-${i + 1}.txt`, size: 100 + i })),
];

async function fakeDropbox(): Promise<{ url: string; close(): void }> {
  const listing = JSON.stringify({ entries: ENTRIES, has_more: false, cursor: 'c' });
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/2/files/create_folder_v2') res.end(JSON.stringify({ metadata: { path_display: '/Created' } }));
      else if (req.url === '/2/files/upload') res.end(JSON.stringify({ path_display: '/notes.txt' }));
      else res.end(listing);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function runOne(mode: Mode): Promise<Record<string, number>> {
  const bootStart = process.hrtime.bigint();
  const rssBefore = process.memoryUsage().rss;
  /* eslint-disable @typescript-eslint/no-require-imports */
  const dropbox: typeof import('../index') = require('../index');
  const kit: typeof import('module-kit') | undefined = mode === 'legacy' ? undefined : require('module-kit');
  const { makeMetaPosition, makeStablePosition } = require('movement-engine/public/catalog') as typeof import('movement-engine/public/catalog');
  const fake = await fakeDropbox();
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };

  const files = { read: async () => new Uint8Array() };
  const adapterFor = (accessToken: string) => {
    if (kit === undefined) {
      const client = new dropbox.DropboxClient(accessToken, { baseUrl: fake.url, fetch });
      return new dropbox.DropboxAdapter({ client: async () => client, files, log: quiet });
    }
    // As the platform's secrets family answers: the same fields until they change.
    const fields = { access_token: accessToken, baseUrl: fake.url };
    return kit.adapterInProcess(dropbox.dropboxModule, {
      tenant: 't',
      credential: { name: 'dropbox', fields: async () => fields, update: async () => {} },
      log: quiet,
      files: { ...files, put: async () => ({ __brand: 'FileRef' as const }) },
      kv: kit.refusingKv('none'),
      validateResults: mode === 'validated',
    }).adapter;
  };
  // Boot: the code loaded and the first adapter constructed.
  adapterFor('boot');
  const bootMs = Number(process.hrtime.bigint() - bootStart) / 1e6;

  const meta = makeMetaPosition('dropbox');
  const file = makeStablePosition({ adapterType: 'dropbox', recordType: 'File', recordId: '/file-1.txt', data: { name: 'file-1.txt', path: '/file-1.txt', isFolder: false, size: 100 } });
  const context = { source: { type: 'user_edit' as const, adapterType: 'kg' }, occurredAt: '2026-10-17T00:00:00.000Z' };
  const samples: number[] = [];
  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const start = process.hrtime.bigint();
    const adapter = adapterFor(`token-${round}`);
    await adapter.describe('File');
    await adapter.getFieldValue({ position: file, fieldId: 'Url' });
    await adapter.getRelated({ position: meta, fieldId: 'Folders', direction: 'outgoing' });
    await adapter.createRecord({ recordType: 'Folder', fields: { name: 'Created' }, mutationContext: context });
    await adapterFor(`token-${round}-b`).createRecord({ recordType: 'File', fields: { name: 'notes.txt', file: 'hello' }, mutationContext: context });
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
