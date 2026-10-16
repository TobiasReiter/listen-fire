# The engine host

The movement engine (`apps/api/src/services/movement_engine/`) runs a program, and everything outside the program goes through one interface the caller hands it, `EngineHost` (`movement_engine/host.ts`). **That interface is a versioned contract: [`contracts/host-families.md`](contracts/host-families.md)** has every family, method and entry point as JSON, and [`contracts/README.md`](contracts/README.md) indexes it with the other four contracts.

This page is the engine side only: how this repository's two hosts serve the contract, and what stays outside it.

**Which engine serves a run is its pinned language version, with no fallback:** version 5 and later runs on the Rust engine, versions 1 to 4 on the TypeScript engine. Both are driven through this same contract. There is no admission step and no engine setting (`MOVEMENT_ENGINE` and its three companions are retired, and boot refuses them). A version-5 run the Rust engine will not run fails with `MOVENG_UNSUPPORTED`, naming the reason.

## Spend

The production host meters each priced call under its budget (`withSpendMeter`, `lib/run_spend.ts`). The model and service clients far below the call charge the meter and check it before they start. A client past the budget throws `BudgetExhausted` inside the host, and the host turns it into the refusal. The meter and the billing context are host state, set around each call; the engine imports neither.

## Write locks

The engine keeps two writes from colliding at two levels.

- **Within a run:** an in-process gate serialises flows of one run (collection members, combinator arms) whose writes could find each other's records.
- **Across runs:** each effect asks `host.locks` for the names it needs (`acquire({ segmentId, names })` answers a token) and gives them back when it finishes (`release({ segmentId, token })`), never holding them for the whole segment. The host keeps one `WriteLockHolder` per segment, opened at its first acquire and closed with the segment, which lets go of anything still held. A record, an edge or a binding is locked as itself. An identity write (`unique by`) locks its whole record type in the team, exclusively. So identity writes to one record type in a team run one at a time across all runs, for the length of each find-then-create.

`WriteLocks` has two implementations (`services/write_locks/`):

- **`PostgresWriteLocks`:** session-level advisory locks on a dedicated connection per segment, keyed by the team and the lock name. This is the production default.
  - **Tried, never waited on.** All parallel flows of a segment share the one connection, which runs one query at a time. A blocking lock call would stall a sibling's unlock behind it, and two runs touching overlapping records in different orders would deadlock where no flow does. So a lock is tried, and retried with backoff (25 ms doubling to 250 ms, jittered) until it is granted or the timeout passes.
  - **Timeout.** A name not granted within `MOVEMENT_WRITE_LOCK_TIMEOUT_MS` (default 60 s) fails the write with `write lock timeout: <name>`. A real cross-run deadlock surfaces this way too: Postgres cannot see it, because nobody blocks inside Postgres. It never hangs.
  - **Lost connection.** A dropped connection releases everything, which covers a process dying. Server-side TCP keepalive (30 s idle, 10 s interval, 3 probes) frees a dead machine's locks in about a minute. If nothing was held when the connection dropped, the next acquire reconnects (one warning). If something was held, the segment's writes fail with `write lock session lost: <name>` until it ends, and its release logs which names were held, since the write they guarded may have run unprotected. A connection that drops under a waiting acquire fails that acquire the same way.
  - **Sizing.** Each in-flight segment that writes holds one Postgres connection of its own, outside the shared pool. In-flight segments are bounded by the drain limit (10 by default, at most 100 per external tick) plus firings on request paths. Size `max_connections` for that.
- **`InMemoryWriteLocks`:** the same holder logic over an in-process gate. `makeTestHost` uses it, and so do test runs: a test run captures its writes instead of making them, so it must never wait on a live firing.

## Supplying a host

