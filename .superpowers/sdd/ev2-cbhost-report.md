# ev2-cbhost

Hosted `executeFire` (apps/api callback_fire.ts) is now a call to the core's `runCallbackBody` over `postgresCallbackStore` and `hostedRunHost()`. The core re-checks the call, marks the body started under the lease, runs the body, and wakes the run's awaits. Hosted keeps only the body itself (`fireCallbackFiring`), the per-run slot, the lease handling, and the 202 / queued-row path.

- Work kind `fire_callback`, ids, URLs, door answers and rows: unchanged.
- The queued-row handler's refusal check moved into the core; the status check on the run is passed as `runOpen`.
- `drainRunAwaits` deleted (the core drains); `awaitStepper` exported from await_resume.ts.
- Engine boundary baseline lowered 813 -> 812.
- Test callback_fire_race.integration: the lease-loss spy retargeted from the module function to `postgresCallbackStore.markBodyStarted` (the seam hosted now goes through).

Tests: unit (callback, await_resume, run_lease, park sink, run_host, seam) 80/80; integration one run, test DB 9432: callback_fire_race 9, callback_store, callback_body_order, callback_revocation, run_host_contract (Postgres contract) 83/83 in total; lf cli suite 131/131 (includes callback e2e and the SQLite contract); apps/api type-check clean.
