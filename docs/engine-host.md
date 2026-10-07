# The engine host

The movement engine (`apps/api/src/services/movement_engine/`) runs a program. Everything outside the program goes through one interface the caller hands it, `EngineHost` (`movement_engine/host.ts`): adapters, model calls, parking, cancellation, files, user lookup and write locks. The engine imports none of these itself. A seam test (`movement_engine/__test__/seam_guard.unit.test.ts`) fails if an engine file starts importing host code.

## What a run is given

- **Data.** The source and its language version, a `CatalogSnapshot`, the trigger event, the cost cap (`costCapMicrodollars`, absent for none) with what the run spent before this segment, and, on resume, the parked state. A `CatalogSnapshot` is the team's catalog as plain JSON: adapters and their schemas, credential names, plugins, models, and the saved files the program imports.
- **A host.** The calls the engine makes while it runs.

## The host's groups

| Group | What the engine asks of it |
|---|---|
| `segment` | Open the host's half of a segment (`open({ runId?, teamId, languageVersion })` answers `{ segmentId }`); close it (`close({ segmentId })` answers what its adapter calls spent, `{ cost? }`). |
| `adapters` | Construct an adapter instance for a segment (`resolve({ …, segmentId })`); map a credential name to its id. |
| `llm` | The extraction and `AI()` client, the `extract(…)` call client, `through` stages and plugins, and the judge for identity matches the engine's own rules cannot settle (`{ index }`). Every call is priced. |
| `park` | Persist a timer, await or suspension (`sink`); queue the wake for an await's key (`wake`); mint and read callbacks (`callbacks`); record and find bound counterparts (`bindings`). With no `sink`, a run that reaches a park fails: that is a dry run. |
| `control` | The cancel gate, checked at each statement and model call. `suspendWhen` lets the host pause a run between statements. |
| `files` | Resolve a file import when the snapshot carries no files; turn a file into text (`resolveFileText({ file, budget })`, priced: transcription and OCR are model calls); render and store a `FILE()` artifact (`render({ content, type })`). |
| `lookup` | Map an event's actor to a team user (`@user_*`). |
| `locks` | Cross-run write locks (below). |
| `trace` | The array the run appends its decision trace to, so a caller can read it while the run goes. |

After an await park is durable, the engine asks the await's question once more itself, its WHERE included. A landing that arrived between the first check and the park woke nothing, because a wake for a key with no parked run does nothing. So when the second check finds the await resolved, the engine calls `park.wake({ adapterType, teamId, correlationKey })`; the production host queues a `wake_await` work row. When the second check cannot answer (the remote is down), the engine logs an error naming the key and leaves the run parked without a wake: the adapter's own at-least-once wake covers later landings. The known gap is a landing whose only wake arrived before the park, on a re-check that then failed. A wake that cannot be queued is logged, and the park stands.

A file is a `FileRef`: a JSON descriptor of where its bytes live, never the bytes. Its `source` names either the adapter instance that owns them (`{ adapterType, credentialId?, constructionArgs?, handle }`) or the document store (`{ store: 'document', objectUri }`). The engine only carries descriptors: it hands them to `files.resolveFileText` and gets text back, gets one back from `files.render`, and passes them through write fields. Every byte read happens on the host side: a target adapter or the file-text resolver calls `streamFileRef`, which resolves the named instance with the descriptor's credential and asks it for the bytes. A parked run holds the descriptors as they are, so a resume needs nothing rebound.

### Spend

Every priced call (`llm.*`, `llm.transforms.invoke`, `llm.arbitrateEntities`, `files.resolveFileText`) takes `budget: { remainingMicrodollars: number | null }` in and answers `cost?: Array<{ source, microdollars }>` out (absent: it spent nothing). `source` is where the money went, `kind:name` (`model:claude-sonnet-5`, `service:brightdata.web_unlocker`, `plugin:fetch_url`). The engine keeps the run's ledger (`movement_engine/run_context.ts`): the budget is the run's cap less what it has spent against it (`null` with no cap), and every answer's cost is charged. A host refuses priced work past the budget by throwing `BudgetExhausted` carrying what the call spent first (`lib/run_cost.ts`); the engine charges that and raises the run's cap, `RunCostCapExceeded`, from its own figures, and suspends the run there. A priced plugin (`isPriced`) is refused by the engine before it starts. `segment.close` answers what the segment's adapter calls spent (an adapter's own model call to match a record); the engine charges it as the segment ends, so it reaches the run's figures, not the cap check inside that segment.

