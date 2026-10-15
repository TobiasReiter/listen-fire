/**
 * Benchmark: fact extraction and summary condensing, per registry model name.
 *
 * Measures speed, cost, and quality on a fixed set of test passages. Each name
 * goes wherever MODEL_MAP sends it, so comparing vendors is the same run under
 * a different map, e.g. MODEL_MAP='{"claude-haiku-4-5":"openai/gpt-5-nano"}'.
 *
 * Usage (names default to claude-haiku-4-5):
 *   pnpm -F api ts-node --project tsconfig.dev.json --transpile-only \
 *     -r dotenv/config -r tsconfig-paths/register \
 *     src/scripts/benchmark_fact_extraction.ts [model name ...]
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ChatModelName } from 'movement-engine/lib/models/registry';

import { calculateCostMicrodollars } from '../lib/llm_usage';
import { chatCallFor } from '../lib/models/chat';
import { parseChatModelName } from 'movement-engine/lib/models/registry';
import { parseJson } from 'movement-engine/lib/utils/parse_json';

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const argNames = process.argv.slice(2);
const MODELS: ChatModelName[] =
  argNames.length > 0 ? argNames.map((v) => parseChatModelName(v, 'A model argument')) : ['claude-haiku-4-5'];

interface Completion {
  /** The name asked for and where the map sent it, so a table row says both. */
  model: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costDollars: number;
}

async function complete(
  name: ChatModelName,
  request: { system: string; user: string; maxTokens: number },
): Promise<Completion> {
  const { client, wireModel, resolved } = chatCallFor(name);
  const start = Date.now();
  const response = await client.messages.create({
    model: wireModel,
    max_tokens: request.maxTokens,
    system: [{ type: 'text', text: request.system }],
    messages: [{ role: 'user', content: request.user }],
  });
  const latencyMs = Date.now() - start;
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const micro = calculateCostMicrodollars({
    served: resolved,
    inputTokens,
    outputTokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
  });
  return {
    model: `${name} -> ${resolved.provider}/${wireModel}`,
    text,
    inputTokens,
    outputTokens,
    latencyMs,
    costDollars: micro / 1_000_000,
  };
}

// ---------------------------------------------------------------------------
// Shared prompt (same as facts.ts)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Extract every factual claim from the following text as (subject, predicate, object) triples.

Rules:
1. One fact per triple. Split compound claims — e.g. "CEO of Tesla" becomes two triples:
   {"s": "Elon Musk", "p": "role", "o": "CEO"} and {"s": "Elon Musk", "p": "affiliated_with", "o": "Tesla"}
2. Use canonical predicates where they fit:
   role, affiliated_with, located_in, founded, raised_amount, round_type, revenue, valuation,
   employees, investor_in, acquired_by, built, previously_at, education
   For other claims use a short, specific predicate (e.g. "NRR", "gross_margin", "deliveries").
3. Subjects and objects should be proper nouns or specific values — not generic types.
   Do NOT emit taxonomic triples like ("Tesla", "is_a", "company").
4. Be thorough — extract MORE triples rather than fewer. Always extract definitional triples
   for people and organisations when context allows.
5. Resolve ambiguous references (pronouns, "we", "our", bare first names) using any
   [Document context], [Definitions], [Previous section], or [Trailing context] provided above.
   Replace resolved references with the full entity name in your triples.

Example:
"Sarah Chen from Sequoia introduced Acme Corp, which is raising a $5M Series A."
→ [
  {"s": "Sarah Chen", "p": "role", "o": "Partner"},
  {"s": "Sarah Chen", "p": "affiliated_with", "o": "Sequoia"},
  {"s": "Sarah Chen", "p": "introduced", "o": "Acme Corp"},
  {"s": "Acme Corp", "p": "round_type", "o": "Series A"},
  {"s": "Acme Corp", "p": "raised_amount", "o": "$5M"}
]

Return a JSON object with two keys:
- "facts": array of {"s", "p", "o"} triples
- "summary": a one-sentence summary of what this text section covers`;

// ---------------------------------------------------------------------------
// Test passages with ground-truth facts
// ---------------------------------------------------------------------------

interface TestCase {
  name: string;
  text: string;
  expectedFacts: Array<{ s: string; p: string; o: string }>;
}

const TEST_CASES: TestCase[] = [
  {
    name: 'VC deal email',
    text: `From: deal-sourcing@sequoiacap.com
Subject: Acme Corp Series A

Hi team,

Just had a great call with Acme Corp. They're raising a $10M Series A.
The company builds AI-powered supply chain tools. Website: acmecorp.com

