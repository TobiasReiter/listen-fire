// The plugins' performance gate (plan 22 #1: hosted p50/p99/RSS/boot within
// +5%): the same plugin calls made the way the legacy line makes them (the
// body run with the platform's tools, then its output read into an answer)
// and the way the module line does (the module loaded in process once per
// team and kept, as the platform's lookup does, answers unvalidated as in
// hosted production; `validated` adds the development validation for
// reference). The tools answer at once, so what is measured is the line, not
// a provider. Each mode runs in its own process.
//
//   pnpm bench            all modes, interleaved, 5 runs each
//   pnpm bench <mode>     one run of one mode (JSON)

import { spawnSync } from 'node:child_process';

import type { WebTools } from '../tools';

const MODES = ['legacy', 'module', 'validated'] as const;
type Mode = (typeof MODES)[number];
const ROUNDS = 3000;
/** tsx, from the module kit (this package runs its sources as serve-module does). */
const TSX = require.resolve('tsx/cjs', { paths: [require.resolve('module-kit/package.json')] });
const WARMUP = 300;

const PAGE = 'Acme Rockets builds reusable launch vehicles for small satellites, from Berlin, since 2021.';
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Tools that answer at once. */
const tools: WebTools = {
  log: quiet,
  logFields: () => ({}),
  models: {
    anthropicChat: async () => '{"type":"company_website","password":null}',
    anthropicChatStructured: async (options) =>
      (options.toolName === 'plan_searches' ? { queries: ['Acme Rockets launch'], anchors: ['launch'] } : { choice: 1, confidence: 'high' }) as never,
    anthropicWebChat: async () => {
      throw new Error('not benched');
    },
  },
  searchProvider: () => 'brightdata',
  search: async () => ({ items: [{ link: 'https://acme-rockets.example/', title: 'Acme Rockets — launch', snippet: 'Reusable launch.' }] }),
  findLinkedIn: async () => [],
  scrape: async () => PAGE,
  missingScraperSettings: () => [],
  profiles: undefined,
  isDocumentSource: () => false,
  fetchResource: async (url) => ({ url, content: PAGE, file: null }),
  fileValues: async (handles) => handles.map(() => undefined),
};

const CALLS = [
  { name: 'fetch_url', config: { url: 'https://acme-rockets.example' }, extractedContext: {} },
  { name: 'vc_url_retrieval', config: { text: 'See https://acme-rockets.example and https://acme.example/deck' }, extractedContext: {} },
  { name: 'web_research', config: { name: 'Acme Rockets', context: 'reusable launch vehicles, Berlin' }, extractedContext: {} },
];

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function runOne(mode: Mode): Promise<Record<string, number>> {
  const bootStart = process.hrtime.bigint();
  const rssBefore = process.memoryUsage().rss;
  /* eslint-disable @typescript-eslint/no-require-imports */
  const web: typeof import('../index') = require('../index');
  const kit: typeof import('module-kit') = require('module-kit');
  const definition = web.webModuleWith(() => tools);
  // Loaded once per team and kept, as the platform's lookup does.
  const module = mode === 'legacy' ? undefined : kit.pluginsInProcess(definition, {
    tenant: 't',
    credential: kit.noCredential('none'),
    log: quiet,
    files: kit.refusingFiles('none'),
    kv: kit.refusingKv('none'),
    validateResults: mode === 'validated',
  });

  const invoke = async (call: (typeof CALLS)[number]): Promise<unknown> => {
    if (mode === 'legacy') {
      const plugin = web.webPluginNamed(call.name);
      if (plugin === undefined) throw new Error(call.name);
      const output = await web.runWebPlugin(plugin, web.inputFor(plugin, call), tools);
      return web.withTools(tools, () => web.answerOf(output));
    }
    return module!.invoke(call);
  };
  // Boot: the code loaded and the first call answered.
  await invoke(CALLS[0]!);
  const bootMs = Number(process.hrtime.bigint() - bootStart) / 1e6;

  const samples: number[] = [];
  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const start = process.hrtime.bigint();
    for (const call of CALLS) await invoke(call);
    if (round >= WARMUP) samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
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
