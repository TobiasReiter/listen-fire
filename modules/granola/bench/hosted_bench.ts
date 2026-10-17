// The performance gate (plan 22 #1: hosted p50/p99/RSS/boot within +5%): the
// same Granola calls made the way the legacy line makes them (the adapter and
// poll driven directly over a client) and the way the module line does (the
// module loaded in process over a host context, answers unvalidated as in
// hosted production; `validated` adds the development validation for
// reference). Each mode runs in its own process against one local fake
// Granola, constructing the adapter per round as the hosted resolver does.
//
//   pnpm bench            all modes, interleaved, 5 runs each (BENCH_RUNS=n for more)
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

const NOTES = Array.from({ length: 5 }, (_, i) => ({
  id: `note-${i + 1}`,
  object: 'note',
  title: `Meeting ${i + 1}`,
  owner: { name: 'Priya Owner', email: 'priya@fund.com' },
  created_at: `2026-06-0${i + 1}T09:00:00.000Z`,
  updated_at: `2026-06-0${i + 1}T10:00:00.000Z`,
  calendar_event: null,
  attendees: [{ name: 'Acme CEO', email: 'ceo@acme.com' }],
  folder_membership: [{ id: 'f1', name: 'Dealflow' }],
  summary_text: 'They want $2M.',
  summary_markdown: null,
  transcript: [{ speaker: { source: 'microphone' }, text: 'Hi', start_time: '0', end_time: '1' }],
}));

async function fakeGranola(): Promise<{ url: string; close(): void }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.writeHead(200, { 'content-type': 'application/json' });
      const noteId = /^\/v1\/notes\/(.+)$/.exec(url.pathname)?.[1];
      if (noteId !== undefined) {
        res.end(JSON.stringify(NOTES.find((n) => n.id === noteId) ?? NOTES[0]));
        return;
      }
      const after = url.searchParams.get('updated_after');
      const notes = NOTES.filter((n) => after === null || n.updated_at > after).map(({ id, object, title, owner, created_at, updated_at }) => ({
        id, object, title, owner, created_at, updated_at,
      }));
      res.end(JSON.stringify({ notes, hasMore: false, cursor: null }));
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
  const granola: typeof import('../index') = require('../index');
  const kit: typeof import('module-kit') | undefined = mode === 'legacy' ? undefined : require('module-kit');
  const { makeMetaPosition, makeStablePosition } = require('movement-engine/public/catalog') as typeof import('movement-engine/public/catalog');
  const fake = await fakeGranola();
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };

  const subjectFor = (apiKey: string) => {
    if (kit === undefined) {
      const client = new granola.GranolaClient({ apiKey, baseUrl: fake.url, fetch, log: quiet });
      return { adapter: new granola.GranolaAdapter(async () => client), poll: (input: { config: unknown; checkpoint?: unknown }) => granola.pollGranola(client, input) };
    }
    // As the platform's secrets family answers: the same fields until they change.
    const fields = { apiKey, baseUrl: fake.url };
    const loaded = kit.adapterInProcess(granola.granolaModule, {
      tenant: 't',
      credential: { name: 'granola', fields: async () => fields, update: async () => {} },
      log: quiet,
      files: kit.refusingFiles('none'),
      kv: kit.refusingKv('none'),
      validateResults: mode === 'validated',
    });
    return { adapter: loaded.adapter, poll: (input: { config: unknown; checkpoint?: unknown }) => loaded.poll!(input) };
  };
  // Boot: the code loaded and the first adapter constructed.
  subjectFor('boot');
  const bootMs = Number(process.hrtime.bigint() - bootStart) / 1e6;

  const meta = makeMetaPosition('granola');
  const note = makeStablePosition({
    adapterType: 'granola',
    recordType: 'Meeting Note',
    recordId: 'note-1',
    data: { title: 'Meeting 1', attendees: [{ email: 'ceo@acme.com' }] },
  });
  const samples: number[] = [];
  const cpuSamples: number[] = [];
  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const start = process.hrtime.bigint();
    const cpuStart = process.cpuUsage();
    const { adapter, poll } = subjectFor(`key-${round}`);
    await adapter.describe('Meeting Note');
    await adapter.getFieldValue({ position: note, fieldId: 'Title' });
    await adapter.getRelated({ position: note, fieldId: 'Attendees', direction: 'outgoing' });
    await adapter.getRelated({ position: meta, fieldId: 'Meetings', direction: 'outgoing', limit: 2 });
    await poll({ config: {}, checkpoint: { updatedAfter: '2026-06-03T12:00:00.000Z' } });
    if (round >= WARMUP) {
      samples.push(Number(process.hrtime.bigint() - start) / 1e6);
      const cpu = process.cpuUsage(cpuStart);
      cpuSamples.push((cpu.user + cpu.system) / 1e3);
    }
  }
  fake.close();
  samples.sort((a, b) => a - b);
  cpuSamples.sort((a, b) => a - b);
  return {
    p50: percentile(samples, 50),
    // CPU time per round: wall time on a busy host mostly measures the host.
    cpuP50: percentile(cpuSamples, 50),
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
  for (let i = 0; i < Number(process.env.BENCH_RUNS ?? 5); i++) {
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
    console.log(`${m.padEnd(10)} p50 ${row.p50}ms (${delta('p50')})  cpu ${row.cpuP50}ms (${delta('cpuP50')})  p99 ${row.p99}ms (${delta('p99')})  rss ${row.rssMb}MB (${delta('rssMb')})  boot ${row.bootMs}ms (${delta('bootMs')})`);
  }
}

void main();
