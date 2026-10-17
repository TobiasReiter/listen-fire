# close-gate20 report

Branch close-gate20 (from c6171c60). Three fix commits plus this report.

## 1. Old-spelling integration movements
- Respelled with the upgrade tool's own parse-level fixes (a throwaway codemod over the test files' string arrays and templates; not committed): movement_engine suites callback_body_order, cross_run_locks, timer_resume, timer_resume_fanout, timer_resume_unwind, timer_resume_work; translation_graph save_warnings, listener_retire, validity_lifecycle, typed_event_dispatch; webhook_sync inbound_work. Assertions untouched.
- Second cause the gate report did not name: suites that insert a row into the movement table directly left `language_version` at its column default of 1. A firing then goes to the TypeScript engine, which cannot parse v5 text (MOV_EXPR_PARSE "Unexpected 'attio'"). Those inserts now carry the current language version (timer_resume, fanout, unwind, work, callback_body_order, typed_event_dispatch, inbound_work).
- Behaviour decisions: the two version 3 programs in timer_resume_unwind (parallel combinator, `r[0]` indexing) keep the version 3 spelling (their own old-spelling prelude) and stay pinned to 3 there (seed now stamps the row with opts.languageVersion). park_sink respells its shared fixture with `spelledFor(5, ...)` as the unit suites do (the fixture file stays in the old spelling because await_park / seam_guard unit tests respell it themselves). pinned_resume already respells with `spelledFor`; left alone.

## 2. Test DB
- listenfire_test (9432) was already fully migrated when I started (ledger through 20261016_233755, the engine_reason drop, and the library-source migration); the jest globalSetup runs migrate.sh on every run anyway. Nothing to apply. The 4 run_engine_record failures in the gate report are gone (suite passes).
- Worktree needed `pnpm install --offline --frozen-lockfile` and `npx prisma generate` (client not generated in a fresh worktree).

## 3. timer_resume_work uuid error "req-kept"
- Cause: with the movement refused, the run never parked and was abandoned; abandoning a run cancels its `ask` awaits by looking the correlation key up as an ask id (uuid column), and the test's key `req-kept` was not a uuid. Reproduced on the old file (error at ask store getAsk via abandonRun). The test key is now a real uuid, so the fixture is honest if a run is abandoned in error. No product code change.

## 4. dev:whatsapp setup
- Both movements respelled (`connect whatsapp`, `connect slack using ...`, `function`) and the intake's `WHERE `Name`` now reads `ch.`Name`` (the spelling-only fixer cannot see that one; the checker flagged it). Checked with the Rust checker over the static catalog: no MOV_V5_SPELLING left (other diagnostics there are only the thin static catalog's missing whatsapp/slack descriptions). NOT run through a live `pnpm dev:whatsapp setup` (needs the dev-loop stack and apps/api/.env, which I must not read).
- Other dev scripts under apps/api/src/scripts/dev (airtable, dealroom, granola, telegram, gmail, evertrace, verify_*, ...) are still old spelling; out of this brief, flagged.

## 5. Results (test DB 9432, one run at a time, no Redis, no LOOP_GUARD override)
- movement_engine integration: 18/18 suites, 142/142 tests (includes limit_pause and pinned_resume).
- translation_graph integration: 23/23 suites, 115/115 tests.
- Pattern `work`: the pattern matches ".claude/worktrees" in the path, so it ran the whole integration set: 77 suites, 549 passed, 1 failed. The one failure is services/__test__/navigation_state.integration.test.ts "records each pinned name in navigation_history" (history length 0), deterministic, in code none of this touches; not in the gate's legs. Not investigated.
- `pnpm code:type-check` in apps/api: clean.
- Shared files touched: none outside test files, apps/api/src/scripts/dev/whatsapp.ts, CHANGELOG (### close-gate20). reachability_gaps.ts, checkers, wasm untouched.
