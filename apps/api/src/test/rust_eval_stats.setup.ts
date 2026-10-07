// Per test file, under `MOVEMENT_ENGINE=rust`: what the evaluator switch did
// (rust_engine.ts `rustEvalStats`), written where the run's global teardown
// (rust_eval_stats.teardown.cjs) adds it up. Nothing under the TypeScript engine.

import { appendFileSync } from 'node:fs';
import path from 'node:path';

import { resetRustEvalStats, rustEvalStats } from '../services/movement_engine/rust_engine';

const dir = process.env.MOVEMENT_RUST_EVAL_STATS_DIR;

if (process.env.MOVEMENT_ENGINE === 'rust' && dir !== undefined) {
  beforeAll(() => resetRustEvalStats());
  afterAll(() => {
    appendFileSync(path.join(dir, `${process.pid}.jsonl`), `${JSON.stringify(rustEvalStats)}\n`);
  });
}
