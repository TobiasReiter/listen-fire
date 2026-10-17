// Writes what the oracle files still record about the TypeScript engine, which
// tests/order_limit_pin.rs and tests/priced_pin.rs hold the Rust engine to,
// and what the Rust engine itself does with seeded programs:
//   - order_limit.json: a hop's pushdown and ORDER BY / LIMIT plan
//     (./order_limit_oracle.ts; not ./order_limit, which Node resolves to
//     the .json beside it);
//   - priced.json: the priced-plugin cap (./priced_oracle.ts);
//   - patterns.json: what the Rust engine, the version 5 reference, does
//     with seeded programs for each pattern of the language, run through the
//     real shim against one scripted host (./patterns_oracle.ts; the report
//     is ./patterns_report.ts, `pnpm engine:patterns`). A program that ends
//     where its pattern does not say fails the generator.
// records.json, handles.json and parallel.json are no longer written: they
// were the TypeScript engine's runs, which the Rust engine is no longer held
// to (Rust is the version 5 reference). Their programs stay, frozen, as
// corpora: the reachability test, the checker parity harness and the
// upgrade corpus read them.
// The built-ins, the regex matcher, CHUNKS, the file bound and the mixed key
// sort are no longer written here: Rust owns their answers
// (tests/frozen/*.jsonl, regenerated from Rust: see tests/frozen/mod.rs).
// Deterministic: a rerun writes the same bytes (CI diffs them). Some answers
// read local time (an offset-less date-time is local to `new Date`), so the
// process runs in UTC wherever it is started.
//
// Regenerate from apps/api (for its ts-node and compiler settings):
//   TS_NODE_PROJECT=tsconfig.json npx ts-node --transpile-only \
//     ../../crates/movement-engine/tests/oracle/generate.ts

// Before anything reads the clock: Node re-reads TZ when it is assigned.
process.env.TZ = 'UTC';
// The engine's modules read these as they load (patterns_oracle.ts runs whole
// programs in process); nothing the oracle runs reaches a database.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL_TEST ??= 'postgresql://oracle:oracle@localhost:5432/oracle-unused';
process.env.DATABASE_URL_TEST_READONLY ??= 'postgresql://oracle:oracle@localhost:5432/oracle-unused';
process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.SCRAPER_API_KEY ??= 'oracle-unused';

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { writePricedOracle } from './priced_oracle';
import { writeOrderLimitOracle } from './order_limit_oracle';
import { writePatternsOracle } from './patterns_oracle';

// ── Seeded randomness ─────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Awaited, and a failure fails the generator: CI's "oracle is current" step
// must not pass on a pin that was never written.
(async () => {
  await writeOrderLimitOracle(mulberry32(5));
  await writePricedOracle(mulberry32(20261009));
  // The Rust engine: the movement.wasm the shim loads is the one committed.
  await writePatternsOracle(mulberry32(20261015), (name, text) => writeFileSync(path.join(__dirname, name), text));
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
