// The performance gate for Affinity, Airtable and Attio as modules (plan 22
// #1: hosted p50/p99/RSS/boot within +5% of the legacy line). The same reads
// are made the way the legacy line makes them (the adapter constructed over a
// client directly) and the way the platform's module line does (the module
// loaded in process over a host context; answers unvalidated as in hosted
// production, `validated` adds the development validation for reference;
// Attio's answers also pass the file-owner stamping the platform adds). The
// provider is a local server answering every read from the recorded parity
// fixture. The database is excluded, as the credential read is on both
// lines (the module line's secrets family caches it per instance).
//
//   node --require <tsx/cjs> src/scripts/bench_crm_modules.ts [<crm>]   interleaved, 5 runs each
//   node --require <tsx/cjs> src/scripts/bench_crm_modules.ts <crm> <mode>  one run (JSON)

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import type { Adapter } from 'movement-engine/public/adapter';

const CRMS = ['affinity', 'airtable', 'attio'] as const;
type Crm = (typeof CRMS)[number];
const MODES = ['legacy', 'module', 'validated'] as const;
type Mode = (typeof MODES)[number];
const ROUNDS = 1500;
const WARMUP = 200;

const FIXTURES: Record<Crm, string> = {
  affinity: 'services/translation_graph/adapters/affinity/__test__/__fixtures__/affinity_parity.json',
  airtable: 'services/translation_graph/adapters/airtable/__test__/__fixtures__/airtable_parity.json',
  attio: 'services/translation_graph/adapters/__test__/__fixtures__/attio_parity.json',
};

/** Answers every request from the recording, by method and path (the last
 *  answer recorded for it). */
async function recordedProvider(crm: Crm): Promise<{ url: string; close(): void }> {
  const recorded = JSON.parse(readFileSync(join(__dirname, '..', FIXTURES[crm]), 'utf8')) as {
    exchanges: Array<{ method: string; path: string; status: number; response: string }>;
  };
  const answers = new Map(recorded.exchanges.map((e) => [`${e.method} ${e.path}`, e]));
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const answer = answers.get(`${req.method ?? 'GET'} ${req.url ?? ''}`);
      res.writeHead(answer?.status ?? 404, { 'content-type': 'application/json' });
      res.end(answer?.response ?? '{}');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

/* eslint-disable @typescript-eslint/no-require-imports */
async function runOne(crm: Crm, mode: Mode): Promise<Record<string, number>> {
  const bootStart = process.hrtime.bigint();
  const rssBefore = process.memoryUsage().rss;
  const kit: typeof import('module-kit') = require('module-kit');
  const { makeMetaPosition }: typeof import('movement-engine/public/catalog') = require('movement-engine/public/catalog');
  const { routeEngineLogsTo }: typeof import('movement-engine/public/log') = require('movement-engine/public/log');
  routeEngineLogsTo(() => undefined);
  const provider = await recordedProvider(crm);
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  // One of each for every instance, as the platform lends its own.
  const files = kit.refusingFiles('none');
  const models = kit.refusingModels('none');
  const kv = kit.refusingKv('none');

  const adapterFor = (round: number): Adapter => {
    const tenant = `team-${round % 4}`;
    if (crm === 'affinity') {
      const m: typeof import('@lf/affinity') = require('@lf/affinity');
      if (mode === 'legacy') {
        return new m.AffinityAdapter({ tenant, client: async () => m.getAffinityClient('dev-loop-affinity-key', provider.url), models, files, fetch });
      }
      const fields = { apiKey: 'dev-loop-affinity-key', baseUrl: provider.url };
      return kit.adapterInProcess(m.affinityModule, { tenant, credential: { name: 'affinity', fields: async () => fields, update: async () => {} }, log: quiet, files, kv, models, validateResults: mode === 'validated' }).adapter;
    }
    if (crm === 'airtable') {
      const m: typeof import('@lf/airtable') = require('@lf/airtable');
      if (mode === 'legacy') {
        const client = new m.AirtableAPIClient({ baseUrl: provider.url, tokens: { accessToken: async () => 'dev-loop-airtable-token', refresh: async () => {} } });
        return new m.AirtableAdapter({ tenant, client: async () => client, files });
      }
      const fields = { access_token: 'dev-loop-airtable-token', refresh_token: 'r', baseUrl: provider.url };
      return kit.adapterInProcess(m.airtableModule, { tenant, credential: { name: 'airtable', fields: async () => fields, update: async () => {} }, log: quiet, files, kv, models, validateResults: mode === 'validated' }).adapter;
    }
    const m: typeof import('@lf/attio') = require('@lf/attio');
    if (mode === 'legacy') {
      return new m.AttioAdapter({ tenant, client: async () => m.getAttioClient('dev-loop-attio-token', provider.url), files, fetch });
    }
    const { ownedFilesAdapter }: typeof import('movement-engine/public/modules') = require('movement-engine/public/modules');
    const fields = { access_token: 'dev-loop-attio-token', baseUrl: provider.url };
    const adapter = kit.adapterInProcess(m.attioModule, { tenant, credential: { name: 'attio', fields: async () => fields, update: async () => {} }, log: quiet, files, kv, models, validateResults: mode === 'validated' }).adapter;
    return ownedFilesAdapter(adapter, { adapterType: adapter.adapterType, credentialsId: 'cred-1' });
  };

  // Boot: the code loaded and the first adapter constructed.
  adapterFor(0);
  const bootMs = Number(process.hrtime.bigint() - bootStart) / 1e6;

  const meta = makeMetaPosition(crm);
  const samples: number[] = [];
  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const start = process.hrtime.bigint();
    const adapter = adapterFor(round);
    const entries = await adapter.listEntryPoints();
    const first = entries.find((e) => e.readable && e.fires !== true);
    if (first !== undefined) {
      await adapter.describe(first.typeId);
      const found = await adapter.getRelated({ position: meta, fieldId: first.collectionName ?? first.displayName, direction: 'outgoing', limit: 3 });
      const position = found[0]?.position;
      if (position !== undefined) await adapter.edgesFrom?.(position);
    }
    if (round >= WARMUP) samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  provider.close();
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

function isCrm(value: string | undefined): value is Crm {
  return (CRMS as readonly string[]).includes(value ?? '');
}
function isMode(value: string | undefined): value is Mode {
  return (MODES as readonly string[]).includes(value ?? '');
}

async function main(): Promise<void> {
  const [crm, mode] = process.argv.slice(2);
  if (crm !== undefined && mode !== undefined) {
    if (!isCrm(crm) || !isMode(mode)) throw new Error(`usage: <${CRMS.join('|')}> <${MODES.join('|')}>`);
    process.stdout.write(`${JSON.stringify(await runOne(crm, mode))}\n`);
    return;
  }
  for (const c of crm !== undefined && isCrm(crm) ? [crm] : CRMS) {
    // Interleaved, five runs of every mode, so a busy machine slows each mode
    // alike; the median of each figure is reported.
    const runs: Record<string, Array<Record<string, number>>> = {};
    for (let i = 0; i < 5; i++) {
      for (const m of MODES) {
        const child = spawnSync(process.execPath, [...process.execArgv, __filename, c, m], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } });
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
      console.log(`${c.padEnd(9)} ${m.padEnd(10)} p50 ${row.p50}ms (${delta('p50')})  p99 ${row.p99}ms (${delta('p99')})  rss ${row.rssMb}MB (${delta('rssMb')})  boot ${row.bootMs}ms (${delta('bootMs')})`);
    }
  }
}

void main();
