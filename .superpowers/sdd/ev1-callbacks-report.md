# ev1-callbacks (stream E, plan #5): lf callbacks and cancel

Branch `ev1-callbacks`, cut from 4ba5f821. Done tier.

## What landed

- **Run host core callback family.** `packages/movement-engine/services/run_host/store.ts` gains `CallbackStore`, which covers mint, get, record, markBodyStarted, landed and revokeRun.
  - `record` is one atomic step: it records the call and queues the body's work row.
  - `markBodyStarted` is fenced by the run lease.
- **Callback rules, written once.** `run_host/callbacks.ts` holds:
  - the `cb_` id and the url
  - value validation (moved from the hosted store) and the refusal rule
  - the engine's callback sink
  - the keeper (an await on a callback is resolvable once a call landed)
  - `recordCallbackCall`, which validates, records, and queues a backstop wake
  - `runCallbackBody`, which runs under the lease: re-check, mark started, run the body, then wake the run's awaits
- **Postgres backend.** `apps/api/.../callback_store.ts` exports `postgresCallbackStore` over the existing table and functions.
  - Nothing changed in the schema, ids, urls, door answers or work rows.
  - The hosted sink and keeper are now the core's, over that backend.
  - The hosted claim and body queue go through `claimCallbackFireWithBody`.
- **SQLite backend.** lf's `apps/cli/src/state.ts` gains a `callback` table and the `fire_callback` work kind.
  - The `run` table gains cancel columns; older state files get them added on open.
  - Every way a run ends revokes its live callbacks.
- **lf commands and config.**
  - `POST /api/cb/<id>` in `lf serve`, taking values from a JSON body or the query string.
  - `lf call <id> [--body <values.json>]`.
  - `publicUrl` in lf.yaml.
  - `lf cancel <run> [--reason]`. A parked run is settled through the core's settle-cancelled path. A run being stepped elsewhere is stopped by the host's cancel gate.

## Decisions

- **The callback family is its own interface, not a member of `RunHostStore`.** A store serving only live run state (ev1-lfhost's RPC bridge) keeps passing the existing cases. The new cases are separate lists: `callbackContractCases` (9) and `cancelContractCases` (3), over `RecordsContractBackend`.
- **The work kind stays `fire_callback`.** It keeps the hosted key and payload shape, so rows already queued in existing deployments still run.
- **Hosted fire orchestration is unchanged.** That covers the per-run slot, `executeFire` and the 202 path. lf runs the core's `runCallbackBody`. Follow-up: move hosted `executeFire` onto `runCallbackBody`.
- **The lf door is POST only.** There is no GET confirm page. Status codes mirror the hosted door: 200, 202, 400, 404, 410.
- **The lf cancel gate reads the run's row at every engine boundary.** There is no debounce, because the read is one SQLite lookup. Once cancelled, it latches.

## Tests

- **Contract on SQLite.** `apps/cli/src/__test__/run_host_contract.test.ts`: 42 of 42 pass (30 existing + 12 new).
- **Contract on Postgres.** `run_host_contract.integration.test.ts`: 42 of 42 pass. The same run also passed the 4 existing callback integration suites (store, fire race, body order, revocation): 83 of 83 in total.
  - These ran against the test DB on 9432, with `DATABASE_URL_TEST` taken from the checked-in `apps/api/.env.example`. The worktree has no `.env`, and none was read.
- **lf end to end.** `apps/cli/src/__test__/callbacks.test.ts`, 5 cases:
  - `lf call` refuses a mismatch, runs the body once, resumes the run, and answers a second call closed.
  - A call while another process holds the run leaves the body queued, and `lf resume` runs it.
  - The serve door answers 404, 400 and mismatch, then 200, and the awaiting run resumes. It then answers 410, and the url sits under `publicUrl`.
  - `lf cancel` settles a parked run failed with its reason and closes its callback.
  - A cancel while another process holds the run is caught by the gate; the engine stops the next segment before the body writes. This runs through the real Rust engine path.
- **Full lf set.** 90 of 90 pass.
- **Hosted unit tests.** Callback, door, await resume, park sink, run lease and seam guard suites: 102 + 148 + 31 pass.
- **Type-check.** Clean for apps/api, apps/cli and packages/movement-engine.

## Files outside my stream

- `apps/cli/src/serve.ts`: besides the callback route, I changed two lines. The url split now also keeps the query string. The run log line prints `called` for a callback's body.
- `CHANGELOG.md`: lines under `### ev1-callbacks`.

## Not done, and an observation

- **Rust SQLite contract.** The callback and cancel cases have not run on a Rust store. That belongs to ev1-lfhost's RPC bridge, which needs `RecordsContractBackend`.
- **Observation, not changed: a stale lease holder can still mark a run failed.** The core's `settleIfCancelRequested` calls `failRun`, which marks the run failed before the fenced teardown. So a holder whose lease lapsed still marks the run failed, while tearing nothing down. A cancel was requested, so failed is the right final status anyway.
