# ev2-merge report

Branch `ev2-merge` from `cloud-native` da4342f9 (cloud-native untouched, nothing pushed).

## Merges (one merge commit each, in order)
- da9a153c ev2-cbhost — clean.
- 0955250e ev2-plugins — CHANGELOG, boundary baseline.
- bff2c483 ev2-secrets — CHANGELOG.
- 5aefb98d ev2-inbound — CHANGELOG, boundary baseline.
- e1a34d00 ev2-lfengine — CHANGELOG.
- 274b01cd fix-up: the public entries test (below).

Resolutions:
- CHANGELOG: every `### ev2-*` section kept, in merge order (cbhost, plugins, secrets, inbound, lfengine).
- Boundary baseline: regenerated after each merge with `node scripts/check-engine-boundary.cjs --update`.
- No other file was touched by more than one branch (the remote adapter, protocol client, server.ts, Cargo.lock, the cli tests and the public entries merged without conflict).
- Fixtures: no branch worktree has untracked or ignored test data, and no `fixtures/` folder exists in any of them. The plugin recording is committed at `movement/__test__/__fixtures__/plugin_catalog.json`. Nothing was missing.

## Boundary count: 799 (from 813 at da4342f9)
- The branches lowered it by different, disjoint amounts: cbhost 1, plugins 6, inbound 7, secrets 0, lfengine 0.
- 813 − 14 = 799. That is lower than the lowest any single branch reached (806, inbound), as expected when the reductions add up.

## Fix-up made at the merge
- `public_entries.unit.test.ts` asserted the secrets entry was empty (a wave-1 placeholder). ev2-secrets filled that entry and did not run this test, so the test failed after the merge.
- The test now checks that the secrets family, the plugins entry and the inbound core are all exported.

## Verify
- `pnpm -r code:type-check`: exit 0, boundary guard included (799 = baseline).
- `cargo test --workspace`: 591 passed, 0 failed, 2 ignored (50 test binaries). `cargo clippy --workspace --all-targets -D warnings`: clean.
- packages: engine-contracts 54/54, model-providers 147/147, file-text 8/8.
- apps/api unit, scoped (services/inbound golden + contract + schemes, credentials incl. vault contract, callbacks doors, catalog / plugin_catalog_equality / transform_invoker, remote adapter, protocol): 31 suites, 489/489.
- apps/api `services/movement_engine/` (--maxWorkers=4): 131 suites, 3969/3970 before the fix-up. The one failure was the public entries test; after the fix-up it is 3/3.
- apps/cli, TypeScript lf: 183 tests, 172 pass, 0 fail, 11 skipped (real sops is not installed). This includes the SQLite and Rust run-host contract suites and both lf-host parity files.
- apps/cli with `LF_BIN=target/debug/lf-host`, file by file:
  - catalog 4/4, externals 3/3, pins 3/3.
  - callbacks 0/5: callbacks and cancel (G5).
  - example_project 3/9: serve and webhooks (G5).
  - models 0/2: model calls (G6).
  - secrets_identity_files 9/13: credential refresh (G4).
  - secrets_declared 0/1: new from ev2-secrets, needs credential refresh (G4).
  - upgrade 0/2: `lf-host` has no `upgrade` command (`unknown option "--check"`). This is outside G4–G6 and was outside lfengine's six measured files. It is a gap in the command set, not a regression.
  - The six files lfengine measured: 19/36, the same as its report.
- Integration, test DB 9432, run one at a time:
  - inbound_work 17/17 (its first execution: ev2-inbound could not run it).
  - secrets_postgres 15/15.
  - callback_body_order 4/4, callback_fire_race 9/9, callback_revocation 3/3, callback_store 25/25.
  - run_host_contract (Postgres) 42/42.
