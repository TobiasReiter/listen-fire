// Gmail's performance gate (plan 22 #1: hosted p50/p99/RSS/boot within +5%),
// as Drive's: the same Gmail calls made the way the legacy line makes them
// (the adapter and poll driven directly over a client holding the caller's
// token, a file reader, its files named as the install's) and the way the
// module line does (the module loaded in process over a host context,
// answers unvalidated as in hosted production, its files named the same
// way; `validated` adds the development validation for reference). Each mode
// runs in its own process against one local fake Gmail, constructing the
// adapter per round as the hosted resolver does.
//
//   pnpm bench            all modes, interleaved, 5 runs each
//   pnpm bench <mode>     one run of one mode (JSON)

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import type { FileRef } from 'movement-engine/public/adapter';

const MODES = ['legacy', 'module', 'validated'] as const;
type Mode = (typeof MODES)[number];
const ROUNDS = 1500;
/** tsx, from the module kit (this package runs its sources as serve-module does). */
const TSX = require.resolve('tsx/cjs', { paths: [require.resolve('module-kit/package.json')] });
const WARMUP = 200;

const MAILBOX = 'deals@example.com';
const BYTES = 'quarter,revenue\nQ3,1200\n';
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

function wireMessage(id: string): unknown {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ['INBOX'],
    snippet: 'Figures attached.',
    historyId: '1001',
    internalDate: String(Date.UTC(2026, 9, 10, 9, 0)),
    payload: {
      mimeType: 'multipart/mixed',
      filename: '',
      headers: [
        { name: 'Subject', value: 'Q3 figures' },
        { name: 'From', value: 'Rita Okoye <rita@acme.com>' },
        { name: 'To', value: MAILBOX },
        { name: 'Message-Id', value: `<${id}@acme.com>` },
      ],
      parts: [
        { mimeType: 'text/plain', filename: '', body: { size: 17, data: b64('Figures attached.') } },
        { mimeType: 'text/csv', filename: 'figures.csv', body: { attachmentId: 'att-1', size: BYTES.length } },
      ],
    },
  };
}

const LIST = JSON.stringify({ messages: Array.from({ length: 5 }, (_, i) => ({ id: `msg-${i + 1}`, threadId: `thread-msg-${i + 1}` })) });
const HISTORY = JSON.stringify({
  history: Array.from({ length: 3 }, (_, i) => ({ id: String(1001 + i), messagesAdded: [{ message: { id: `msg-${i + 1}`, threadId: `thread-msg-${i + 1}` } }] })),
  historyId: '1004',
});

async function fakeGmail(): Promise<{ url: string; close(): void }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = (req.url ?? '/').replace(/\?.*$/, '');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'POST') return res.end(JSON.stringify({ id: 'sent-1', threadId: 'sent-1', labelIds: ['SENT'] }));
      if (path.endsWith('/history')) return res.end(HISTORY);
      if (path.includes('/attachments/')) return res.end(JSON.stringify({ size: BYTES.length, data: b64(BYTES) }));
      const message = /\/messages\/([^/]+)$/.exec(path);
      if (message?.[1] !== undefined) return res.end(JSON.stringify(wireMessage(message[1])));
      return res.end(LIST);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function bytesOf(stream: Readable): Promise<number> {
  let length = 0;
  for await (const chunk of stream) length += Buffer.byteLength(chunk);
  return length;
}

async function runOne(mode: Mode): Promise<Record<string, number>> {
  const bootStart = process.hrtime.bigint();
  const rssBefore = process.memoryUsage().rss;
  /* eslint-disable @typescript-eslint/no-require-imports */
  const gmail: typeof import('../index') = require('../index');
  const kit: typeof import('module-kit') = require('module-kit');
  const { ownedFilesAdapter } = require('movement-engine/public/modules') as typeof import('movement-engine/public/modules');
  const { makeMetaPosition } = require('movement-engine/public/catalog') as typeof import('movement-engine/public/catalog');
  const fake = await fakeGmail();
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const files = kit.refusingFiles('none');
  const owner = { adapterType: 'gmail', credentialsId: 'cred-1' };
  const scopes = [gmail.GMAIL_READONLY_SCOPE, gmail.GMAIL_SEND_SCOPE];

  const instanceFor = (token: string) => {
    if (mode === 'legacy') {
      const client = new gmail.GmailApiClient(
        { mailbox: MAILBOX, method: 'oauth', grantedScopes: scopes },
        { accessToken: async () => token, fetch, baseUrl: fake.url },
      );
      const source = async () => client;
      const adapter = new gmail.GmailAdapter({ client: source, readFile: (ref) => files.read(ref), log: quiet });
      const poll = new gmail.GmailPollSource(source);
      return { adapter: ownedFilesAdapter(adapter, owner), poll: (input: { config: unknown; checkpoint?: unknown }) => poll.getEvents(input) };
    }
    // As the platform's secrets family answers: the same fields until they change.
    const fields = { mailbox: MAILBOX, method: 'oauth', access_token: token, refresh_token: 'r', expires_at: '2099-01-01T00:00:00.000Z', granted_scopes: scopes.join(' ') };
    const loaded = kit.adapterInProcess(gmail.gmailModule, {
      tenant: 't',
      credential: { name: 'gmail', fields: async () => fields, update: async () => {} },
      log: quiet,
      files,
      kv: kit.refusingKv('none'),
      baseUrlOverride: fake.url,
      validateResults: mode === 'validated',
    });
    const poll = loaded.poll;
    if (poll === undefined) throw new Error('the module declares no poll');
    return { adapter: ownedFilesAdapter(loaded.adapter, owner), poll: (input: { config: unknown; checkpoint?: unknown }) => poll({ config: input.config, ...(input.checkpoint !== undefined ? { checkpoint: input.checkpoint } : {}) }) };
  };
  // Boot: the code loaded and the first adapter constructed.
  instanceFor('boot');
  const bootMs = Number(process.hrtime.bigint() - bootStart) / 1e6;

  const meta = makeMetaPosition('gmail');
  const mutationContext = { source: { type: 'api' as const }, occurredAt: '2026-10-17T00:00:00.000Z' };
  const samples: number[] = [];
  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const start = process.hrtime.bigint();
    const { adapter } = instanceFor(`token-${round}-a`);
    const messages = await adapter.getRelated({ position: meta, fieldId: 'Messages', direction: 'outgoing', limit: 5 });
    const first = messages[0];
    if (first === undefined) throw new Error('no message');
    await adapter.getFieldValue({ position: first.position, fieldId: 'Subject' });
    const [attachment] = await adapter.getRelated({ position: first.position, fieldId: 'Attachments', direction: 'outgoing' });
    if (attachment === undefined) throw new Error('no attachment');
    const ref = (await adapter.getFieldValue({ position: attachment.position, fieldId: 'File' })) as FileRef;
    const resolved = await adapter.resolveFileRef?.({ ref });
    if (resolved === undefined || (await bytesOf(resolved.stream)) !== BYTES.length) throw new Error('the bytes did not come back');
    const writer = instanceFor(`token-${round}-b`);
    await writer.adapter.createRecord({
      recordType: 'Message',
      fields: { To: ['rita@acme.com'], Subject: 'Your Q3 figures', Body: 'Thanks.' },
      mutationContext,
    });
    const polled = await writer.poll({ config: {}, checkpoint: { historyId: '1000', lastSeenAt: '2026-10-09T00:00:00.000Z' } });
    if (polled.events.length !== 3) throw new Error('the poll did not deliver');
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