- **Both hosts open a segment through `openSegmentWith` (`movement_engine/host_kit.ts`),** which refuses a host families version they do not serve before anything opens, and answer the acting user through `actingPrincipalOf`: the team user's id as the principal's reference, its name as the display, and its email.
- **Production:** `productionEngineHost` (`translation_graph/movement/engine_host.ts`). It wires each family to Postgres, the adapter registry and the model providers. Given a run id, it bills each model call to the run. The run host reads the cost cap (`MOVEMENT_MAX_RUN_COST_USD`) once as each segment starts and passes it as `costCapMicrodollars`. Firings, resumes and callbacks build their snapshot with `runCatalogSnapshotForTeam`, which returns the snapshot and, beside it, the credential ids the run is given as `credentialIds`. A resume and a callback body also read back the engine the run's row says ran its last segment (`trigger_run.engine`) and pass it as `parkedOnEngine`: under `MOVEMENT_ENGINE=by-version` (the default, which sends a run to the engine its pinned language version runs on: 5 and later the Rust engine, 1–4 the TypeScript engine) the segment goes back to the engine that parked it, whatever the emergency switch `MOVEMENT_ENGINE_V5_ON_TS` says now (`engineRoute`, `movement_engine/rust_engine.ts`). A test run hands the host its write sink (`writeSink`).
- **Tests:** `makeTestHost(overrides)` (`movement_engine/test_host.ts`, host side). A test supplies only the pieces its program reaches; no default touches a network or a database. `makeFakeParkSink()` records parks in memory. A piece left out does one of three things:
  - **Throws, naming itself, when the run reaches it:** resolving an adapter (a test supplies its live fakes as `adapters.resolve`; they sit in the same table the production host keeps, and the engine reaches them through `adapters.call`), every `llm.*` method, `park.bindings`, `files.resolveFileText`.
  - **Defaults quietly:** `segment.open` answers a fresh id and `segment.close` answers nothing spent, with no memo or ceiling behind them; `files.render` answers a document-store descriptor whose store key holds nothing; `park.wake` records each wake into `overrides.wakes` as a host would queue it (`{ adapterType, teamId, correlationKey }`, with the segment's team); a rehearsed write goes to `overrides.writeSink`, or nowhere; `lookup.resolveActingUser` answers `null` (a test's lookup is handed `getCandidates`, a call into its live source adapter, and answers a team user, which the host serves as a principal with its email); `control.cancel` never cancels; the trace goes only to the result unless the test hands an array (`overrides.trace`); `locks` are a fresh `InMemoryWriteLocks`, one lock session per segment.
  - **Is absent, so the run takes its no-substrate path:** `park.sink`, `park.callbacks`.
- **Another embedder** supplies its own object of the same shape, serving the JSON in [`contracts/host-families.md`](contracts/host-families.md).

## Remaining non-JSON

Nothing on the request/answer path. Four things stay outside it, by design:

- **Thrown failures carry only their message.** A host call that fails outright (a park that cannot be persisted, a lock timeout) throws; over a wire that is an error response with a message. The engine never branches on a thrown failure's class.
- **The stand-in is engine-local.** The engine wraps each resolved instance in an in-process stand-in `Adapter` (`movement_engine/host_adapter.ts`) whose every method is one `adapters.call`. It never crosses.
- **The Rust engine's eval wire is engine-local.** Between the Rust engine and its shim, adapter arguments, results and park states cross on the eval wire, so the in-process host is handed what the TypeScript engine hands it (see "The Rust engine's requests" in [`contracts/host-families.md`](contracts/host-families.md#the-rust-engines-requests)). It never reaches a host.
- **The test host's conveniences are host side.** `makeTestHost` takes live fakes, a lookup handed `getCandidates`, a `WriteLocks` and a trace array, and serves each as the JSON family. None of those crosses either.

## Recorded debts

- **A crash mid-resume re-runs the parked step.** Every entry into a run holds the run's lease, which renews (and stamps the run's heartbeat) every 20 seconds, resumes included. A resumed leaf is claimed (`resuming`) before it steps; a holder that dies leaves it claimed, and it is parked again once the lease lapses, so the next wake steps it again: at least once, as before.
- **Write locks hold a connection each.** `PostgresWriteLocks` keeps a dedicated session per segment, as the run lease no longer does. Before 10^4 concurrent segments they need the same treatment: a row lease, or Redis.
