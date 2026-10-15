// Review Focus 3, the v1 corpus: every recorded run of the v1 engine corpus
// (the TypeScript engine's conversations with each test's host, harvested by
// `UPDATE_ENGINE_RUNS=1 pnpm test:conformance:v1`) replays identically
// against three hosts and engines: the TypeScript engine answered in process,
// the Rust engine through its shim, and the TypeScript engine against the HTTP
// host double. Identically means every request matched (the kit's matching
// rule), none left unmade, and the same result or the same failure.
//
// The Rust target takes only the recordings whose program the shim routes and
// the Rust engine runs whole; the rest are skipped, with the reason, never
// failed. Its floor, like the corpora's routing floors, catches a regression
// that hands the runs quietly back to the TypeScript engine.

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { replayCorpus } from './engine_runs_replay';

describe('the v1 corpus\'s recorded runs', () => {
  replayCorpus('v1');
});