CEO is Jane Smith (jane@acmecorp.com). She previously worked at Google.
CTO is Bob Lee, ex-Meta. He built their internal ML infra.

Sequoia is leading the round. Acme has about 50 employees and $2M ARR.
They launched 18 months ago and are growing 20% MoM.

Best,
Deal Team`,
    expectedFacts: [
      { s: 'Acme Corp', p: 'raised_amount', o: '$10M' },
      { s: 'Acme Corp', p: 'round_type', o: 'Series A' },
      { s: 'Acme Corp', p: 'built', o: 'AI-powered supply chain tools' },
      { s: 'Jane Smith', p: 'role', o: 'CEO' },
      { s: 'Jane Smith', p: 'affiliated_with', o: 'Acme Corp' },
      { s: 'Jane Smith', p: 'previously_at', o: 'Google' },
      { s: 'Bob Lee', p: 'role', o: 'CTO' },
      { s: 'Bob Lee', p: 'affiliated_with', o: 'Acme Corp' },
      { s: 'Bob Lee', p: 'previously_at', o: 'Meta' },
      { s: 'Sequoia', p: 'investor_in', o: 'Acme Corp' },
      { s: 'Acme Corp', p: 'employees', o: '50' },
      { s: 'Acme Corp', p: 'revenue', o: '$2M' },
    ],
  },
  {
    name: 'Meeting notes',
    text: `Meeting Notes - Brightwave AI / Horizon Ventures
Date: 2026-02-15
Attendees: Sarah Chen (Partner, Horizon), Mike Torres (Analyst, Horizon),
           David Park (CEO, Brightwave), Lisa Wang (CTO, Brightwave)

Brightwave is building a real-time fraud detection platform using graph neural networks.
Founded in 2024 in San Francisco. Currently 12 FTEs.

Key metrics:
- $800K ARR, up from $200K 6 months ago (4x growth)
- 15 enterprise customers including Stripe, Square, and Plaid
- 99.7% detection accuracy, <50ms latency
- NRR of 140%

Raising a $6M Seed led by Horizon at a $30M post-money valuation.
Previous investors include Y Combinator (S24 batch) and Elad Gil.
David was previously VP of Engineering at Palantir for 5 years.
Lisa has a PhD in ML from Stanford and was a research scientist at DeepMind.`,
    expectedFacts: [
      { s: 'Brightwave', p: 'built', o: 'fraud detection platform' },
      { s: 'Brightwave', p: 'founded', o: '2024' },
      { s: 'Brightwave', p: 'located_in', o: 'San Francisco' },
      { s: 'Brightwave', p: 'employees', o: '12' },
      { s: 'Brightwave', p: 'revenue', o: '$800K' },
      { s: 'Brightwave', p: 'NRR', o: '140%' },
      { s: 'Brightwave', p: 'raised_amount', o: '$6M' },
      { s: 'Brightwave', p: 'valuation', o: '$30M' },
      { s: 'David Park', p: 'role', o: 'CEO' },
      { s: 'David Park', p: 'affiliated_with', o: 'Brightwave' },
      { s: 'David Park', p: 'previously_at', o: 'Palantir' },
      { s: 'Lisa Wang', p: 'role', o: 'CTO' },
      { s: 'Lisa Wang', p: 'education', o: 'Stanford' },
      { s: 'Lisa Wang', p: 'previously_at', o: 'DeepMind' },
      { s: 'Sarah Chen', p: 'role', o: 'Partner' },
      { s: 'Sarah Chen', p: 'affiliated_with', o: 'Horizon' },
      { s: 'Y Combinator', p: 'investor_in', o: 'Brightwave' },
      { s: 'Elad Gil', p: 'investor_in', o: 'Brightwave' },
    ],
  },
  {
    name: 'Short factual paragraph',
    text: `Tesla reported Q4 2025 revenue of $25.7B, beating estimates by $1.2B.
