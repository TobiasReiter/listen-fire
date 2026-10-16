// priced.json: a plugin's invocation under a seeded ledger (`pricedCalls`),
// written by the TypeScript's own code (packages/movement-engine's
// run_context.ts), which tests/priced_pin.rs holds the crate's ledger to:
// refused before the host is asked once the cap is spent, or invoked with the
// run's budget and its cost charged — and the ledger's account either way.
// Written by generate.ts; deterministic.

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { PluginSpecs } from '../../../../packages/movement-engine/services/movement_engine/extraction';
import { pricedCalls, RunLedger } from '../../../../packages/movement-engine/services/movement_engine/run_context';
import type { EngineHost } from '../../../../packages/movement-engine/services/movement_engine/host';

type Rand = () => number;

// ── Priced plugins ───────────────────────────────────────────────────────────

const PLUGINS: PluginSpecs = {
  fetch_url: { args: ['url'], priced: true },
  vc_url_retrieval: { args: [], priced: true },
  free_lookup: { args: ['q'], priced: false },
};

async function pricedCase(rand: Rand): Promise<unknown> {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const spend = {
    priorMicrodollars: pick([0, 0, 40, 120]),
    capBaselineMicrodollars: pick([0, 0, 20]),
    ...(rand() < 0.85 ? { capMicrodollars: pick([50, 100, 150]) } : {}),
  };
  const charges = Array.from({ length: Math.floor(rand() * 3) }, () => ({ source: pick(['model:extract', 'plugin:fetch_url']), microdollars: pick([10, 30.5, 60]) }));
  const plugin = pick(['fetch_url', 'vc-url-retrieval', 'free_lookup', 'unknown_one', 'Fetch_url']);
  const answerCost = pick([[], [{ source: 'plugin:fetch_url', microdollars: 25 }], [{ source: 'plugin:x', microdollars: 0.4 }, { source: 'model:y', microdollars: 2 }]]);
  const ledger = new RunLedger(spend);
  ledger.charge(charges);
  const asked: unknown[] = [];
  const host = {
    llm: { transforms: { invoke: async (input: { budget: unknown }) => (asked.push(input.budget), { text: 'ok', cost: answerCost }) } },
    files: {},
  } as unknown as EngineHost;
  const calls = pricedCalls(host, { segmentId: 'g1', ledger, plugins: PLUGINS });
  let refused: unknown;
  try {
    await calls.transforms.invoke({ plugin, config: {}, extractedContext: {} });
  } catch (error) {
    const e = error as { capMicrodollars: number; spentMicrodollars: number; message: string; name: string };
    refused = { class: e.name, capMicrodollars: e.capMicrodollars, spentMicrodollars: e.spentMicrodollars, message: e.message };
  }
  return { spend, charges, plugin, answerCost, asked, ...(refused !== undefined ? { refused } : {}), account: ledger.spend };
}

export async function writePricedOracle(rand: Rand): Promise<void> {
  // What both sides resolve against: the catalog's plugins.
  const cases: unknown[] = [{ kind: 'world', plugins: PLUGINS }];
  for (let i = 0; i < 80; i++) cases.push({ kind: 'priced', ...((await pricedCase(rand)) as object) });
  writeFileSync(path.join(__dirname, 'priced.json'), `[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`);
  console.log(`priced.json: ${cases.length} cases`);
}
