# lfr-store report: G7, the Postgres run-host store and drain

Branch `lfr-store`, cut from 9cfa02d3. Status: **done**.

## Read

- The Rust lf can now keep its run state in Postgres, not only in its SQLite state file.
  - It uses the hosted product's own tables, statement for statement as the hosted backend does. No table is new.
  - You choose the store with `--store postgres://…` or with lf.yaml's `store:`. The default is still `.lf/state.db`.
- `lf-host drain --store <url> --until-idle --max-seconds N` is the scale-from-zero worker.
  - It claims one due work row at a time under the row's lease and runs the segments that row asks for.
  - It exits when nothing is due, or stops claiming at the deadline.
- Evidence:
  - The run-host contract passes 42 of 42 against the Rust Postgres store on the test database: 30 run-host cases, 9 callback cases, 3 cancel cases.
  - The drain test parks 6 runs and drains them with two concurrent workers. Every run is resumed exactly once, each follow-up write lands once, and no work rows are left.
- **Decisions for Henry:**
  - **How a fresh Postgres database gets its tables.** Today lf-host refuses, loudly, any database that lacks the hosted schema. A standalone cloud worker therefore needs the whole hosted schema applied. One alternative: lf-host creates the run-host subset itself, copied verbatim from schema.sql, with a test holding the copy equal. Your call.
  - **The trace.** The hosted schema has no trace table (the hosted product keeps the trace in telemetry). On Postgres, "N trace entries" counts only what the current process appended. A drain's resume line says 0 where SQLite would say 2.
  - **TLS.** Connections are plain, so a managed Postgres that requires TLS will not connect yet.
  - **A password in lf.yaml.** lf.yaml's `store:` would hold a database password in a committed file. A secrets-file reference would be better.

## Decisions and why

- **One store trait, with blocking calls** (`crates/lf-host/src/backend.rs`).
  - The SQLite store already blocked (rusqlite). The Postgres store serves the same blocking calls.
  - Its tokio-postgres connection runs on its own thread with its own runtime, and each call waits for its answer.
  - So the rules over the store, the session and the segment host only changed `&Store` to `&dyn RunHostStore`. They did not become async. That kept the edits to other streams' files small.
  - The trade-off: a slow query stalls the one thread, exactly as a slow SQLite write does today.
- **How lf's run record sits in `automations.trigger_run`.**
  - The pipeline goes in the trigger id (`listen:<file>:<movement>`).
  - `trigger_payload` holds the file, the movement and the run's facts. The facts are kept as their JSON text verbatim, so a resume reads exactly the bytes the firing wrote. jsonb would have reordered the event's keys.
  - The writes count goes in `nodes_written` and the error in `failure_reason`.
  - A completed run is stored as `success`, as the hosted product names it, and read back as `completed`.
- **One tenant per store.**
  - `team_id` is a uuid in Postgres. lf uses a fixed uuid unless `--team` names another.
  - The store writes and claims only its own tenant's work rows, so an lf worker never claims another team's rows. The hosted claim takes every team's.
  - The contract still passes: its enqueues name no team and land in the store's own.
  - The segment host now asks the store for its tenant instead of using the constant "local". Files still use "local".
- **The hosted backend's semantics, copied where they differ from the SQLite store.** Two examples:
  - A fence checks only the lease token, not the lease's expiry.
  - Work claims carry the hosted claim handle: the lease token and the row version.
- **Callbacks are now in the trait.** The Postgres store serves all of them.
  - The SQLite implementation refuses each callback method, loudly ("does not serve callbacks yet"). The one exception is revoke, which existed before. A refusal is never an empty answer.
  - Cancel requests are refused the same way.
  - These refusals are lfr-serve's to replace.
- **The contract bridge now carries the callback family and the run records.**
  - New methods: `callbacks.*`, `records.*`, `runs.requestCancel`, `runs.status` and `runs.complete`.
  - `RpcStoreBackend` exposes them as `callbacks` and `runs`, so the records contract can drive another process.
  - lfr-serve likely needs the same for SQLite. Merge note: these may collide with its edits.
- **The Postgres tests live in `apps/cli/src/__test__/integration/`.** The default glob (`src/__test__/*.test.ts`) does not reach them, so the plain apps/cli suite still needs no database.
  - They use `psql` to set up and clear rows.
  - Each test owns a fresh team, and every row it leaves is cleared.

## Tests

- `cargo test -p lf-host`: 44 of 44. `cargo clippy -p lf-host --all-targets -D warnings`: clean.
- WASM rebuild (`scripts/build-movement-wasm.sh`): both artifacts are byte-identical. Cargo.lock only adds packages (tokio-postgres and its dependencies); no existing version moved.
- `integration/run_host_contract_rust_postgres.test.ts`: 42 of 42 on 9432 (30 run host, 9 callbacks, 3 cancel).
- `integration/drain_postgres.test.ts`: 3 of 3.
  - Two workers drain six parked runs, each run exactly once.
  - `--until-idle` exits at once when nothing is due.
  - `--max-seconds` stops a worker that would otherwise poll.
- apps/cli on the TypeScript lf: 211 pass, 0 fail, 12 skipped.
- apps/cli with `LF_BIN=lf-host`: 187 pass and 24 fail.
  - The failures are the baseline target list, none in this stream's area: callbacks/cancel 5, connect 3, serve/webhook 6, models 2, dealroom 1, secrets refresh 5, upgrade 2.
  - The Rust SQLite contract is still 30 of 30.
- Type-check: apps/cli and packages/movement-engine both pass.
- Not run: the hosted apps/api integration set. This change does not touch apps/api.

## Run it

```
cd apps/cli
LF_HOST_BIN=../../target/debug/lf-host node --test --require tsx/cjs src/__test__/integration/*.test.ts
```

`LF_TEST_POSTGRES_URL` overrides the default test database (`postgresql://listenfire:localdevpassword@localhost:9432/listenfire_test`).

## Files outside this stream's own

- `crates/lf-host/Cargo.toml`: two dependencies, `tokio-postgres` and `getrandom` (getrandom was already in the lock).
- `crates/lf-host/src/main.rs`:
  - module lines
  - the `--store`, `--team`, `--until-idle` and `--max-seconds` flags
  - `--contract-store` now takes a spec
  - the `drain` command
  - the `run`, `resume` and `runs` commands open the store from the spec
  - `args.command.clone()`
- `crates/lf-host/src/store.rs`: one new error variant, `StoreError::Backend`, plus its display arm.
- `crates/lf-host/src/project.rs`: lf.yaml's `store:` key, read and kept.
- `crates/lf-host/src/run_host.rs`:
  - every `&Store` becomes `&dyn RunHostStore`
  - `enqueue` takes a team
  - the wake row carries its team
- `crates/lf-host/src/runs.rs`:
  - the session holds the store as a `Box<dyn RunHostStore>`
  - `open_session` takes the store spec
  - `drain_work` takes a limit and also returns how many rows it claimed
- `crates/lf-host/src/segment.rs`: the store type changes, and four `TEAM` uses become `store.tenant()`.
- `crates/lf-host/src/contract_store.rs`: it serves the store from a spec and dispatches over the trait. It gains the callback, record and run-helper methods.
- `packages/movement-engine/services/run_host/rpc_store.ts`: `callbacks`, `runs`, `requestCancel`, `runStatus` and `completeRun`.
- `CHANGELOG.md`: the `### lfr-store` section.
- New files:
  - `crates/lf-host/src/{backend,pg_store,drain}.rs`
  - `apps/cli/src/__test__/integration/{pg.ts,run_host_contract_rust_postgres.test.ts,drain_postgres.test.ts}`
