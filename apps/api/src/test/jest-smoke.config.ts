// Fast, bounded regression smoke set for CI — the high-risk paths, NOT the full
// suite. Unit-only (no DB), so it stays fast and can't OOM/timeout. Keep this
// list curated as coverage of vulnerable paths grows.
//
// CI's job (solo project) is prod-safety smoke detection: this catches
// behaviour regressions in the engine's decision logic, the inbound security
// boundary, the human-in-the-loop escalation, and the file-capability route.
//
// eslint-disable-next-line local-rules/bottom-exports
export default {
  clearMocks: true,
  maxWorkers: 2,
  testTimeout: 30000,
  rootDir: '../../',
  preset: 'ts-jest',
  // Transpile only: types are owned by `pnpm code:type-check`.
  transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true, diagnostics: false }] },
  testEnvironment: 'node',
  // Engine tests that still live here reach engine internals, which the
  // package's exports map resolves only under this condition.
  testEnvironmentOptions: { customExportConditions: ['node', 'node-addons', 'movement-engine-internals'] },
  // Inert env defaults so the suite loads env-reading modules (prisma, adapters)
  // without a real .env and without touching real systems. See the file header.
  setupFiles: ['<rootDir>/src/test/test-env-defaults.ts'],
  testMatch: [
    // Entity dedup/merge arbiter — runs on every write; wrong call = dup/merge.
    '**/engine/__test__/entity_match.unit.test.ts',
    // Ask escalation ladder — wrong rung strands/wrongly-fails a paused run.
    '**/interaction/__test__/deadline.unit.test.ts',
    // Inbound webhook signature verification — the security boundary.
    '**/webhook_sync/providers/__test__/signature-verification.unit.test.ts',
    // File-capability route — 302/410/500/502, incl. the prefix guard.
    '**/interfaces/rest/__test__/files-blob.unit.test.ts',
    // Trigger routing + run-mode/loop/echo gates.
    '**/triggers/__test__/r_routing.unit.test.ts',
    // KG-mutation dispatch (single-listener routing/filtering — the 2-way-sync
    // re-dispatch case was removed with 2-way-sync safety).
    '**/triggers/__test__/movement_mutation_dispatch.unit.test.ts',
    // Movement engine execute + run-now (the core firing paths).
    '**/movement/__test__/execute.unit.test.ts',
    '**/movement/__test__/run_now.unit.test.ts',
    // Poll-source worker (due/skip/checkpoint).
    '**/poll_source/__test__/worker.unit.test.ts',
  ],
};
