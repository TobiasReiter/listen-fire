// Slack's performance gate (plan 22 #1: hosted p50/p99/RSS/boot within
// +5%): the same Slack calls made the way the legacy line makes them (the
// adapter driven directly over its sources) and the way the module line does
// (the module loaded in process over a host context, answers unvalidated as in
// hosted production; `validated` adds the development validation for
// reference). Each mode runs in its own process against one local fake Web
// API, constructing the adapter per round as the hosted resolver does.
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

const DELIVERY = {
  type: 'event_callback',
  event_id: 'Ev1',
  event: {
    type: 'message',
    channel: 'C1',
    user: 'U1',
    text: 'deck attached',
    ts: '1751600000.000100',
    files: [{ id: 'F1', name: 'deck.pdf', mimetype: 'application/pdf', size: 10 }],
  },
};

async function fakeSlack(): Promise<{ url: string; close(): void }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        req.url?.startsWith('/conversations.info')
          ? JSON.stringify({ ok: true, channel: { id: 'C1', is_member: true } })
          : JSON.stringify({ ok: true, ts: '1751600001.000200' }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function runOne(mode: Mode): Promise<Record<string, number>> {
  const bootStart = process.hrtime.bigint();
  const rssBefore = process.memoryUsage().rss;
  /* eslint-disable @typescript-eslint/no-require-imports */
  const slack: typeof import('../index') = require('../index');
  const kit: typeof import('module-kit') = require('module-kit');
  const fake = await fakeSlack();
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const chat = async () => 'composed';
  const readFile = async () => ({ body: Buffer.from('x') });
  // Built once, as the platform's Slack line builds its definition.
  const definition = slack.slackModuleWith({ chat, readFile });

  const adapterFor = (accessToken: string) => {
    if (mode === 'legacy') {
      return new slack.SlackAdapter({
        client: async () => slack.getSlackClient(accessToken, fake.url),
        missingClient: () => 'none',
        tenant: 't',
        credentialRef: 'cred',
        log: quiet,
        fetch,
        readFile,
        compose: (args) => slack.composeSlackMessage(chat, args),
      });
    }
    // As the platform's secrets family answers: the same fields until they change.
    const fields = { accessToken, baseUrl: fake.url };
    return kit.adapterInProcess(definition, {
      tenant: 't',
      credential: { name: 'slack', fields: async () => fields, update: async () => {} },
      log: quiet,
      files: kit.refusingFiles('none'),
      kv: kit.refusingKv('none'),
      credentialRef: 'cred',
      validateResults: mode === 'validated',
    }).adapter;
  };
  // Boot: the code loaded and the first adapter constructed.
  adapterFor('boot');
  const bootMs = Number(process.hrtime.bigint() - bootStart) / 1e6;

  const parent = { recordType: 'Channel', externalId: 'C1', edgeName: 'Messages', data: { id: 'C1' } };
  const mutationContext = { source: {}, occurredAt: '2026-10-17T00:00:00.000Z' };
  const samples: number[] = [];
  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const start = process.hrtime.bigint();
    // One workspace token across rounds, as a team's installs share one.
    const adapter = adapterFor('xoxb-bench');
    await adapter.describe('Message');
    const inbound = await adapter.preprocessInbound?.({ raw: DELIVERY });
    const message = { adapterType: 'slack', recordType: 'Message', identity: { kind: 'stable' as const, recordId: '1751600000.000100', data: inbound?.events[0]?.payload } };
    await adapter.getFieldValue({ position: message, fieldId: 'Message' });
    await adapter.getRelated({ position: message, fieldId: 'Files', direction: 'outgoing' });
    await adapterFor('xoxb-bench').createRecord({ mutationContext, recordType: 'Message', fields: { Message: 'hi' }, parentLinks: [parent] } as never);
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
