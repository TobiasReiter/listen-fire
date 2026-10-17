# ev1-public report (F1)

Done. Entries under packages/movement-engine/public/: movement-engine, host, run-host, adapter, catalog, inbound, secrets, models, files, log, testing. All re-export what exists at 4ba5f821.
- secrets.ts is empty (`export {}`): nothing in the package is a public answer about credentials yet.
- `engineRoute` = `engineFor` (aliased). `programCheck` is a namespace export plus the same functions by name.
- `ENGINE_VERSION` = '0.11.0', duplicating apps/cli `CURRENT_ENGINE_VERSION` (cli not touched; it should import this in F2).
- log.ts: `logger` plus `routeEngineLogsTo(sink)` (swaps the winston console transport for a sink, returns a restore function). logger.ts itself is unchanged.
- testing.ts includes run_host/contract cases besides test_host.

Guard: scripts/check-engine-boundary.cjs (TS compiler API; import/export-from/require/dynamic import/import type; relative paths into the package count too). Baseline scripts/engine-boundary-baseline.json; `--update` rewrites, `--list` lists sites. Fails if the total or any module's count grows. Wired as the last step of apps/api `code:type-check`. Production = apps/api/src minus *.test/spec, __test__/__tests__/__conformance__/__fixtures__, src/test/, src/scripts/dev/. apps/cli is not scanned.

Baseline: 850 imports of 69 internal modules. By area: logger 236; translation_graph/adapter 136; translation_graph/types 101; lib/utils 80; movement_engine 47; triggers 41; lib/models 38; knowledge_pipeline/output_v3 25; translation_graph/movement 22; handbook_section 19; run_host 18; translation_graph/engine 18; run_spend 11; mutation_context 10; google_cloud 6; run_cost 6; uniqueness 6; segment_scope 5; protocol 4; write_locks 4; remainder under 4 each. Per module in the baseline file.

Tests: apps/api movement_engine/__test__/public_entries.unit.test.ts, 3 pass. package tsc clean; apps/api `pnpm code:type-check` green with the guard at 850/850. Guard growth failure checked by hand.
Files outside stream touched: apps/api/package.json (code:type-check line), CHANGELOG.md.
