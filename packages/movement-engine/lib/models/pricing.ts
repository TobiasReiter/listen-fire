import pricing from './prices.json';

// The prices live in prices.json (not pricing.json: `require('./pricing')` would resolve to
// the JSON before this file) so the Rust host reads the very same file.
// Sources, kept here because JSON has no comments:
//   OpenAI: https://pricepertoken.com/pricing-page/provider/openai (Feb 2026);
//     gpt-image-1: https://developers.openai.com/api/docs/pricing (checked 2026-09-24), per
//     million tokens: text input $5, cached text input $1.25, image output $40. OpenAI also
//     prices image INPUT tokens at $10, which this table cannot tell apart from text input;
//     generation sends only a text prompt, so none arise.
//   Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-09-24):
//     base input, output, cache hits, 5m cache writes. Fable 5.1's cache hits are 0.025x its
//     input price, not the usual 0.1x. Sonnet 5's $2/$10 is the standard rate: the increase to
//     $3/$15 once scheduled for September 2026 was withdrawn (read 2026-09-25).
//   Embeddings: https://platform.openai.com/docs/models/text-embedding-3-large
//   Google: https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
//     (2026-09-17), the GLOBAL endpoint's base (<=200K input) tier. Above 200K input tokens
//     gemini-3.1-pro-preview becomes $4.00/$18.00, a tier this table cannot express, so a very
//     long prompt is under-priced rather than unpriced. gemini-3.8-flash's introductory
//     $0.75/$3.75 applies through 2026-12-31, then reverts to the listed standard rates.
//     gemini-embedding-001 is $0.00015 per 1,000 "count" ($0.15 per million) and Google hands
//     back its own `token_count`, which is what we record, so one count is one token.
//   gpt-4.1-nano is deprecated 2026-10-23.
//
// Keyed on `provider/wire-model` — who served the call and what it was called on their wire —
// because that pair, not the name the caller asked for, is what a vendor bills. Claude on
// Vertex is priced as on Anthropic's own API (every Claude name appears under both).

/** Dollars per million tokens. A missing cache rate bills at the input rate. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const PRICES: Readonly<Record<string, Price>> = pricing.prices;

export function priceFor(key: string): Price | undefined {
  return Object.hasOwn(PRICES, key) ? PRICES[key] : undefined;
}

/** What a call cost, in microdollars; `undefined` when the key has no price. */
export function costMicrodollars(key: string, tokens: TokenCounts): number | undefined {
  const price = priceFor(key);
  if (!price) return undefined;
  const inputCost = tokens.inputTokens * price.input;
  const outputCost = tokens.outputTokens * price.output;
  const cacheReadCost = tokens.cacheReadTokens * (price.cacheRead ?? price.input);
  const cacheCreationCost = tokens.cacheCreationTokens * (price.cacheCreation ?? price.input);
  return Math.round(inputCost + outputCost + cacheReadCost + cacheCreationCost);
}
