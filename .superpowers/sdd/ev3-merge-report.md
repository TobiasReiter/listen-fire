# ev3-merge report — everywhere wave 3 merged

Branch `ev3-merge` from cloud-native 30843618. Not pushed; cloud-native untouched.

## Merges (one merge commit each, in this order)
- ev3-oauthfake: clean.
- ev3-otherdoors: CHANGELOG only (kept both sections).
- ev3-connect: CHANGELOG, and the Dropbox auth client. Resolved by intent: the connector runs on the Dropbox declaration; the dev loop's `fakeBaseUrl` now swaps the declaration's authorize and token URLs, so the fake provider still serves both the connect flow and the refresh.
- ev3-lfdoors: CHANGELOG, and one import line in lf's main file (kept both imports).
- ev3-kit: CHANGELOG, and lf's externals file (the running external carries both `inbound` and `plugins`).
- Every other known overlap merged without conflict: the inbound core files, the public entries, lf's serve/doors/state, the remote adapter, Dockerfile, build script, workspace, dev/loop.sh.

## Reconciliation
1. **One signed-inbound rule.** lf's doors now take the core's `declaredInboundVerifier` for every external: a manifest's `inbound`, and a `webhook:` block alone (read as the protocol's own scheme, as lfdoors already did). lf's own copy of the rule is deleted. One small tightening: the core also treats a whitespace-only secret as missing.
2. **The over-1 MB push case passes against `lf serve`.** No code change was needed: lf serve already answered the JSON 413.
3. **lf-host's state schema has `inbound_checkpoint`.** The schema-equality cargo test failed before this change and passes after it.
4. **Both fake OAuth servers are kept, because they serve different needs.**
   - The engine's in-process one (public/secrets-testing) is for unit tests in apps/api and apps/cli. It runs with no fake-channels process, and engine code may not import an app. It checks client auth and PKCE.
   - The fake-channels one is the dev loop's. It keeps persistent entities and the control surface that `dev:inject` and `dev:inspect` drive.
   - Each file's header now names the other.
5. **The shared code exchange retries, for all providers.**
   - It retries a 5xx answer or a network error, with at most 3 tries and waits of 250 ms then 500 ms. Any other answer is not retried.
   - A network error that persists now surfaces as an exchange failure with no status, instead of the raw fetch error.
   - 4 new tests.
6. **tRPC types.**
   - Cause: since the engine moved into its own package (d7c20741, Oct 15), it is a dependency of apps/api. tsup's declaration bundle leaves every dependency as an import instead of inlining it. The last regeneration (ac9c1b22, Oct 8) predates the move.
   - Fix: the shared tRPC package now lists `movement-engine`, as it already lists `movement-lang` and `story-view`.
   - The stray `CapturedWrite` import came from the test-run module reaching an engine internal. It now imports through the public adapter entry.
   - One engine file re-exported a type in a way web's `isolatedModules` setting refuses. It now uses `export type`.
   - The types are regenerated and committed, and apps/web type-checks.
7. **Old server kit path.** Nothing in the tree still points at the old protocol server path (searched apps, packages, scripts, docs, crates and modules).

**Engine boundary baseline: 779.**
- 799 at base.
- 780 after ev3-kit repointed the moved adapter helpers.
- ev3-otherdoors' moves were net zero.
- 779 after the test-run module's `CapturedWrite` import went through the public entry.

## Verification
- **Full type-check passes**, with both boundary guards (`NODE_OPTIONS=--max-old-space-size=8192 pnpm -r code:type-check`, exit 0).
  - Module boundary: 28 files, nothing reaching the hosted product, a database or the recording layer.
  - Engine boundary: 779, equal to the baseline.
  - apps/web type-checks against the regenerated tRPC types.
- **Cargo:** `cargo test --workspace` 592 pass, 0 fail. `cargo clippy --workspace --all-targets -D warnings` is clean.
- **Package tests all pass:**
  - module-kit 43/43
  - @lf/dealroom 43/43
  - engine-contracts 58/58
  - model-providers 147/147
  - file-text 8/8
  - fake-channels 58/58
- **apps/cli on the TypeScript lf:** 223 tests, 211 pass, 0 fail, 12 skipped.
- **apps/cli on lf-host (`LF_BIN=target/debug/lf-host`):** 223 tests, 187 pass, 24 fail, 12 skipped. All 24 failures are commands or features lf-host does not have yet:
  - G4, secrets (9 tests): `lf connect` (3); the Dealroom module's declared credential (1); credential refresh from a declaration (5).
  - G5, doors and callbacks (11 tests): call and cancel (5); `run --webhook` (1); `serve` and its doors (5). lf-host refuses `--port` as an unknown option.
  - G6, model calls (2 tests).
  - `lf upgrade` (2 tests): lf-host already lists upgrade as not yet implemented. This predates wave 3, and nothing in this range touched it.
- **apps/api scoped unit runs all pass:**
  - Inbound (golden and contract), webhook_sync, the email doors, credentials and connect, translation_graph adapters, registry and protocol, dealroom, public_entries, seam_guard: 99 suites, 1,695 pass, 1 skipped.
  - The Dropbox, Attio, Airtable, Google, Gmail, Slack and remote adapters, plus movement, engine host, transform invoker, built-in modules and poll source: 13 suites, 115 pass.
  - The movement_engine directory (`--maxWorkers=4`): 131 suites, 3,970 pass.
- **Integration (test DB 9432, one suite set at a time; env as in the gate 21 brief, placeholder `ENCRYPTION_*` values from .env.example):**
  - secrets_postgres 15/15.
  - The four callback suites (fire race, store, body order, revocation) 41/41.
  - catalog_connect 3/3. This is the registry and connect integration suite; no integration suite is named for dealroom.
  - knowledge_conversations 12/12. It loads the real adapter registry.
  - inbound_work 17/17 when run alone. It failed twice when run first in the set: 1 failed (expected 1 failed row, got 19), then expected 1 got 2.
    - The cause is outside this branch. The shared test DB holds work rows with no team, left by other suites (a `timer_sweep` row and `fire_callback` rows). The test counts failed rows across every team, and a leftover row whose retry falls inside the counted drain adds to the count.
    - The same file passed on ev3-otherdoors right after. The third run on this branch passed 17/17.
    - This is a test fragility: the test should count only its own team's rows. It is not a regression.

## Not done / flags
- The dev loop was not booted. This merge had no brief for it; ev3-oauthfake proved its own flow there.
- `apps/web` was type-checked but not built with Next. The tRPC types now import `movement-engine/public/*`. Those imports are type-only and are dropped at build, as the existing `movement-lang` imports are.
