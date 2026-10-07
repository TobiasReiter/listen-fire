// W3-A2 — Integration test config.
//
//   - `globalSetup` applies migrations to the test DB once before any
//     tests run (idempotent, via `migrate.sh`).
//   - `setupFiles` runs once per worker process before any test file
//     imports — used to redirect the production Kysely pool from the
//     dev-loop DB to the test DB and clear `NODE_ENV=test` so the
//     prisma module's per-process random schema synthesis is bypassed.
//   - Integration tests are serial (`maxWorkers: 1`) because they
//     share a single Postgres database. Suites do write under their own
//     random team, but several run cross-team scans against it — the work
//     drainer and claim, the closed-ask sweep, the run orphan sweep — which
//     would claim or rewrite a concurrent suite's rows. Parallelism needs a
//     database per worker (cloned from the migrated one), not team scoping.

// eslint-disable-next-line local-rules/bottom-exports
export default {
  // Automatically clear mock calls and instances between every test
  clearMocks: true,

  // Serial: one shared test DB and cross-team scans (see the header).
  maxWorkers: 1,

  rootDir: '../../',

  // The glob patterns Jest uses to detect test files
  testMatch: ['**/*.integration.test.ts'],

  globalSetup: './src/test/globalSetup.ts',
  // Runs once per worker BEFORE any module imports. This redirects
  // the production Kysely's module-level pool from the dev-loop DB
  // to the test DB.
  setupFiles: ['./src/test/harness/env.ts'],
  // ts-jest required for Prisma >= 5.10.x. Transpile only: types are owned
  // by `pnpm code:type-check`.
  preset: 'ts-jest',
  transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true, diagnostics: false }] },
  testEnvironment: 'node',
  // Real-DB integration tests need a generous timeout — migration
  // application + ontology seeding can take 5-10s on first run.
  testTimeout: 60000,
  // The production Kysely module's connection pool is opened at
  // module load and never destroyed. Force exit after tests run
  // rather than threading a teardown through every consumer.
  forceExit: true,
};
