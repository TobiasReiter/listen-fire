// Google Drive's performance gate (plan 22 #1: hosted p50/p99/RSS/boot within
// +5%), as Sheets': the same Drive calls made the way the legacy line makes
// them (the adapter driven directly over a client, the grants and a file
// reader, its files named as the install's) and the way the module line does
// (the module loaded in process over a host context, answers unvalidated as
// in hosted production, its files named the same way; `validated` adds the
// development validation for reference). Each mode runs in its own process
// against one local fake Drive, constructing the adapter per round as the
// hosted resolver does.
//
//   pnpm bench            all modes, interleaved, 5 runs each
//   pnpm bench <mode>     one run of one mode (JSON)

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import type { FileRef } from 'movement-engine/public/adapter';
import type { ModuleKv } from 'module-kit';

const MODES = ['legacy', 'module', 'validated'] as const;
type Mode = (typeof MODES)[number];
const ROUNDS = 1500;
/** tsx, from the module kit (this package runs its sources as serve-module does). */
const TSX = require.resolve('tsx/cjs', { paths: [require.resolve('module-kit/package.json')] });
const WARMUP = 200;

const CHILDREN = JSON.stringify({
  files: Array.from({ length: 20 }, (_, i) => ({
    id: `file-${i + 1}`,
    name: `memo-${i + 1}.txt`,
    mimeType: 'text/plain',
    webViewLink: `https://drive.google.com/file/d/file-${i + 1}`,
    size: '47',
  })),
});
const BYTES = 'Acme investment memo: ARR 1.2M, growing 8% MoM.';

async function fakeDrive(): Promise<{ url: string; close(): void }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = req.url ?? '/';
      if (path.includes('alt=media')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(BYTES);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.method === 'POST' ? JSON.stringify({ id: 'new-1', webViewLink: 'https://drive.google.com/file/d/new-1' }) : CHILDREN);
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
  get: async () => undefined,
  set: async () => {},
  delete: async () => {},
  list: async () => [{ key: 'granted/fold-deals', value: { mimeType: 'application/vnd.google-apps.folder', name: 'Deals' } }],
};

async function bytesOf(stream: Readable): Promise<number> {
  let length = 0;
  for await (const chunk of stream) length += Buffer.byteLength(chunk);
  return length;
}

async function runOne(mode: Mode): Promise<Record<string, number>> {
  const bootStart = process.hrtime.bigint();
  const rssBefore = process.memoryUsage().rss;
  /* eslint-disable @typescript-eslint/no-require-imports */
  const drive: typeof import('../index') = require('../index');
  const kit: typeof import('module-kit') = require('module-kit');
  const { ownedFilesAdapter } = require('movement-engine/public/modules') as typeof import('movement-engine/public/modules');
  const { makeMetaPosition } = require('movement-engine/public/catalog') as typeof import('movement-engine/public/catalog');
  const fake = await fakeDrive();
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const files = kit.refusingFiles('none');
  const owner = { adapterType: 'google_drive', credentialsId: 'cred-1' };

  const adapterFor = (token: string) => {
    if (mode === 'legacy') {
      const client = new drive.GoogleDriveClient({ accessToken: async () => token, fetch, baseUrl: fake.url });
      const adapter = new drive.GoogleDriveAdapter({ client: async () => client, kv: grants, readFile: (ref) => files.read(ref), log: quiet });
      return ownedFilesAdapter(adapter, owner);
    }
    // As the platform's secrets family answers: the same fields until they change.
    const fields = { access_token: token, refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z' };
    const loaded = kit.adapterInProcess(drive.googleDriveModule, {
      tenant: 't',
      credential: { name: 'google', fields: async () => fields, update: async () => {} },
      log: quiet,
      files,
      kv: grants,
      baseUrlOverride: fake.url,
      validateResults: mode === 'validated',
    });
    return ownedFilesAdapter(loaded.adapter, owner);
  };
  // Boot: the code loaded and the first adapter constructed.
  adapterFor('boot');
  const bootMs = Number(process.hrtime.bigint() - bootStart) / 1e6;

  const meta = makeMetaPosition('google_drive');
  const mutationContext = { source: { type: 'api' as const }, occurredAt: '2026-10-17T00:00:00.000Z' };
  const samples: number[] = [];
  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const start = process.hrtime.bigint();
    const adapter = adapterFor(`token-${round}-a`);
    const [folder] = await adapter.getRelated({ position: meta, fieldId: 'Folders', direction: 'outgoing' });
    if (folder === undefined) throw new Error('no granted folder');
    const [file] = await adapter.getRelated({ position: folder.position, fieldId: 'Files', direction: 'outgoing' });
    if (file === undefined) throw new Error('no file in the folder');
    const ref = (await adapter.getFieldValue({ position: file.position, fieldId: 'File' })) as FileRef;
    const resolved = await adapter.resolveFileRef?.({ ref });
    if (resolved === undefined || (await bytesOf(resolved.stream)) !== BYTES.length) throw new Error('the bytes did not come back');
    await adapterFor(`token-${round}-b`).createRecord({
      recordType: 'File',
      fields: { Name: 'Deal notes', Content: 'Acme: term sheet signed.' },
      parentLinks: [{ recordType: 'Folder', externalId: 'fold-deals', edgeName: 'Files' }],
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
