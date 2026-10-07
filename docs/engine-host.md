# The engine host

The movement engine (`apps/api/src/services/movement_engine/`) runs a program. Everything outside the program goes through one interface the caller hands it, `EngineHost` (`movement_engine/host.ts`): adapters, model calls, parking, cancellation, files, user lookup and write locks. The engine imports none of these itself. A seam test (`movement_engine/__test__/seam_guard.unit.test.ts`) fails if an engine file starts importing host code.

## What a run is given

- **Data.** The source and its language version, a `CatalogSnapshot`, the trigger event, and, on resume, the parked state. A `CatalogSnapshot` is the team's catalog as plain JSON: adapters and their schemas, credential names, plugins, models, and the saved files the program imports.
- **A host.** The calls the engine makes while it runs.

## The host's groups

| Group | What the engine asks of it |
|---|---|
| `adapters` | Construct an adapter instance; map a credential name to its id. |
| `llm` | The extraction and `AI()` client, the `extract(…)` call client, `through` stages and plugins, and the judge for identity matches the engine's own rules cannot settle. |
| `park` | Persist a timer, await or suspension (`sink`); queue the wake for an await's key (`wake`); mint and read callbacks (`callbacks`); record and find bound counterparts (`bindings`). With no `sink`, a run that reaches a park fails: that is a dry run. |
| `control` | The cancel gate, checked at each statement and model call. `suspendWhen` lets the host pause a run between statements; the cost cap uses it. |
| `files` | Resolve a file import when the snapshot carries no files; turn a file into text. |
| `lookup` | Map an event's actor to a team user (`@user_*`). |
| `locks` | Cross-run write locks (below). |
| `trace` | The array the run appends its decision trace to, so a caller can read it while the run goes. |

After an await park is durable, the engine asks the await's question once more itself, its WHERE included. A landing that arrived between the first check and the park woke nothing, because a wake for a key with no parked run does nothing. So when the second check finds the await resolved, the engine calls `park.wake({ adapterType, teamId, correlationKey })`; the production host queues a `wake_await` work row. When the second check cannot answer (the remote is down), the engine logs an error naming the key and leaves the run parked without a wake: the adapter's own at-least-once wake covers later landings. The known gap is a landing whose only wake arrived before the park, on a re-check that then failed. A wake that cannot be queued is logged, and the park stands.

The engine keeps its own cost ledger. Host code still reports into it ambiently rather than through call results (see "Recorded debts").

## Supplying a host

- **Production:** `productionEngineHost` (`translation_graph/movement/engine_host.ts`). It wires each group to Postgres, the adapter registry and the model providers. Given a run id, it bills each model call to the run. Firings, resumes and callbacks build their snapshot with `runCatalogSnapshotForTeam`, which returns the snapshot and, beside it, the credential ids the host needs. Ids never go into the snapshot.
- **Tests:** `makeTestHost(overrides)`. A test supplies only the pieces its program reaches. No default touches a network or a database. `makeFakeParkSink()` records parks in memory. A piece left out does one of three things:
  - **Throws, naming itself, when the run reaches it:** `adapters.resolve`, every `llm.*` client, `park.bindings`, `files.resolveFileText`.
  - **Defaults quietly:** `park.wake` records each request into `overrides.wakes` (a fresh array when absent); `adapters.credentialId` answers `undefined`; `lookup.resolveActingUser` answers `null` (no acting user); `control.cancel` never cancels; `trace` is a fresh `[]`; `locks` is a fresh `InMemoryWriteLocks`.
  - **Is absent, so the run takes its no-substrate path:** without `park.sink` a park fails (a dry run); without `park.callbacks` a `callback(…)` or an await on one fails as unsupported ("needs the durable trigger-run substrate"); without `files.resolveFile` an import resolves only from the snapshot's files, and fails ("no file resolver") when the snapshot carries none.