CEO Elon Musk announced the Cybertruck hit 50,000 deliveries in Q4.
The stock rose 8% in after-hours trading to $412 per share.
CFO Vaibhav Taneja said operating margins improved to 9.2%, up from 7.6% in Q3.`,
    expectedFacts: [
      { s: 'Tesla', p: 'revenue', o: '$25.7B' },
      { s: 'Elon Musk', p: 'role', o: 'CEO' },
      { s: 'Elon Musk', p: 'affiliated_with', o: 'Tesla' },
      { s: 'Cybertruck', p: 'deliveries', o: '50,000' },
      { s: 'Tesla', p: 'stock_price', o: '$412' },
      { s: 'Vaibhav Taneja', p: 'role', o: 'CFO' },
      { s: 'Vaibhav Taneja', p: 'affiliated_with', o: 'Tesla' },
      { s: 'Tesla', p: 'operating_margin', o: '9.2%' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Model runners
// ---------------------------------------------------------------------------

interface ModelResult {
  model: string;
  facts: Array<{ s: string; p: string; o: string }>;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costDollars: number;
  raw: string;
  error?: string;
}

async function runExtraction(name: ChatModelName, text: string): Promise<ModelResult> {
  const { text: raw, ...completion } = await complete(name, { system: SYSTEM_PROMPT, user: text, maxTokens: 4096 });
  const parsed = parseJson(raw);
  const facts = Array.isArray(parsed?.facts)
    ? parsed.facts.filter((f: any) => f?.s && f?.p && f?.o)
    : [];
  return { ...completion, facts, summary: parsed?.summary ?? '', raw };
}

// ---------------------------------------------------------------------------
// Quality scoring
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

const TAXONOMIC_PREDICATES = new Set(['is_a', 'is a', 'type', 'category', 'kind']);

function isTaxonomic(fact: { s: string; p: string; o: string }): boolean {
  const np = normalize(fact.p);
  if (TAXONOMIC_PREDICATES.has(np)) return true;
  const no = normalize(fact.o);
  return ['company', 'person', 'organisation', 'organization', 'entity', 'fiscal quarter',
    'financial metric', 'publicly traded', 'vehicle', 'product'].some((t) => no === t || no.endsWith(` ${t}`));
}

function factMatchesExpected(
  fact: { s: string; p: string; o: string },
  expected: { s: string; p: string; o: string },
): boolean {
  const ns = normalize(fact.s);
  const no = normalize(fact.o);
  const np = normalize(fact.p);
  const es = normalize(expected.s);
  const eo = normalize(expected.o);
  const ep = normalize(expected.p);

  // Subject must overlap
  if (!ns.includes(es) && !es.includes(ns)) return false;
  // Object must overlap
  if (!no.includes(eo) && !eo.includes(no)) return false;
  // Predicate: at least one word in common (loose match)
  const pWords = new Set(ep.split(' '));
  const fWords = np.split(' ');
  if (!fWords.some((w) => pWords.has(w)) && !np.includes(ep) && !ep.includes(np)) return false;

  return true;
}

interface QualityScore {
  recall: number;
  totalExtracted: number;
  taxonomicCount: number;
  matched: number;
  missed: string[];
}

function scoreQuality(
  extracted: Array<{ s: string; p: string; o: string }>,
  expected: Array<{ s: string; p: string; o: string }>,
): QualityScore {
  const matched = new Set<number>();
  const missed: string[] = [];
  const taxonomicCount = extracted.filter(isTaxonomic).length;

  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const found = extracted.some((f) => factMatchesExpected(f, exp));
    if (found) {
      matched.add(i);
    } else {
      missed.push(`(${exp.s}, ${exp.p}, ${exp.o})`);
    }
  }

  return {
    recall: expected.length > 0 ? matched.size / expected.length : 1,
    totalExtracted: extracted.length,
    taxonomicCount,
    matched: matched.size,
    missed,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Summary condensing benchmark
// ---------------------------------------------------------------------------

const CONDENSE_SYSTEM = 'Combine these two summaries into a single 1-2 sentence summary of the document so far.';

interface CondenseTestCase {
  name: string;
  previous: string;
  newSection: string;
  keyTerms: string[]; // terms that must appear in a good summary
}

const CONDENSE_CASES: CondenseTestCase[] = [
  {
    name: 'VC deal progression',
    previous: 'Acme Corp is raising a $10M Series A led by Sequoia, building AI-powered supply chain tools with $2M ARR.',
    newSection: 'The due diligence call revealed strong unit economics with 85% gross margins and 130% NRR, though the team is light on go-to-market experience.',
    keyTerms: ['Acme', 'Series A', 'due diligence', 'unit economics'],
  },
  {
    name: 'Multi-section research report',
    previous: 'The report covers emerging trends in climate tech, noting $45B in venture funding during 2025 across carbon capture, green hydrogen, and grid-scale storage.',
    newSection: 'The carbon capture section highlights three promising startups: CarbonVault ($30M Series B), AirMine (seed stage), and Sequestra (acquired by Shell for $200M).',
    keyTerms: ['climate tech', 'carbon capture', 'CarbonVault', 'Sequestra'],
  },
  {
    name: 'Meeting notes accumulation',
    previous: 'Quarterly board meeting covered Q4 financials showing 40% YoY revenue growth to $12M and a path to profitability by Q3 2026.',
    newSection: 'The product roadmap discussion focused on launching the enterprise tier in March and international expansion starting with UK and Germany in Q2.',
    keyTerms: ['revenue', 'enterprise tier', 'international expansion'],
  },
];

interface CondenseResult {
  model: string;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costDollars: number;
  error?: string;
}

async function runCondense(name: ChatModelName, previous: string, newSection: string): Promise<CondenseResult> {
  const { text: summary, ...completion } = await complete(name, {
    system: CONDENSE_SYSTEM,
    user: `Previous: ${previous}\nNew section: ${newSection}`,
    maxTokens: 256,
  });
  return { ...completion, summary };
}

function scoreCondense(summary: string, keyTerms: string[]): { matched: number; total: number; missed: string[] } {
  const lower = summary.toLowerCase();
  const missed: string[] = [];
  let matched = 0;
  for (const term of keyTerms) {
    if (lower.includes(term.toLowerCase())) {
      matched++;
    } else {
      missed.push(term);
    }
  }
  return { matched, total: keyTerms.length, missed };
}

const CONDENSE_RUNNERS = MODELS.map((name) => ({
  name,
  run: (previous: string, newSection: string) => runCondense(name, previous, newSection),
}));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const RUNNERS = MODELS.map((name) => ({ name, run: (text: string) => runExtraction(name, text) }));

async function main() {
  console.log('=== Fact Extraction Benchmark ===\n');
  console.log(`Models: ${RUNNERS.map((r) => r.name).join(', ')}`);
  console.log(`Test cases: ${TEST_CASES.length}\n`);

  const allResults: Array<{
    testCase: string;
    model: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    costDollars: number;
    recall: number;
    totalExtracted: number;
    matched: number;
    missed: string[];
    error?: string;
  }> = [];

  for (const tc of TEST_CASES) {
    console.log(`\n--- ${tc.name} (${tc.text.length} chars, ${tc.expectedFacts.length} expected facts) ---\n`);

    for (const runner of RUNNERS) {
      process.stdout.write(`  ${runner.name}... `);
      try {
        const result = await runner.run(tc.text);

        if (result.error) {
          console.log(`ERROR: ${result.error}`);
          allResults.push({
            testCase: tc.name,
            model: result.model,
            latencyMs: result.latencyMs,
            inputTokens: 0,
            outputTokens: 0,
            costDollars: 0,
            recall: 0,
            totalExtracted: 0,
            matched: 0,
            missed: tc.expectedFacts.map((f) => `(${f.s}, ${f.p}, ${f.o})`),
            error: result.error,
          });
          continue;
        }

        const quality = scoreQuality(result.facts, tc.expectedFacts);

        console.log(
          `${result.latencyMs}ms | ${result.facts.length} facts (${quality.taxonomicCount} filler) | ` +
            `recall ${(quality.recall * 100).toFixed(0)}% (${quality.matched}/${tc.expectedFacts.length}) | ` +
            `${result.inputTokens}+${result.outputTokens} tok | $${result.costDollars.toFixed(5)}`,
        );

        if (quality.missed.length > 0) {
          console.log(`    missed: ${quality.missed.join(', ')}`);
        }

        allResults.push({
          testCase: tc.name,
          model: result.model,
          latencyMs: result.latencyMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costDollars: result.costDollars,
          recall: quality.recall,
          totalExtracted: quality.totalExtracted,
          matched: quality.matched,
          missed: quality.missed,
        });
      } catch (err) {
        console.log(`FAILED: ${err}`);
        allResults.push({
          testCase: tc.name,
          model: runner.name,
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          costDollars: 0,
          recall: 0,
          totalExtracted: 0,
          matched: 0,
          missed: [],
          error: String(err),
        });
      }
    }
  }

  // -- Summary table --
  console.log('\n\n=== Summary ===\n');

  const byModel = new Map<string, typeof allResults>();
  for (const r of allResults) {
    const key = r.model;
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key)!.push(r);
  }

  const header = ['Model', 'Avg Latency', 'Avg Recall', 'Avg Facts', 'Total Cost', 'Errors'];
  const rows: string[][] = [];

  for (const [model, results] of byModel) {
    const valid = results.filter((r) => !r.error);
    const avgLatency = valid.length > 0 ? Math.round(valid.reduce((s, r) => s + r.latencyMs, 0) / valid.length) : 0;
    const avgRecall = valid.length > 0 ? valid.reduce((s, r) => s + r.recall, 0) / valid.length : 0;
    const avgFacts = valid.length > 0 ? Math.round(valid.reduce((s, r) => s + r.totalExtracted, 0) / valid.length) : 0;
    const totalCost = results.reduce((s, r) => s + r.costDollars, 0);
    const errors = results.filter((r) => r.error).length;

    rows.push([
      model,
      `${avgLatency}ms`,
      `${(avgRecall * 100).toFixed(1)}%`,
      `${avgFacts}`,
      `$${totalCost.toFixed(5)}`,
      errors > 0 ? `${errors}` : '-',
    ]);
  }

  // Print table
  const colWidths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const pad = (s: string, w: number) => s.padEnd(w); // also used below for condense table

  console.log(header.map((h, i) => pad(h, colWidths[i])).join('  '));
  console.log(colWidths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, colWidths[i])).join('  '));
  }

  // -- Summary condensing benchmark --
  console.log('\n\n=== Summary Condensing Benchmark ===\n');
  console.log(`Models: ${CONDENSE_RUNNERS.map((r) => r.name).join(', ')}`);
  console.log(`Test cases: ${CONDENSE_CASES.length}\n`);

  const condenseResults: Array<{
    testCase: string;
    model: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    costDollars: number;
    keyTermRecall: number;
    summaryLen: number;
    error?: string;
  }> = [];

  for (const tc of CONDENSE_CASES) {
    console.log(`\n--- ${tc.name} (${tc.keyTerms.length} key terms) ---\n`);

    for (const runner of CONDENSE_RUNNERS) {
      process.stdout.write(`  ${runner.name}... `);
      try {
        const result = await runner.run(tc.previous, tc.newSection);

        if (result.error) {
          console.log(`ERROR: ${result.error}`);
          condenseResults.push({
            testCase: tc.name,
            model: result.model,
            latencyMs: result.latencyMs,
            inputTokens: 0,
            outputTokens: 0,
            costDollars: 0,
            keyTermRecall: 0,
            summaryLen: 0,
            error: result.error,
          });
          continue;
        }

        const quality = scoreCondense(result.summary, tc.keyTerms);

        console.log(
          `${result.latencyMs}ms | ${result.summary.length} chars | ` +
            `terms ${quality.matched}/${quality.total} | ` +
            `${result.inputTokens}+${result.outputTokens} tok | $${result.costDollars.toFixed(5)}`,
        );
        console.log(`    "${result.summary}"`);
        if (quality.missed.length > 0) {
          console.log(`    missed terms: ${quality.missed.join(', ')}`);
        }

        condenseResults.push({
          testCase: tc.name,
          model: result.model,
          latencyMs: result.latencyMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costDollars: result.costDollars,
          keyTermRecall: quality.total > 0 ? quality.matched / quality.total : 1,
          summaryLen: result.summary.length,
        });
      } catch (err) {
        console.log(`FAILED: ${err}`);
        condenseResults.push({
          testCase: tc.name,
          model: runner.name,
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          costDollars: 0,
          keyTermRecall: 0,
          summaryLen: 0,
          error: String(err),
        });
      }
    }
  }

  // -- Condense summary table --
  console.log('\n\n=== Condensing Summary ===\n');

  const byModelCondense = new Map<string, typeof condenseResults>();
  for (const r of condenseResults) {
    if (!byModelCondense.has(r.model)) byModelCondense.set(r.model, []);
    byModelCondense.get(r.model)!.push(r);
  }

  const cHeader = ['Model', 'Avg Latency', 'Term Recall', 'Avg Chars', 'Total Cost', 'Errors'];
  const cRows: string[][] = [];

  for (const [model, results] of byModelCondense) {
    const valid = results.filter((r) => !r.error);
    const avgLatency = valid.length > 0 ? Math.round(valid.reduce((s, r) => s + r.latencyMs, 0) / valid.length) : 0;
    const avgRecall = valid.length > 0 ? valid.reduce((s, r) => s + r.keyTermRecall, 0) / valid.length : 0;
    const avgChars = valid.length > 0 ? Math.round(valid.reduce((s, r) => s + r.summaryLen, 0) / valid.length) : 0;
    const totalCost = results.reduce((s, r) => s + r.costDollars, 0);
    const errors = results.filter((r) => r.error).length;

    cRows.push([
      model,
      `${avgLatency}ms`,
      `${(avgRecall * 100).toFixed(1)}%`,
      `${avgChars}`,
      `$${totalCost.toFixed(5)}`,
      errors > 0 ? `${errors}` : '-',
    ]);
  }

  const cColWidths = cHeader.map((h, i) => Math.max(h.length, ...cRows.map((r) => r[i].length)));

  console.log(cHeader.map((h, i) => pad(h, cColWidths[i])).join('  '));
  console.log(cColWidths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of cRows) {
    console.log(row.map((c, i) => pad(c, cColWidths[i])).join('  '));
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
