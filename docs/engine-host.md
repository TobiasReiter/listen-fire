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
| `park` | Persist a timer, await or suspension (`sink`); mint and read callbacks (`callbacks`); record and find bound counterparts (`bindings`). With no `sink`, a run that reaches a park fails: that is a dry run. |
| `control` | The cancel gate, checked at each statement and model call. `suspendWhen` lets the host pause a run between statements; the cost cap uses it. |
| `files` | Resolve a file import when the snapshot carries no files; turn a file into text. |
| `lookup` | Map an event's actor to a team user (`@user_*`). |
| `locks` | Cross-run write locks (below). |
| `trace` | The array the run appends its decision trace to, so a caller can read it while the run goes. |

The engine keeps its own cost ledger. The host never adds up spend.

## Supplying a host

- **Production:** `productionEngineHost` (`translation_graph/movement/engine_host.ts`). It wires each group to Postgres, the adapter registry and the model providers. Given a run id, it bills each model call to the run. Firings, resumes and callbacks build their snapshot with `runCatalogSnapshotForTeam`, which returns the snapshot and, beside it, the credential ids the host needs. Ids never go into the snapshot.
- **Tests:** `makeTestHost(overrides)`. A test supplies only the pieces its program reaches. Any piece left out throws an error naming itself when the run gets to it, and no default touches a network or a database. `makeFakeParkSink()` records parks in memory.
- **Another embedder** supplies its own object of the same shape. Every call takes and returns plain data.

## Write locks

The engine keeps two writes from colliding at two levels.

- **Within a run:** an in-process gate serialises flows of one run (collection members, combinator arms) whose writes could find each other's records.
- **Across runs:** each segment holds a `WriteLockHolder` from `host.locks`. It takes the names an effect needs and gives them back when that effect finishes, never holding them for the whole segment. A record, an edge or a binding is locked as itself. An identity write (`unique by`) locks its whole record type in the team, exclusively. So identity writes to one record type in a team run one at a time across all runs, for the length of each find-then-create.

`WriteLocks` has two implementations (`services/write_locks/`):

- **`PostgresWriteLocks`:** session-level advisory locks on a dedicated connection per segment, keyed by the team and the lock name. A dropped connection releases everything, which covers a process dying. A cross-run deadlock is caught by Postgres and fails the write with `write lock deadlock: <name>`. It never hangs. This is the production default.
- **`InMemoryWriteLocks`:** the same holder logic over an in-process gate. `makeTestHost` uses it, and so do test runs: a test run captures its writes instead of making them, so it must never wait on a live firing.

## Recorded debts

- **File IO.** The engine still reads and writes file bytes through `translation_graph/engine/files/*`. Rendering a file (`file_render.ts`) also uploads to the document store and drives a browser directly. These belong behind `host.files` (cloud-native DESIGN §9, item 6). The seam test names each exemption, so the list cannot grow quietly.
- **Resumed segments do not heartbeat.** A timer, await or ask resume keeps the run `parked` and stamps no heartbeat. A crash mid-resume re-runs the parked step: at least once, as before.