- **Another embedder** supplies its own object of the same shape. The engine's inputs and outputs as a whole are plain data; several individual host calls still pass live objects or closures (see "Recorded debts").

## Write locks

The engine keeps two writes from colliding at two levels.

- **Within a run:** an in-process gate serialises flows of one run (collection members, combinator arms) whose writes could find each other's records.
- **Across runs:** each segment holds a `WriteLockHolder` from `host.locks`. It takes the names an effect needs and gives them back when that effect finishes, never holding them for the whole segment. A record, an edge or a binding is locked as itself. An identity write (`unique by`) locks its whole record type in the team, exclusively. So identity writes to one record type in a team run one at a time across all runs, for the length of each find-then-create.

`WriteLocks` has two implementations (`services/write_locks/`):

- **`PostgresWriteLocks`:** session-level advisory locks on a dedicated connection per segment, keyed by the team and the lock name. This is the production default.
  - **Tried, never waited on.** All parallel flows of a segment share the one connection, which runs one query at a time. A blocking lock call would stall a sibling's unlock behind it, and two runs touching overlapping records in different orders would deadlock where no flow does. So a lock is tried, and retried with backoff (25 ms doubling to 250 ms, jittered) until it is granted or the timeout passes.
  - **Timeout.** A name not granted within `MOVEMENT_WRITE_LOCK_TIMEOUT_MS` (default 60 s) fails the write with `write lock timeout: <name>`. A real cross-run deadlock surfaces this way too: Postgres cannot see it, because nobody blocks inside Postgres. It never hangs.
  - **Lost connection.** A dropped connection releases everything, which covers a process dying. Server-side TCP keepalive (30 s idle, 10 s interval, 3 probes) frees a dead machine's locks in about a minute. If nothing was held when the connection dropped, the next acquire reconnects (one warning). If something was held, the segment's writes fail with `write lock session lost: <name>` until it ends, and its release logs which names were held, since the write they guarded may have run unprotected. A connection that drops under a waiting acquire fails that acquire the same way.
  - **Sizing.** Each in-flight segment that writes holds one Postgres connection of its own, outside the shared pool. In-flight segments are bounded by the drain limit (10 by default, at most 100 per external tick) plus firings on request paths. Size `max_connections` for that.
- **`InMemoryWriteLocks`:** the same holder logic over an in-process gate. `makeTestHost` uses it, and so do test runs: a test run captures its writes instead of making them, so it must never wait on a live firing.

## Recorded debts

- **File IO.** The engine still reads and writes file bytes through `translation_graph/engine/files/*`. Rendering a file (`file_render.ts`) also uploads to the document store and drives a browser directly. These belong behind `host.files` (cloud-native DESIGN §9, item 6). The seam test names each exemption, so the list cannot grow quietly.
- **Ambient spend and run scope.** Host-side model calls (`lib/llm_usage`'s `reportRunCost`) and the budget check (`assertRunBudget`, `lib/run_spend`) report and enforce cost through the engine's ambient spend ledger, not through call results. Adapters read the engine's run scope (the language-version pin, the call ceiling, the read memo) the same way. These channels must become explicit host-call results before the engine moves to Rust (cloud-native DESIGN §9, item 7).
- **Plugin signatures.** `extraction.ts` reads a plugin's automatic and required parameters from the process's transform registry, not from the snapshot's `plugins` (DESIGN §9, item 8).
- **Live objects in host calls.** Some host calls pass live objects or closures: the `Adapter` that `adapters.resolve` returns, `getCandidates` into `resolveActingUser`, `onJudgeUnavailable`, the shared trace array, a `FileRef`'s `retrieve` closure. Plain data holds for the engine's inputs and outputs as a whole, not yet for every host call (DESIGN §9, item 9).
- **Resumed segments do not heartbeat.** A timer, await or ask resume keeps the run `parked` and stamps no heartbeat. A crash mid-resume re-runs the parked step: at least once, as before.