The production host meters each priced call under its budget (`withSpendMeter`, `lib/run_spend.ts`): the model and service clients far below the call charge the meter and check it before they start, exactly as they set the billing context's usage rows. The meter and the billing context are host state, set around each call; the engine imports neither.

### Segments

A segment is one entry into the interpreter: a fresh run, a resume, a race settlement, a callback body. Its engine state (`RunContext`: the pin, the cancel gate, the run's id for log lines, the cross-run lock holder, the spend ledger, the host segment's id) is opened by the entry point and passed explicitly to whatever needs it. The host's half (`translation_graph/segment_scope.ts`) holds what the segment's adapter calls have read (a read memo, so a record read three times in one run is one request), how many third-party calls they made (a ceiling: `AFFINITY_MAX_CALLS_PER_RUN`, default 2000), and the pin they answer under. The production host binds every adapter it resolves to the segment it was resolved for, so each call into it, and each step of an iteration it hands back, runs in that scope. A call past the ceiling fails with `AdapterCallCeilingExceeded` (`kind: 'call_ceiling'`), a typed error of the host contract; the engine fails the run with it, and `onError` never forgives it.

## Supplying a host

- **Production:** `productionEngineHost` (`translation_graph/movement/engine_host.ts`). It wires each group to Postgres, the adapter registry and the model providers. Given a run id, it bills each model call to the run. The run host reads the cost cap (`MOVEMENT_MAX_RUN_COST_USD`) once as each segment starts and passes it as `costCapMicrodollars`. Firings, resumes and callbacks build their snapshot with `runCatalogSnapshotForTeam`, which returns the snapshot and, beside it, the credential ids the host needs. Ids never go into the snapshot.
- **Tests:** `makeTestHost(overrides)`. A test supplies only the pieces its program reaches. No default touches a network or a database. `makeFakeParkSink()` records parks in memory. A piece left out does one of three things:
  - **Throws, naming itself, when the run reaches it:** `adapters.resolve`, every `llm.*` client, `park.bindings`, `files.resolveFileText`.
  - **Defaults quietly:** `segment.open` answers a fresh id and `segment.close` answers nothing spent, with no memo or ceiling behind them (a test of the segment scope supplies `hostSegments` and binds its adapters with `segmentBoundAdapter`); `files.render` answers a document-store descriptor whose store key holds nothing (a test that reads the bytes supplies a render that stores them); `park.wake` records each request into `overrides.wakes` (a fresh array when absent); `adapters.credentialId` answers `undefined`; `lookup.resolveActingUser` answers `null` (no acting user); `control.cancel` never cancels; `trace` is a fresh `[]`; `locks` is a fresh `InMemoryWriteLocks`.
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

- **Plugin signatures.** `extraction.ts` reads a plugin's automatic and required parameters from the process's transform registry, not from the snapshot's `plugins` (DESIGN §9, item 8).
- **Live objects in host calls.** Some host calls pass live objects or closures: the `Adapter` that `adapters.resolve` returns (so the call ceiling still reaches the engine as a thrown typed error, not a call result), `getCandidates` into `resolveActingUser`, `onJudgeUnavailable`, the shared trace array, the lock holder. Plain data holds for the engine's inputs and outputs as a whole, not yet for every host call (DESIGN §9, item 9).
- **Resumed segments do not heartbeat.** A timer, await or ask resume keeps the run `parked` and stamps no heartbeat. A crash mid-resume re-runs the parked step: at least once, as before.
