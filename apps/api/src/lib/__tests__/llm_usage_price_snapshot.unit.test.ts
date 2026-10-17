import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Every price the product charges, pinned to the microdollar. The fixture was
// generated from the table as it stood in llm_usage.ts, before the prices moved
// into movement-engine's prices.json; a price changes only by regenerating it
// on purpose (PRICE_SNAPSHOT_REGENERATE=1) and reading the diff.

jest.mock('movement-engine/services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../kysely', () => ({ getQb: () => ({}) }));

import { calculateCostMicrodollars } from '../llm_usage';

const CLAUDE = [
  'claude-fable-5-1',
  'claude-opus-4-6',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-opus-4-20250514',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
];

const KEYS: Array<[string, string]> = [
  ...CLAUDE.flatMap((model): Array<[string, string]> => [
    ['anthropic', model],
    ['vertex', model],
  ]),
  ['openai', 'gpt-4.1'],
  ['openai', 'gpt-4.1-mini'],
  ['openai', 'gpt-4.1-nano'],
  ['openai', 'gpt-5'],
  ['openai', 'gpt-5-mini'],
  ['openai', 'gpt-5-nano'],
  ['openai', 'o3'],
  ['openai', 'text-embedding-3-large'],
  ['openai', 'text-embedding-3-small'],
  ['openai', 'gpt-image-1'],
  ['gemini', 'gemini-3.1-pro-preview'],
  ['gemini', 'gemini-3.8-flash'],
  ['gemini', 'gemini-embedding-001'],
  ['anthropic', 'not-a-priced-model'],
];

// Each token kind alone (so each rate is pinned separately), then a mix whose
// rounding is not a whole number.
const VECTORS = [
  { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
  { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 },
  { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000 },
  { inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89, cacheCreationTokens: 13 },
  { inputTokens: 3, outputTokens: 1, cacheReadTokens: 7, cacheCreationTokens: 5 },
];

function snapshot(): Record<string, number[]> {
  return Object.fromEntries(
    KEYS.map(([provider, wireModel]) => [
      `${provider}/${wireModel}`,
      VECTORS.map((vector) =>
        calculateCostMicrodollars({ served: { provider, wireModel, preferred: 'claude-sonnet-5' } as never, ...vector }),
      ),
    ]),
  );
}

const FIXTURE = join(__dirname, 'fixtures', 'price_snapshot.json');

it('prices every model to the microdollar exactly as the pinned fixture', () => {
  const actual = snapshot();
  if (process.env.PRICE_SNAPSHOT_REGENERATE === '1') writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
  expect(actual).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
});
