// Per test file, under `MOVEMENT_ENGINE=rust`: what the evaluator switch did
// (`rustEvalStats`) and the whole runs routed (`rustRunStats`), written where
// the run's global teardown
// (rust_eval_stats.teardown.cjs) adds it up. Nothing under the TypeScript engine.

import { appendFileSync } from 'node:fs';
import path from 'node:path';

import { resetRustEvalStats, resetRustRunStats, rustEvalStats, rustRunStats } from '../services/movement_engine/rust_stats';

const dir = process.env.MOVEMENT_RUST_EVAL_STATS_DIR;

if (process.env.MOVEMENT_ENGINE === 'rust' && dir !== undefined) {
  beforeAll(() => {
    resetRustEvalStats();
    resetRustRunStats();
  });
  afterAll(() => {
    const file = path.basename(expect.getState().testPath ?? '');
    appendFileSync(path.join(dir, `${process.pid}.jsonl`), `${JSON.stringify({ ...rustEvalStats, runs: rustRunStats, file })}\n`);
  });
}
