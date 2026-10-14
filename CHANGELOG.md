# Changelog

Every pull request that changes what an operator sets or an author writes adds a line under
Unreleased in the same pull request. Tagging a release moves the Unreleased entries under a heading
for the new version, with the date. When a new minor line is cut, move the previous minor's sections
(with their link references) into `docs/changelog/v0.N.md` and list it under Earlier releases.

Entries are written for two readers: an operator running a self-hosted installation (what to set,
what a deploy applies, what behaves differently) and an author writing automations in the movement
language (new or changed constructs, plugins, adapters, handbook idioms). The format follows [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/); versions are the git tags described in
[`deploy/UPGRADING.md`](deploy/UPGRADING.md).

## [Unreleased]

Language version 5, **Dancing Wren**, arrives. New automations are written in it. Every change in
it is a refusal, so an automation that uses a retired form has an error under 5, stays on its
version, shows Review and behaves exactly as before; rewrite the form and upgrade with
`upgradeAutomation`. Versions 1 to 4 keep their behaviour (proved by a version 4 conformance
corpus). Every rule, with rewrites, is in the [Dancing Wren migration
guide](docs/language/dancing-wren-migration.md).

### Language version 5, Dancing Wren: what breaks

- **`write … bind` is retired** (`MOV_WRITE_BIND_RETIRED`). Why: the engine kept the
  correspondence in a store no system holds. Store the link in the system that holds it: a field
  the next write finds the record by (`unique by`), or an edge there.
- **`#` hops are retired** (`MOV_META_HOP_RETIRED`): `-[:#name]->`, `-[f:#resources]->`, on a walk,
  a head, a write or match target, or a type's address. Why: there are no meta edges, only the edges
  a system declares. A plugin is a function: `-[:#transform { plugin: … }]->` (refused since 3)
  now shows the call form, `import { p } from plugins` then `out = p(…)`.
- **`delete` only where the system declares it.** `MOV_DELETE_NOT_DECLARED` when the record's type
  does not say `deletable: true` in its describe; `MOV_DELETE_NOT_RECORD` when the target is a
  value, a list, an extracted node, a record the run built, or anything but one stored record.
  Why: each passed the save and failed at run time.
- **`_resources` only on an extraction's result** (`MOV_RESOURCES_NOT_EXTRACTED`). Off a system's
  record, walk the edge it declares to its files, which the message names from the schema: email,
  Gmail and WhatsApp `Attachments`, Slack `Files`, the knowledge graph `Resources`. Why: the
  reserved reference was read through the event's adapter whatever the record's system, and read
  nothing on the systems that had retired its bundle. Under 5 the engine no longer resolves it
  for a system's record.

- **A file is never joined into text** (`MOV_FILE_IN_TEXT`): `"Attached: ${f}"`, or a value that
  may be a file. Why: it joined as `[object Object]`. Its text is `READ(f)`
  (`"${COALESCE(READ(f), "")}"`); the file itself goes into a field that holds files.
- **A write handle's unsent file is not a file** (`MOV_HANDLE_FILE_NOT_SENT`): `READ(h.doc)`, or
  `h.doc` passed where a file is expected, when the write did not send `doc`. Why: the system
  answers with its description of the file, not a file, so `READ` failed at run time. Read the
  record back through its edge to get the file, as a walk read does; a field the write sent stays
  usable.
- **A value that may be a record, handed to a record parameter** (`MOV_CALL_ARG_MAYBE_RECORD`):
  `v = COALESCE(org, "x")` then `hp(r: v)`, an `IF` of a record and text, or a function or closure
  that returns either. Why: TypeScript's `Org | string` is no `Org`, and the engine refuses the
  value at run time. Narrow it to the record with `IS`, handle the case where it is not one, or
  fill the other arm with a record. A union of records alone is one record and still fits. A record with
  `NULL` is a maybe-absent record and fits. Inside an `IS` arm the value is the record (on every
  version, it passes as a position and enters a graph).
- **A record a `parallel` / `race` arm hands back reads as that record.** `AT(r, 0).name`, or
  `h = AT(r, 0)` then `h.name`, reads the record the arm returned, as `AT([a, 2], 0).name` on a
  list does; `AT(r, 0) == null` is false. Under 4 and earlier that slot read null while the check
  accepted the read, and a program pinned there still reads null. A move up across 5 warns a read
  of such a receipt (`MOV_RECEIPT_RECORD_SLOT`).

### Language version 5, Dancing Wren: new

- Adapter protocol: a type's describe may declare `deletable: true` (optional; absent means no).
  Attio, Affinity, Airtable, Evertrace (not signals), the knowledge graph and Valuations declare it
  where they delete. No protocol version bump: the field is additive, but under language version
  5 a remote adapter that does not declare it has every `delete` refused.
- The knowledge graph's `Resources` edge is walked by its name on every version
  (`c-[f:Resources]-> { … f.URL … }`), its landing typed with `Name`, `URL` and `Type`. The
  adapter matches it by its reserved address, so a team's ontology edge named `Resources` stays
  the ontology's.

### Changed

- `MOVEMENT_ENGINE=rust` speaks language version 5 as the TypeScript engine does: a `_resources`
  walk off a system's record fails with the same error under 5 (versions 1 to 4 read it as before),
  the knowledge graph's `Resources` edge is walked by its reserved address on every version, and a
  catalog that declares a type `deletable` or an edge `resources` loads in the Rust engine.
- `MOVEMENT_ENGINE_FALLBACK` (new, optional): `ts`, the default, runs on the TypeScript engine a run
  `MOVEMENT_ENGINE=rust` sends to Rust and Rust refuses, as before; `none` fails that run with the
  refusal's reason instead, and needs `MOVEMENT_ENGINE=rust` (boot refuses it otherwise). Under
  `none` a resume that answers a question (`resume_answer`) or defers a race's settlement
  (`resume_defers_race_settlement`) fails too, so set it only once the refusals report is empty,
  resume reasons included. Every automation run's row now records `engine` (`ts` or `rust`, for its
  latest segment) and `engine_reason` (the first reason the Rust engine's admission gave for not
  running it, `admitted` when it would take it or ran it, `shim_fault` when the Rust engine faulted
  in the shim, or `ended_at_check` when the run failed its check before either engine ran it,
  neither of which is an admission reason; empty when the dry run was skipped or faulted), shown in
  the operator run views; a deploy applies the new columns, null on earlier runs.
- `MOVEMENT_ENGINE=rust` runs more automations whole instead of handing them to the TypeScript
  engine: `@user_*` and `@actor_*` keys, an integration's field functions, `AI()`, `FILE()` and
  `READ()`, `IS <Declaration>` of a system's record, a records-output plugin's call and every plugin
  argument form, closures called by name, the extraction call (`extract(…)`, `extractOne(…)`), calls
  written inside an expression (a closure's, a plugin's, an extraction's), `ONLY` of any expression,
  `write m.k { … }`, collection ops with `concurrency`, and the file scope as the TypeScript reads
  it. The deployment's `EXTRACTION_TIERS` now reaches the Rust engine too, as run input, so a tier's
  model and effort are the same on both engines. New refusal reasons that can appear in a run's
  `engine_reason`: `nested_movement_call`, `nested_call_form`, `extract_call_shape`,
  `extract_call_settings`. Nothing to set.
- An extraction call's `model` is held at run time to the models this deployment reaches, the list
  the editor and the save already check it against, on both engines. A run whose saved catalog
  carried no model list could name a model the code knows but this deployment has no credentials
  for, pass, and fail at the provider; it now fails before the call, naming the models this
  deployment reaches. Nothing to set.
- A parked run's reason is no longer limited to a fixed list at the database: the core keeps
  `timer`, `await` and `limit`, and a unit (no unit writes its own reason yet; `ask` was a legacy
  value) may park under any other non-empty reason. The column loses its default of `ask` (migration
  `park_reason_unit_owned`). Rows already parked as `ask` are untouched. Nothing to do beyond the
  normal migrate step.
- Automations background work (cron, polls, timer resumes, inbound dispatch, await wakes,
  housekeeping) now runs from the `automations.work` table through one `drain` worker. Deployments
  may run it as an in-process loop (default) or tick it externally
  (`AUTOMATIONS_DRAIN_MODE=external` + `POST /api/v1/system/automations/drain`, body capped at
  `limit` 100 and `maxPasses` 50). The boot-time orphan sweep is replaced by lease expiry plus a
  sweep every 30 seconds that fails a run whose process died mid-step, with its inbound event.
  Events within one inbound delivery may now run concurrently or out of order. In external mode only
  the tick drains; a door enqueues without draining. Each tick records the drain's pulse on
  `/healthz/workers`, and the boot log names the drain mode.
- Automations may run as several instances at once, in either drain mode. The automations advisory
  lock is gone: every entry into a run (its first firing, a wake, a callback body, a timer, an
  operator's resume or abort) holds that run's own lease, a row lease on `trigger_run` (new columns
  `lease_owner`, `lease_until`, `lease_token`; migration `per-run-lease`), so two instances never
  step one run at once. A lease lapses a minute after its holder stops renewing it. A run another
  instance is stepping is retried rather than failed: a wake looks again two seconds later, two
  seconds more each time it finds the run busy (at most thirty), without counting as a failed
  attempt, a timer looks again five seconds later, a callback tap is recorded and answered `202` and
  its body runs from a queued `fire_callback` work row once the run is free, and resuming a paused
  run answers `409` (tRPC `CONFLICT`) to be retried. Every recorded tap writes its body's
  `fire_callback` row in the same transaction as the call, so a failure after a tap is recorded can
  no longer lose its body; a tap whose row cannot be written is not recorded, and the door's error
  may be retried. A body is marked as started before it runs, so it runs at most once: a crash part
  way through leaves that body incomplete rather than running its writes twice. A call is seen by
  `cb-[:Called]->`, and resolves an `await` on it, only once its body has started, so the awaiting
  branch never runs ahead of the body. Aborting a parked run while another instance resumes it
  stamps the cancel for that resume to settle; the periodic sweep settles a stamp that resume
  missed, whatever the run is parked on (it used to cover timer parks only). The external drain tick
  (`POST /api/v1/system/automations/drain`) answers on any instance and ticks may overlap; the `503
  not_lock_holder` answer is gone. The drain result gains `deferred`: rows released for a later
  retry because their run was busy. A segment that loses its run lease (it could not renew it within
  a minute) stops at its next statement, recording and settling nothing, since another instance may
  hold the run; the statement it was in has already run, so its effects can land twice when the new
  holder runs it again. A segment checks its lease again before it settles anything, so one whose
  lease lapsed during its last statement settles nothing either. Its lease fences its writes to the
  run's parked state: once another instance holds the run, the stopped segment can no longer write a
  park row, finish or drop a leaf, clear the run's parked rows and joins, or set the run's status
  (parked, or its terminal status). A lost lease is never forgiven by a collection op's `onError`. A
  first firing stopped this way notes why on its run for the orphan sweep; run status reads (REST
  `run-status`, `listRuns`, `inspectRun`, the run views) report that note as the failure reason only
  once the run has failed. A `parked_run` leaf being resumed is now `resuming`; one left so by a
  dead instance is parked again once its lease lapses. The other units' loops still take their lock,
  so they still run on one instance.
- The five-second await poll is gone. Answering or cancelling a question now wakes the run waiting
  on it directly, through a queued wake that survives a restart. A sweep every 30 seconds wakes runs
  still parked on a closed question whose wake was lost. A fired callback also queues a wake 30
  seconds out, so a run waiting on it still resumes if the process dies before its normal wake. A
  composed deployment that never registers its in-process ask notifier logs an error on each answer,
  and runs waiting on answered questions then resume only through that 30-second sweep. Leftover
  rows of the retired `await_resume_sweep` work kind are deleted at boot.
- Remote adapters speak adapter protocol 2. Breaking for anyone who built one: requests carry
  `protocolVersion: "2"` and a server answers its `manifest` with `protocolVersion: 2`; installing
  asks the server and refuses anything older. Names on the wire are the natural display names.
  Params are validated, and a mismatch answers `bad_request` naming the path. A remote adapter can
  now make an automation wait on its system (`resolveAwait`, `wakeKeys`), push to two new doors with
  its install's own secret (`POST /api/public/adapter/<type>/emit` for new events, `/wake` to resume
  waiting runs; the optional `x-listen-fire-team` header picks the team when one secret serves
  several), page large collections (`iterateRelatedPage`), and move files by URL. A remote's webhook
  subscription must return a secret, and deliveries are signed in `x-listen-fire-signature`. The
  contract is [`docs/adapter-protocol.md`](docs/adapter-protocol.md); the dev loop's fake CRM is the
  reference adapter.
- Identity writes are now serialised across runs, not only within one. Two runs, in one process or
  several, no longer both create the same record. An identity write (`unique by`) takes a Postgres
  advisory lock on its record type in the team (one system, one record type), held for that write's
  find-then-create and released after it. The cost: identity writes to one record type in a team run
  one at a time across all runs. Updates, deletes, links and bound writes lock their own record,
  edge or binding the same way. A write waits up to `MOVEMENT_WRITE_LOCK_TIMEOUT_MS` (new, optional,
  default 60000) for another run's lock, then fails the step with `write lock timeout: <name>`; two
  runs that each hold what the other wants fail this way rather than hang. Each running segment that
  writes holds one database connection of its own for its locks, outside the shared pool, so size
  `max_connections` for one per in-flight segment (see "Automations" in `deploy/SELF_HOSTING.md`).
  Test runs lock in memory, so they never wait on a live firing.
- A resumed run whose adapter has been uninstalled, or whose credential is gone or now serves
  another system, fails naming the instance (`instance <system>(credentials: <name>) is not in the
  catalog snapshot`).
- For embedders: the movement engine reaches everything outside the program through one
  `EngineHost`: adapters, model calls, parking (with record bindings), the trace, cancellation,
  files, acting-user lookup and write locks. A run takes a `CatalogSnapshot`, the team's catalog as
  plain JSON, rather than a live catalog. `makeTestHost` builds an in-memory host for tests. See
  [`docs/engine-host.md`](docs/engine-host.md).

- Remote adapters: every call Listen-Fire makes to a remote adapter now carries `x-listen-fire-team:
  <team id>`, so a server serving several teams knows which install is calling. The push doors
  (`emit`, `wake`) refuse a body over 1 MB with 413 (the limit was 25 MB).
- A remote adapter may no longer take a slug that a built-in adapter answers to (its slug, trigger
  kinds or aliases, in any casing), nor `callback` or `ask`. Installing one is refused, the push
  doors answer 401 for it, and the webhook door never routes to it. An existing install with such a
  slug was already shadowed by the built-in at resolution; it now also stops receiving pushes.
- The webhook door queues a delivery's await wakes before it answers 200. When the adapter's wake
  keys cannot be read, or their wakes cannot be queued, the door answers 500 after the delivery's
  events are receipted and queued, so the sender's retry re-attempts the wakes without running the
  events twice. It used to log the failure and answer 200, losing the wakes.
- For embedders: `EngineHost.park` gains `wake({ segmentId, adapterType, correlationKey })`, and
  `ParkSink.commitAwaitPark` no longer takes a `resolvesNow` closure. The engine re-checks an await
  itself once the park is durable and calls `park.wake` when it already resolved, so every host call
  carries plain data.
- For embedders: the engine host boundary is JSON-complete. Every method of every `EngineHost`
  family takes one JSON request and answers one awaited JSON answer, and
  [`docs/engine-host.md`](docs/engine-host.md) is now the frozen contract, method by method (shapes,
  errors, idempotency, what the host persists, which families are optional). A test round-trips
  every method through JSON and holds the method set to the document. By family:
  - `segment`: new. `open({ runId?, teamId, languageVersion })` answers `{ segmentId }`; `close({
    segmentId })` answers what the segment's adapter calls spent.
  - `adapters`: the engine holds no live adapter. `resolve` answers the instance as data and an
    opaque id; `call({ segmentId, instance, method, args })` answers `{ result }` or `{ error }`. An
    adapter failure carries its `name` and a `detail` (`{ status?, code? }`), and the host logs the
    original at warn. `resolveFileRef` is not callable: bytes stay on the host. Credential ids are
    run input (`credentialIds`).
  - `llm` and `files.resolveFileText`: every priced call takes the run's `budget` and answers its
    `cost`, or a `budget` refusal as data. `arbitrateEntities` answers `{ index, judgeUnavailable?
    }` in place of a callback. A plugin's arguments, output and pricing come from the catalog
    snapshot.
  - `park`: a timer's `wakeAt` and a callback's `expiresAt` are ISO 8601 strings.
  - `control`: `suspendWhen` is gone (a run takes `suspendAt` addresses as input), and the cancel
    gate's reason no longer crosses.
  - `files`: `resolveFile` is gone (imports resolve from the snapshot); files cross as descriptors
    only.
  - `lookup`: `resolveActingUser` names the source instance and the event; the host asks the source
    for actor candidates itself.
  - `locks`: `acquire({ segmentId, names })` answers a token; `release({ segmentId, token })`.
  - `trace`: new. `append({ segmentId, entries })` as the run goes.
  - `makeTestHost` and `makeFakeParkSink` moved to `movement_engine/test_host.ts`.
  - Every call names its segment: `segmentId` is on every request but `segment.open`'s
    (`control.cancel.cancelled({ segmentId })`, `park.callbacks.calls({ segmentId, callbackId })`),
    and the host answers each for the run and team the segment was opened for, so `teamId` is gone
    from `adapters.resolve`, `park.wake`, `park.bindings` and `lookup.resolveActingUser`.
    `adapters.resolve` answers one instance per resolution (system, credential, construction args,
    rehearsal) within a segment, and refuses a segment that is not open. `makeTestHost`'s default
    `park.wake` records each wake with the segment's team.
- For embedders: the five contracts the movement core speaks are written down under
  [`docs/contracts/`](docs/contracts/README.md), each with an integer version of its own and an
  index of what this release supports. The engine host contract moved there as `host-families.md`,
  and the adapter protocol as `adapter-protocol.md`. Two of them now carry their version on the
  wire, and an unsupported version is refused, naming the contract, the version and the supported
  set:
  - The catalog snapshot carries `contractVersion` (version 1). Both readers refuse another version;
    a snapshot without one reads as version 1.
  - When the web app and the API deploy separately, deploy the web app first. A browser still
    running an older bundle has a strict catalog reader that refuses a snapshot carrying
    `contractVersion`, so its editor cannot check until the page is reloaded.
  - `segment.open` carries `hostFamiliesVersion` (version 1). Both of this repository's hosts refuse
    an open under another version, or under none, before opening anything. Breaking for an
    embedder's host: it receives the new field.
  - `lookup.resolveActingUser` answers a principal, `{ principal: { id, display? }, email? }`, in
    place of a team user `{ id, email, name? }`. `@user_id` reads the principal's id, `@user_name`
    its display, and `@user_email` the email, which only a host that has one supplies; without it
    `@user_email` reads as absent. Saved automations are unchanged: this repository's host supplies
    all three as before.
- For embedders: two conformance kits. The host kit is every distinct run of the engine's v1 and v2
  test corpora, recorded at the host boundary (input, each request and its answer, the result) and
  replayable against any engine and host; ours replay on the TypeScript engine, the Rust engine and
  over an HTTP host double. The language kit replays a checks corpus against the checker: `pnpm
  language:conformance <checks.json>`. See "Conformance kits" in
  [`docs/contracts/README.md`](docs/contracts/README.md).
- For embedders: an engine host must serve `clock.now` and `ids.mint`. They are required families of
  host families version 1: the engine reads no wall clock and mints no random id of its own, and a
  host that lacks either is refused before `segment.open`, naming the missing methods. See
  [`docs/contracts/host-families.md`](docs/contracts/host-families.md).
- For adapter vendors: `pnpm adapter:conformance --url <server> --auth bearer|secret` checks a
  remote adapter server against adapter protocol 2 without a Listen-Fire stack or a database. It
  prints `PASS`, `FAIL` or `SKIP` per check and exits 1 on any `FAIL`. See "Build your first
  adapter" in [`docs/contracts/adapter-protocol.md`](docs/contracts/adapter-protocol.md).

- The movement parser is implemented in Rust and loaded as WebAssembly; the TypeScript grammar is
  removed. Browser callers await `initParser()` before parsing. Two parses differ, under every
  language version:
  - Nesting deeper than 128 levels is refused with "nesting too deep". Statements and expressions
    are bounded separately: statements count their own levels, and each expression counts its own
    from zero. It used to be accepted. Much deeper nesting would overflow the WebAssembly parser's
    stack; real automations nest a few levels.
  - An expression error naming an unrecognised character outside the Basic Multilingual Plane (an
    emoji, say) now quotes the whole character. It used to quote half of it.

- Movement-language expression lowering is Rust; the TypeScript lowering is deleted.
- The checker's catalog and type-model core is Rust, behind `catalog_query`, held to the TypeScript
  by a differential.
- Added a checker conformance corpus (`checks.json` and snapshots) that pins diagnostics across the
  checker port.
- `constructor`-style keys (`constructor`, `__proto__`) no longer lower as properties.
- Chains over 1,024 members are refused ("chain too long"). A resource limit, not a language rule,
  so no language-version conditional (same precedent as the 128 nesting limit).
- Deep nesting is refused at the limits: 128 for parse, 2,048 for JSON reads, 256 for typed catalog
  reads. Resource limits, not language rules, so no language-version conditional.
- The movement engine has a second implementation, in Rust (`crates/movement-engine`), behind
  `MOVEMENT_ENGINE` (new, optional): `ts`, the default, runs every movement on the TypeScript engine
  as before; `rust` runs on the Rust engine every run it can run whole, and the rest on TypeScript.
  Any other value fails startup. Under `rust` it runs reads of the event and of values, bindings,
  `if`, `return`, the built-ins, writes (with `unique by`, a `WHERE` on the target, off a traversed
  record, in place on one), `match`, `link`, `unlink`, `delete`, node and graph literals, traversal
  blocks of one hop (nested, bound, with `WHERE`, `ORDER BY` and `LIMIT`), `sleep` with its resume,
  and a pause at the run's cost cap, the extraction keyword (`x = extract from […] { tree }`,
  without a tier: its model calls, `through` stages, fenced children, files and resources, heads
  over what it yielded) and a plugin's plain call (of a plugin declaring a value or a record),
  walks, folds (`FIRST`, `COUNT`, `SORT`, …), `EXISTS` and `IS` tests in an expression, a record
  named twice and `ERROR(…)`, and hands a run back before any effect when it needs more (a pause or
  a cost cap inside a block stays on TypeScript, which joins a fan-out's parked iterations). The
  Rust engine decides what it runs on its own parse of the program, before it touches anything, and
  a run it hands back costs no second check. Each run logs one line naming the engine that ran it
  and why (`movement engine: engine=rust|ts run=<id> reason=<reason|admitted>`), at info under
  `rust` and at debug under `ts`, and `GET /api/v1/system/engine-stats` (the `system` scope) answers
  the process's counts since it started: runs not admitted and declined by reason, runs routed and
  run whole, and the evaluator's. Both engines park in one format, so a run parked on one resumes on
  the other. Chunk 6A moved the conformance corpora's runs whole on the Rust engine (v1 and v2) from
  117 and 139 (109 and 126 replayed) in steps: file-level declarations and plugin imports 119 and
  141, extraction and plugin calls 223 and 268 (195 and 234 replayed), folds, `EXISTS`, `IS` and a
  record named twice 289 and 352 (256 and 313); admission walking only what the fired movement
  reaches, 290 and 353 (257 and 314). Before that, 69 and 75 before traversal blocks and the record
  verbs. Each later step is counted in the burn-down entry below. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, the Rust engine's admission walks only the movement a run fires and
  the movements it reaches, with the file's declarations and values. A helper movement nothing calls
  no longer sends its whole file to TypeScript. Admission also no longer stops at the first
  construct it does not run: a refusal names every reason it holds, and `GET
  /api/v1/system/engine-stats` gains `runs.allReasons` (runs not admitted, counted under every
  reason each holds) beside `runs.notAdmitted` (counted under the first). Which runs the Rust engine
  takes changes only by the helpers no longer walked: the corpora run one more run each whole on it.
- Under `MOVEMENT_ENGINE=rust`, the Rust engine now runs calls of the movements a program declares
  (as a statement, bound, returned, or as another call's argument; recursion refused before language
  version 3 and bounded by `MOVEMENT_MAX_CALL_DEPTH` from it, which the Rust engine reads once per
  segment where the TypeScript engine reads it per call) and the graphs a run builds: declared edges
  (`companies: <Company>`), writes, matches, position writes and links into a node's edge, block
  heads and expression reads (a field, `COUNT`, `EXISTS`) over one, traversal entries, `lazy`
  entries and `x = lazy …`, and `graph<Shape> { … }`. A source the Rust parser refuses goes on to
  the check, which fails it with its own parse error. Refusals it adds, each before anything is
  asked: `call_park` (an `await sleep` inside a called movement), `cost_cap_inside_call` (a capped
  run that could suspend inside a call) and `lazy_park` (a run that may park holding a lazy walk).
  The corpora now run 394 (v1) and 469 (v2) runs whole on it, the binding × consumer matrix's
  admitted cells included, and 312 and 379 recorded runs replay on it. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, the Rust engine now runs records held as values, as the TypeScript
  engine reads them: a walk read as a list of records, a record passed to or returned from a
  closure, fields an object lacks read off `Object.prototype`, records compared by identity, a dict
  made text through its own `toString` or `valueOf`. It also runs `MAP`, `FILTER`, `REDUCE`,
  `GROUPBY`, `KEYBY` and `MEMBERS` whose concurrency is 1, tuple writes, writes and links rooted at
  or spreading any record, and `EXISTS` over a value. The event no longer goes to TypeScript for
  holding such a dict. Mid-run, a record handed to a host request fails the run with
  `MOVENG_UNSUPPORTED` before the request is made. The corpora now run 1006 (v1) and 1309 (v2) runs
  whole on it, and 346 and 429 recorded runs replay on it. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, a program that could hand its host a record held as a value — inside
  a plugin's argument, a system write's field, an extraction's `from` text, a reading the Rust
  engine passes to the TypeScript one — now runs on the TypeScript engine from the start
  (`plugin_arg_record`, `write_field_record`, `extract_from_record`, `builtin_arg_record`; likewise
  `at_record_key` and `node_spread_record`), where it used to fail partway. A GROUPBY or KEYBY that
  files a record under the key `__proto__`, and event values shaped like the engine's own records,
  now read as on the TypeScript engine. A collection op's `onError: "warn"` or `"ignore"` no longer
  drops a member the Rust engine could not read; the run fails naming it. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, a text holding half of a surrogate pair (a host's JSON can carry one
  as a `\udXXX` escape; a cut through an emoji, `SPLIT(text, "")` or `TEXT.REGEX_EXTRACT` makes one)
  is held and read as on the TypeScript engine. A plugin's, a file reader's or a model's answer
  holding one used to fail the statement, and an extraction reply holding one was asked again; an
  event holding one, `SPLIT(text, "")` of an emoji and a match through one ran on the TypeScript
  engine; a cut through an emoji (a trace's sample, a source file bounded for the prompt) dropped
  the emoji where the TypeScript engine keeps its first half. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, the Rust engine reads date text as the TypeScript engine's `Date`
  does: V8's parser, its ISO form and its legacy one (`March 12, 2026 9:30 PM`, `12/03/2026`, `Thu,
  12 Mar 2026 09:30:00 GMT+0530`, two-digit years, zone words, comments in parentheses), NaN where
  V8 gives NaN. `DATE`, `DATETIME`, `DATE.FORMAT`, `DATE.FORMAT_ISO` and a filter's `<`/`>` between
  two texts no longer go back to TypeScript. A date-time with no offset is read in the local zone,
  which is now a run input: the shim hands the engine its process's zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`, the zone `Date` reads in), checked against
  `Date`'s own wall clock first — under a `TZ` whose zone `Intl` cannot name as `Date` reads it
  (`GMT+3`, `UTC+3`; a `TZ` `Intl` names no zone for, such as `utc`, is read as `UTC` when `Date`
  agrees) the run and the expression stay on the TypeScript engine (`local_zone_unverified`) — and
  an embedder's run with none reads UTC (`localZone` in
  [`docs/contracts/host-families.md`](docs/contracts/host-families.md); optional, so the contract's
  version is unchanged).
- Under `MOVEMENT_ENGINE=rust`, the Rust engine retirement's burn-down (chunk 7A), as the
  conformance corpora count it. Each step's runs run whole on the Rust engine, all agreeing with
  TypeScript (v1 / v2, and v3 once its corpus arrived), with the recorded runs replayed on it (of
  443 / 542):
  - Task 1, admission walks only what the fired movement reaches and names every reason: 290 / 353
    (257 / 314 replayed).
  - Task 2, calls of declared movements and the graphs a run builds: 394 / 469 (312 / 379).
  - Task 3, records held as values and collection ops: 1,006 / 1,309 (346 / 429). These counts, and
    every count before Task 7's, include programs that only ever failed their check: the run-whole
    definition that excludes them arrived with Task 7.
  - Task 4, awaits, `parallel` and `race`, parks anywhere and every park state resumed: 1,060 /
    1,363 (392 / 475). The forward merge that brought the v3 corpus: 1,060 / 1,362 / 1,918.
  - Task 4b, data never read as an engine object; Task 4c, language version 4's four changed
    constructs; Task 5, the regex dialect, Unicode case mapping, mixed-key sorts and
    `Object.prototype` reply fields mirrored from V8 and zod; Task 5b, V8's date parser and the
    local zone as run input: the same 1,060 / 1,362 / 1,918.
  - Task 6, the rest of the burn-down (the entry above): 1,188 / 1,499 / 2,556.
  - Task 4d, a file is only what an envelope declares: 1,180 / 1,491 / 2,547 (the corpus cases that
    handed the engine a descriptor-shaped dict as a file are triaged).
  - Task 6b, admission reads the checker's types for parameters, calls and spreads: 1,174 / 1,485 /
    2,566, with 6 / 6 / 4 runs counted apart as failing mid-run by name (`MOVENG_UNSUPPORTED`), each
    a corpus case pinning that same failure on both engines. Its fix round's commit subject says
    "text coercions are values", which is not what it did: `MULTI(co)` written into a field
    (`write_field_record`) or handed to a value parameter (`call_arg_record`) stays refused.
  - Task 7, the counts made honest. A Rust-routed program is now checked before its segment opens,
    as the TypeScript route checks it, so a program that fails its check makes no host request on
    either engine and never reaches the Rust engine; such runs used to count as run whole. Of 1,193
    / 1,514 / 2,662 runs attempted, 1,023 / 1,251 / 2,152 run whole; 12 / 21 / 86 are refused at
    admission by name, 6 / 6 / 4 fail by name, 0 / 0 / 3 are declined, and 152 / 236 / 417 fail
    their check before a segment opens. The recorded runs replay 430 / 519, every run the Rust
    engine ran to an ending judged by its verdict. Nothing to set.
- CI's size warning for the API's WebAssembly artifact (`movement.wasm`) moves from 800 KiB to 1 MiB
  gzipped, and its failure line from 1 MiB to 1.5 MiB: it is 963 KiB (986,091 bytes) as chunk 7A
  ends, the readings of records held as values having first taken it past the old line. The
  browser's artifact is unchanged. It now crosses the 1 MiB warning at 1,108,094 bytes, still under
  the failure line: a paused run's closures, walks and local shapes are rebuilt on resume from the
  syntax tree saved with the pause rather than looked up by position, and reading that tree back
  takes about 100 KB.
- The browser now loads the parser's own WebAssembly artifact (`movement_parser.wasm`, 325 KB
  gzipped, a little over the earlier 323 KB because the parser reads text in the engine's in-band
  form, so a U+FDD0 or a lone surrogate half in a source crosses it exactly), not the API's
  (`movement.wasm`, parser and engine, 711 KB gzipped). The API artifact's size warning in CI moves
  from 600 KiB to 800 KiB gzipped (it still fails at 1 MiB): the Rust engine's traversal blocks,
  record verbs and wake-driven executor took it past the old line, and extraction, the next slice,
  adds more.
- A second deployment shape for automations' background work, push-tick (`deploy/SELF_HOSTING.md`,
  "Deployment shapes"). In `AUTOMATIONS_DRAIN_MODE=external`, `AUTOMATIONS_TICK_URLS` and
  `AUTOMATIONS_TICK_KEY` (new, optional, set together or not at all; half the pair fails boot) make
  each enqueue POST a drain tick to every URL, so a door's work starts without waiting for the
  scheduled tick. `node build/scripts/drain_once.js` (new) drains until idle and exits, for a
  scheduled job with no HTTP. Nothing changes for a deployment that sets none of them.
- A closure written in a movement body holds the scope it was written in by reference, as a
  JavaScript closure does (and a file-level closure already did), rather than a copy of it. A wait
  writes each scope once and each closure as its code and the scope's number, so a parked state
  grows by a few hundred bytes per closure: 14 unused closures in one body park at 8 KB, where
  each copied every earlier one and the state doubled per closure (15 MB). Every language version,
  and a run parked before this resumes with its copies as it did. A parked run now sees what an
  unparked run sees: under version 4 and later, a `MAP` member that parks and returns closures
  which write an outer handle, run by `parallel`, ends with the handle all of them wrote (the outer
  read `"v2"`, as unparked), where it split the handle across the park and the outer read a stale
  `"one"`.
- A named function's declared return no longer hides what its body may hand back: under language
  versions 3 and 4, `function f(): <text> { return COALESCE(org, "x") }` is a call whose use in a
  graph entry, a spread, a written field or a plugin argument is refused at the use, as a closure's
  call is (a use that reaches data cannot hold a record, on every version). A call back into a
  function from its own body (declared recursion) carries nothing for that edge, so recursion is
  no call cycle. The declaration itself is refused only from version 5.
- Security: a Mailgun inbound attachment is fetched with the deployment's key only from an https
  storage URL under `MAILGUN_SENDING_DOMAIN` (`/v3/domains/<domain>/…` on a `mailgun.net` host);
  any other Mailgun URL is refused. Inbound-only deployments must now set `MAILGUN_SENDING_DOMAIN`
  to the domain of their route.
- Moving an automation up to language version 4 now warns (`MOV_HANDLE_READ_FOUND`, a move-up
  warning) on a read of a write handle's `url`. Under version 4 it reads the found record's url,
  where versions 1 to 3 read the link the write returned (null when the update returned none).
  The handle's own result-shape fields other than `url` (today only `externalId`) are exempt.
- A field or child node named `__proto__` in a node declaration or an extraction is refused
  (`MOV_SHAPE_FIELD_PROTO`), and so is a binding, parameter or alias named `__proto__`
  (`MOV_NAME_PROTO`), on every language version. Both used to validate but misbehaved at run time,
  because JavaScript reads that key as an object's prototype: the extracted record never held the
  field, a closure's parameter read as `{}`, and a parked binding was dropped so its resume
  failed. A bug fix, not a language version: an automation using one now fails its check; rename
  it.
- A map spread into a graph (`held = { k: r }` then `graph { ...held }`) that holds a record under
  any key, at any depth or in one arm of an operator, is refused where it is written
  (`MOV_GRAPH_SPREAD_RECORD`, with the path), on every language version. It used to validate from
  version 2 and fail the run at the spread. A bug fix, not a language version: write a field off
  the record, or write the record into the graph as an entry of its own (`k: r`). An unshaped
  spread whose keys nothing names (version 1's map literals) is refused as untyped alone; the
  record's refusal comes with the shape it asks for.
- A graph entry that is not one record or a list of them but may hold a record
  (`graph { a: COALESCE(r, "x") }`, an `IF` arm) is refused where it is written
  (`MOV_GRAPH_ENTRY_RECORD`, with the path), on every language version, on the same terms as a
  spread: it used to validate and the run stored the record as a field. `a: r` (an edge holding
  the record) is untouched.
- A call's value holds what any of the function's returns may hold, so a record or file a return
  hands back through `COALESCE`, `IF` or `MULTI` (`f = () => COALESCE(org, "x")`, or returns that
  disagree) is refused where the call's value goes, as the bound conditional is: a graph entry
  (`name: f()`), a spread, a written field, a plugin argument, an extraction input, a `MAP` or
  `REDUCE` over it. A named function's bound call on every version; a closure's call (and any call
  inside an expression) from version 3, where they run. It used to validate, and the engine handed
  its own record object onward. A bug fix, not a language version: return a field off the record.
  A declared return type that does not take what a return may hold (`(): <text> => COALESCE(org,
  "x")`) is `MOV_RETURN_TYPE` at the declaration from **version 5 (Dancing Wren)**: it ran on
  versions 3 and 4 while the call was unused or only compared, so there the declaration is clean
  and the call carries what the body may hold, refused where it reaches data.
- A union whose every member is a record (`COALESCE(a, b)` of two records, or a function returning
  one of two) is one record for the graph entry: `a: r` over it is an edge, as it is over one
  record, on every version. It was refused as a field holding a record. A union that mixes a record
  with a value is still refused.
- A closure's or function's returns are flattened and deduplicated, and the kinds of engine object
  a type holds are remembered per type, so a chain or fan of calls checks in linear time.
- A plugin argument the plugin declares a value type for (text, a file, …) takes no record or file
  that type does not hold, on every language version (`MOV_CALL_ARG_TYPE`, with the path): a file
  handed to a text argument (`tag(label: f)`, or one arm of a `COALESCE`), a file or record under a
  key or in a list of the value (`tag(label: { a: f })`, `ocr(doc: { a: f })`). Each used to
  validate, and the plugin was handed the engine's own description of the file or record. A bug
  fix, not a language version: pass the file's text (`READ(f)`), a field of the record, or the
  file itself to an argument that takes a file.
- A run's result (and the run records and views built from it) never carries a write record's
  `old` member (it only exists under language version 4), the engine's own handle for the record as
  found (its instance, adapter slug, credential name and full schema). `-[:@old]->` still reads it
  during the run.
- Redis is optional. The API connects to Redis only when `MESSAGE_QUEUE_REDIS_HOSTNAME` is set
  (the port still defaults to 6379); unset, nothing ever tries to connect, in every environment.
  Without it the runaway-loop guard counts in each API process's memory (exact for one instance;
  several instances each count only their own firings), the icon cache is off, and in-flight MCP
  OAuth state is not shared between instances. The bundled composition and the Render blueprint
  still name their Redis. The `localhost` default the API used outside production moved into the
  dev loop, which exports it for the Redis container it runs.

### Fixed

- `MOVEMENT_ENGINE=rust`: a file bound to a name such as `fields`, `body`, `head`, `position`, `op`,
  `mapping`, `closure`, `params`, `origin` or `handle` is a file again after a park and resume
  (before, it came back as a dict and `READ` of it failed). The host now finds a parked state's
  files by the park's structure, never by a member's name, so data shaped like a file (a JSON field,
  an adapter's answer) is never revived as one, whatever key it sits under.
- A graph literal spreading the event (`graph { ...msg }`) or a member of a record (`graph<S> {
  ...co.meta }`, `...msg.meta`) passed its check and then failed every run (MOVENG_UNSUPPORTED for
  the event, MOVENG_RUNTIME for a record's member). The event is now copied as any record is, and a
  record's member reads its field, on both engines.
- `MOVEMENT_ENGINE=rust` runs more automations whole instead of handing them to the TypeScript
  engine: a `match` over a tuple of paths, `IS <Declaration>` of a graph literal holding a system's
  records, a graph spread of the event or of a record's member, `refresh`, and a function (a
  library's too) returning its closure's call. Nothing to set.
- `MOVEMENT_ENGINE=rust` parks and resumes as the TypeScript engine now does: one write handle two
  names hold is written once and comes back as one, a library's node declaration or function is
  found again in its library, and a closure bound at a file's top level is in scope in that file's
  functions and parks by name. A state either engine parks resumes on the other.
- `IS <Declaration>` against a declaration a library writes, of a system's record, failed on
  `MOVEMENT_ENGINE=rust` naming the declaration as unknown; it now compares as on the TypeScript
  engine.
- An extraction's `through` stage naming a priced plugin imported under another name (`import {
  fetch_url as fetch } from plugins`, then `through [fetch(url: …)]`) escaped the run's cost cap:
  the engine looked the plugin up by the name the stage wrote, found no plugin of that name, and
  invoked it as unpriced, under that name. It is now looked up and invoked by the name it is
  registered under, so a run that has spent its cap stops before the plugin starts, and the plugin
  is fed the arguments it declares (its required and extraction-fed ones). A plain call (`page =
  fetch(url: …)`) was already priced by its registered name.
- A run parking on an await could miss a wake that arrived while it parked, and then wait forever.
  The park now writes the parked run before the correlation that points at it, so a wake in between
  finds both or neither. When the re-check after parking itself fails (the remote is down), the run
  stays parked without a wake and the failure is logged with the await's key; the adapter's own wake
  covers later landings.
- Engine: the interpretability scan honours the run's language pin. The save-time check of which
  constructs the engine can run now reads an automation under its pinned language version, not the
  current one, so it reports for a version 1 or 2 automation what the engine would refuse under that
  version. For example, a call to a function written in another letter case reaches the function
  only from version 3: under version 1 or 2 the check now reports it as an unsupported function
  call. The demand scan (which systems' schemas a run's check is given) also reads an automation
  under its pin, including a version 1 or 2 collection operation (`MAP`, `FILTER`, `REDUCE`, …),
  which demands what it read before.
- For embedders: the Rust engine's `eval_expression` refuses an envelope with no `languageVersion`,
  naming it. It used to read a missing version as the oldest behaviour. Pass the movement's pin.
- For embedders: `trace.append` now requires `wire: true`, with its entries on the eval wire. The
  Rust engine now also asks `ids.mint`, `llm.client.call`, `llm.transforms.invoke`,
  `files.resolveFileText` and `log.write`.
- A `parallel` or `race` arm that names a closure written in the movement body (`f = () => { … }`
  then `parallel([f, g])` or `race([f, g])`) and waits inside it resumes. It used to fail "resume:
  no body for arm 0", because the resume looked an arm's name up only as a movement. It now finds
  the closure by its name in the scope around the combinator, as the run did, and its arm resumes
  with the scope it brought in. Every language version; a parked state is unchanged.
- A movement that holds a written record (or a built node) and then waits inside a function it
  calls resumes again. Since the previous fix below, resuming it failed "the parked state refers to
  write handle(s) #0 that it never wrote", because the resume read the movement's own names from
  a copy that only pointed at the record. The resume now finds each record wherever the parked
  state wrote it. Every language version; a parked state written before is unchanged and resumes.
  `MOVEMENT_ENGINE=rust` resumes it the same way, and also resumes one whose name matches a part of
  the parked state's own layout (a record named `body`, `position` or `fields`, say).
- `MOVEMENT_ENGINE=rust` reads a `parallel` / `race` receipt's record slot as the TypeScript engine
  does (the record from language version 5, null before), and runs whole a value that may be a
  record or a value handed to a record parameter under versions 1 to 4 (`position_arg_record` no
  longer appears for it), ending as the TypeScript engine does.
- Two names for one written record stay one across a wait (`b = a`, `b = write a { … }`, or a
  closure that captured it). After resuming, an in-place `write a { … }` or `refresh a` used to
  leave `b` reading the record as it was before the wait; it now reads what `a` does, as a run that
  never waits always did. Every language version: a wait is not part of the language, so what a
  name reads must not depend on it. The same holds for the names a `parallel` / `race` arm or a
  fan-out iteration leaves when it finishes after a wait, and for a node held under two names
  there. A parked state that holds each record once is unchanged.
- A library's closure that waited before testing `x IS <Decl>` against the library's own
  declaration now resumes. The resume looked the declaration up in the root program, so it failed
  "cannot re-resolve code ref", or used the root's declaration of the same name. A parked node
  declaration or function now says which library it belongs to, and is found again there. Every
  language version: the run before the wait already read the library's, so nothing else changes.
  A run that was already waiting when this shipped resumes as before, since its parked state
  does not say which library: one whose library declaration is shadowed by a same-named
  declaration in the root program still reads the root's.
- A closure bound at a file's top level (`f = (n: <number>) => …`), in a library or the root
  program, is now in scope inside that file's functions. The run used to fail "'f' is not in
  scope". It holds its file's scope by reference, as a JavaScript closure holds its module's, so
  it also sees the file's later closures (`f = (n) => g(n) + 1` before `g = …`), and a wait
  stores it by name, so a parked state stays small however many a file declares. Every language
  version from 3, where a closure became callable; it always failed before, so nothing that ran
  changes.
- A record passed to a function another file exports is no longer refused when that file constructs
  the same system ("expects inbox.message, but this argument is inbox.message"). A system is its
  address (the adapter, the credential and the values of literal construction arguments), not
  the name a file binds it to, so two names, in one file or two, for the same system hold the
  same records; a different credential or literal is still a different system, and the refusal
  says which differs. A construction with an argument that is not a literal (`base: b`) stays a
  system of its own. Every language version.
- A Redis outage no longer stalls automations. The loop guard is meant to step aside when Redis is
  unreachable, but a dead Redis used to hang every trigger dispatch indefinitely. Connecting to
  Redis now gives up within seconds, and the guard lets runs through unchecked, pausing its
  counting for five seconds at a time until Redis is back.
- A file whose extracted text contains NUL characters (a PDF with glyphs its font map has no name
  for) no longer fails the run. The text is stored with each NUL replaced by a space, and a failure
  to store the extracted text as provenance is logged rather than failing the run.

### Security

- The Rust engine never takes data an automation reads (a webhook body, an adapter's answer, an
  answer to a question, a callback's fired values, a plugin's output) for one of the engine's own
  objects, whatever keys it carries. Before, a dict whose `kind` named an engine object (`lazyWalk`,
  `closure`, `instance`, `toString`, …) was read as that object, so a webhook body could make the
  run walk a system, or run expression text the body carried. Now such a dict is a plain dict on the
  Rust engine: its `kind` reads as text and a hop off it is refused as a hop off any value is. The
  TypeScript engine has the same fix (the entry below), so a run the Rust engine refuses at
  admission and hands to the TypeScript engine reads such data as data too. Not a language version:
  no construct's meaning changes, and a saved automation runs as it did unless its data impersonated
  an engine object.

- A file is read only where the envelope carrying it declares one, on both engines. Before, any
  value spelling a file's descriptor (`{ "__brand": "FileRef", "source": { … } }`) — a webhook
  body's field, a field answer, a knowledge-graph property, a remote adapter's answer anywhere in it
  — was taken for a live file: `READ`, `extract from [ … ]`, a plugin's fetched record and a write's
  file field read the bytes it named, which could be another team's stored document or any
  connection's file. Now the engine makes a file only at a field a system's schema types `file`, a
  resource's `fileRef`, a field a plugin's output declares a file, `FILE()`'s answer, and a parked
  file the park says is one. The same shape anywhere else is plain data: its keys read and print
  (`TEXT.SERIALISE`), an extraction reads it as its JSON text, `READ` refuses it. No automation
  changes, and there is no new language version.
  - A remote adapter's file is read only at a field its `describe` declares `kind: "file"` (or a
    resource's `fileRef`); the conformance CLI's new `files-declared` check names a field that
    answers one undeclared. File refs sent to a remote adapter (a write, a position's resources and
    evidence) no longer name Listen-Fire's credential or construction args.
  - A callback's `file` parameter is the calling system's handle, and stays data.
  - A run parked before this release that held a file in a value or a record's field resumes holding
    its descriptor as data (`READ` of it fails, naming it); a resource's file still revives as a
    file.
- Every file's bytes are read only for the team the run belongs to. A stored document is read only
  when it is the team's (`FILE()` artifacts and a manual run's uploaded files are now stored under a
  per-team key prefix; a plugin's stored document is the team's by its document row); the store
  reads a key only from a URI of its own bucket with no empty, `.` or `..` segment. A connected
  system's file is read only through the instance the run itself holds for that system, never one
  the file names. A file whose handle is a URL (email, WhatsApp) is fetched only from where its
  system's configuration says it issued it: the email provider's own storage; WhatsApp's configured
  Twilio account's media (none when `TWILIO_ACCOUNT_SID` is unset) or a URL this deployment exposed.
  A file written into text — a field, a prompt, a trace — is only its name, type, size and handle;
  its source, credential and URL are never written, and reading them off a file gives nothing.
  Anything else fails the run with `FileOutsideTeamError` (`FILE_OUTSIDE_TEAM`), never an empty
  read, and nothing is fetched. Operators: a `FILE()` artifact or a manual run's file stored before
  this release, still held by a parked run, is no longer readable by it.

### Changes to what a saved automation does (every language version)

- A field or child node named `__proto__`, in a node declaration or an extraction, is refused
  (`MOV_SHAPE_FIELD_PROTO`). It used to validate, but the extracted record never held the field:
  JavaScript set the record's prototype from the model's answer instead. A bug fix, not a language
  version: an automation declaring one now fails its check on every version; rename the field.
- A binding, a parameter or an alias named `__proto__` is refused (`MOV_NAME_PROTO`). The engine
  keeps a scope's names as an object's keys, and JavaScript reads that key as the object's
  prototype: a closure's parameter so named read as `{}`, and a parked binding so named was dropped,
  failing its resume. A bug fix, not a language version: rename it.
- A record plugin's answer whose data holds an own `__proto__` key (as JSON text makes one) keeps it
  as a key on both engines. Before, the TypeScript engine lost it: preparing the answer assigned
  each key, which made it the answer's prototype. Merging the data into the record still assigns, as
  JavaScript's `Object.assign` does, so the key becomes the record's prototype and a field read goes
  through it.
- A prototype a record plugin's data gives its record does not survive a park, on either engine: the
  parked record holds its own fields only.

## [v0.11.0] - 2026-10-12

Language version 4, **Luminous Owl**, arrives. New automations are written in it. The deploy check
moves an existing automation up to it when it validates cleanly there. An automation with an error,
or with a move-up warning (`MOV_MATCH_MISS_CONTINUES`, `MOV_HANDLE_UPDATED_IN_PLACE`,
`MOV_HANDLE_READ_FOUND`: the same text now does something different), stays on its version, shows
Review and lists the diagnostics, and behaves exactly as before. Read each warning, edit what
assumed the old behaviour, and upgrade with `upgradeAutomation`, acknowledging it.

### Language version 4, Luminous Owl: what breaks

Each item applies only to an automation on Luminous Owl (4). Versions 1 to 3 keep their old
behaviour exactly (proved by a version 3 conformance corpus). Every rule, with examples and
rewrites, is in the [Luminous Owl migration guide](docs/language/luminous-owl-migration.md).

- **A named `match` yields a handle or absent.** A miss binds absent and the block carries on. Why:
  a miss ending the enclosing scope was never the intent, and it made `match` useless as a lookup.
  Guard with `== null`, `!= null`, `EXISTS` or `ISNULL`. Unguarded use where a value is required is
  `MOV_ABSENT_REQUIRED`, and so is a `link` or `unlink` whose end may be absent. Move-up warning on
  every bound match, held until acknowledged: `MOV_MATCH_MISS_CONTINUES`.
  - An unnamed `match … { }` is `MOV_MATCH_UNNAMED`: write `existing = match … { … }` then
    `if existing != null { … }`.
  - `link a -[:e]-> { match … }` is `MOV_LINK_MATCH_BODY_RETIRED`: bind the match, then
    `if to != null { link a -[:e]-> to }`.
- **`created` and `committed` leave the write handle** (`MOV_HANDLE_FIELD_RETIRED`). Why: they made
  a write handle a different type from a read. `-[:@old]->` carries the pre-write record instead, so
  an automation can say honestly whether it created or matched, and what changed. `.created` becomes
  `NOT EXISTS(h-[:@old]->)`. `.committed` becomes `FIRST(h-[:@old]->) != h` (TRUE when the write
  landed; under `dry_run` a write that matched lands on the handle itself), or is dropped where
  `dry_run` is a literal on the instance. A `dry_run` create has an empty `@old`, so for a created
  record `!= h` alone does not say the write landed. `committed` remains in the run log.
- **`write org { … }` on a write handle updates the record `org` names in place.** `org` reads the
  new values below the line; before, it kept the values of its own write. Why: the handle names a
  record, so a write to it should change what it shows. Move-up warning
  `MOV_HANDLE_UPDATED_IN_PLACE`, held until acknowledged, on the unnamed form and on
  `x = write org { … }`, which names the same record.
- **Reading a field the write did not set, off its handle, reads the record as the write found it.**
  Before, it read what the system handed back from the write, often nothing. A field set with `?:`
  or `+:` counts as not set. Why: the handle names the record, so its fields are the record's.
  Move-up warning on each such read, held until acknowledged: `MOV_HANDLE_READ_FOUND`.

### Language version 4, Luminous Owl: new

- `-[:@old]->` on any write handle: empty when the write created (under `dry_run` too), a snapshot
  of the record as it stood when it matched, the handle itself under `dry_run` when the write
  matched (an in-place write included), and the previous handle after a second write. `@old` on a
  match handle, a traversal landing or a local node is `MOV_OLD_EDGE_NOT_A_WRITE`; any other `@name`
  is `MOV_ARTIFICIAL_EDGE_UNKNOWN`.
- The named match pattern: `existing = match … { … }` then `if existing != null { … }`.
- A write off a record found earlier (`x = write c { … }` on a traversal landing or a matched
  record) is a write handle, with `@old`.

### Changes to what a saved automation does (every language version)

These apply to every language version. Full text: the [migration guide's
appendix](docs/language/luminous-owl-migration.md#appendix-every-version-changes-in-full).

- The `else` arm of a null test narrows absence. It accepts only programs that were refused before.
- An adapter edge or collection whose name starts with `@` is left out of the catalog with a note,
  instead of failing the connection's `describe`.
- An Affinity identity candidate carries the organisation's or person's fields as Affinity holds
  them, not the asserted values.

### Fixed

- An awaited `parallel` or `race` whose arms are built at run time (`await parallel(arms)`) now
  binds its result as a value that nobody can type, as the same combinator does without `await`.
  Before, it was bound as a record, so writing it into a field was refused even when the arms
  returned values. Arms that return records are now accepted there too, because the result is still
  not typed from what its arms return. The same holds, as before, for a literal arm that returns a
  record (`await parallel([() => { return org }])`). Typing the result from its arms, so both forms
  are refused, is a follow-up.

### Security

- Data from a connected system or a webhook is always treated as data. Before, a value that copied
  the shape of one of the engine's internal objects could be run as part of the automation: a
  webhook body or a field answer could make the engine follow its edges and evaluate expression text
  it carried. The engine now marks its own objects in a way no data can carry. No automation
  changes, and there is no new language version.
- A record placed inside a value is now refused when the automation is validated, as a record placed
  directly in a field already was. This covers a write or match field (`MOV_WRITE_FIELD_TYPE`) and a
  plugin argument that takes structured data or declares no type (`MOV_CALL_ARG_TYPE`), with the
  record under a key of a dict, in a list, or in either arm of an `IF`. The message names where in
  the value the record sits. Before, such an automation validated, and the connector or plugin
  received the engine's internal description of the record, including the connection's schema and
  credential name, and passed it to the vendor. Write a field off the record in its place. For a
  record the automation wrote, you can instead spread the fields it was written with (`{ ...org }`).
  Passing a whole record to a plugin argument that takes structured data still hands the plugin the
  record's fields. This applies to every language version, with no new version:
  - An affected automation shows a Validation Issue at the next release's deploy check. Its runs
    fail with `MOVENG_CHECK` until the record is taken out of the value.
  - Operators will see one `[DeployCheck] PRESERVATION FAILURE` log line for each affected
    automation. This is expected for this release.
  - The class is not fully closed. On language versions 1 and 2 only, a record handed back by a
    function called inside an expression (`company: f()`, `summarise(data: { a: f() })`) is still
    accepted, and is a follow-up. Those versions do not type a call written inside an expression.
    Versions 3 and 4 refuse it.
- A file placed inside a value is now refused when the automation is validated, as a record is. A
  file goes only into a field that holds files. This covers a write or match field
  (`MOV_WRITE_FIELD_TYPE`) and a plugin argument that takes structured data or declares no type
  (`MOV_CALL_ARG_TYPE`). The file may be under a key of a dict, in a list, in either arm of an `IF`,
  in a dict that is spread, among the fields of a record handed whole to a plugin, or handed back by
  a function. A file written straight into a field that is not a file field is refused the same way,
  a text field included. The message says "a file, not a value" and names where in the value the
  file sits. Before, only a file written straight into a json field was refused; otherwise the
  automation validated, and the connector or plugin received the file's internal descriptor. Put the
  file in a file field, or put its text in its place (`READ(f)` inside a value,
  `COALESCE(READ(f), "")` for a whole field). A field that only takes files still refuses a record,
  in either arm of an `IF` or in a spread list. This applies to every language version, with no new
  version:
  - An affected automation shows a Validation Issue at the next release's deploy check. Its runs
    fail with `MOVENG_CHECK` until it is edited. Operators will see one
    `[DeployCheck] PRESERVATION FAILURE` log line for each affected automation.
  - Attio pulled a file out of any field of a record it was writing and uploaded it as an
    attachment. So a file written into an Attio text field worked by accident; it is now refused at
    validation. Write it into a file field instead.
  - Not closed yet, and follow-ups:
    - on language versions 1 and 2 only, a file handed back by a function called inside an
      expression, for the same reason as a record;
    - a file passed to a plugin argument typed text, or a dict holding a file passed to one
      (`tag(label: f)`, `tag(label: { a: f })`);
    - a dict holding a file passed to a plugin argument typed file (`ocr(doc: { a: f })`);
    - a file joined into a text (`"x${f}"`), which renders as `[object Object]`.
- A record or file reached through `COALESCE`, `IF … THEN … ELSE … END` or `MULTI`, through a
  `through [ … ]` stage, through an extraction input, or through `AT` on a record is now refused
  when the automation is validated, or rendered as its fields. Before, the checker could not see the
  record or file there, and the engine handed its internal object onward, to a connector, a plugin,
  an extraction prompt, or a lookup. This applies to every language version, with no new version:
  - `COALESCE`, `IF` and `MULTI` hold what their operands hold. A record or file in any arm is
    refused where the direct form is (`MOV_WRITE_FIELD_TYPE`, `MOV_CALL_ARG_TYPE`), as in
    `company: COALESCE(org, "x")`, `summarise(data: MULTI(org))` or
    `title: IF c THEN f ELSE "" END`. A name bound to one carries its arms, so
    `x = IF c THEN f ELSE org END` then `upload: x` is refused, and so is `x = COALESCE(org, "x")`
    then `company: x`. `AND` and `OR` always give true or false, so a record among their operands
    goes nowhere and is still accepted.
  - A `through [ … ]` stage's argument is held to what the plugin takes, as a plain call's argument
    is (`MOV_CALL_ARG_TYPE`). A record passed whole to an argument that takes structured data, or
    that declares no type, is handed the record's fields, as a plain call's is. Before, the stage
    was handed the engine's internal object.
  - An extraction prompt shows a record as its fields, as a JSON object, at any depth
    (`extract from [org]`, `extract from [{ a: org }]`). Before, the prompt showed the engine's
    internal object, including its handle and the connection it came from. A file input is read as a
    file, as before. Every record in an input is checked, at any depth and in any arm of an
    operator, and so is a record passed whole to a plugin argument that takes structured data or
    declares no type:
    - a record whose fields include a file is refused (`MOV_EXTRACT_CONTENT`, `MOV_CALL_ARG_TYPE`),
      because the prompt or plugin would receive the file's internal descriptor. Pass the file as an
      input of its own, or its text (`READ(f)`). This is decided by the record's type, so a record
      whose system has a file field is refused even when that field is empty;
    - a system's record, whose fields are read one at a time, is refused: pass a dict of the fields
      it needs. So is a connection (`extract from [crm]`);
    - a file inside an input (under a key) is refused: pass it as an input of its own.
    - The engine refuses all of these too (`MOVENG_UNSUPPORTED`), so a file's descriptor never
      reaches a prompt.
  - `MULTI(…)` of records or files now has the type of a list of them, so `FIRST(MULTI(org))` is the
    record `org` is, and the field rules apply to it. A `MULTI` of plain values stays untyped, as
    before. `FIRST`, `LAST`, `ONLY` and `AT` at an index over a list whose type says nothing
    (`MULTI(org, "x")`, `COALESCE([org], ["x"])`) may hand back any member, so a record or file
    among the members is refused where it lands.
  - An adapter instance written straight into a field (`company: crm`, or `x = crm` then
    `company: x`, in a write or a match) is refused with `MOV_WRITE_FIELD_TYPE`, as
    `company: { a: crm }` already was. This is older than this change.
  - `AT(r, key)` on a record is refused with `MOV_AT_RECORD_KEY` for any key that is not an index
    (`AT(org, "graph")`, `AT(org, k)`, `AT(COALESCE(org, "x"), "graph")`). A record is not a map;
    read a field with a dot (`` org.`Name` ``). Before, such a lookup read nothing or the engine's
    internal member.
  - An affected automation shows a Validation Issue at the next release's deploy check. Its runs
    fail with `MOVENG_CHECK` until it is edited.

## Earlier releases

Releases before v0.11 are kept one file per minor line, newest first:

- [v0.10.x](docs/changelog/v0.10.md) (v0.10.0 to v0.10.9)
- [v0.9.x](docs/changelog/v0.9.md) (v0.9.0 to v0.9.1)
- [v0.8.x](docs/changelog/v0.8.md) (v0.8.0 to v0.8.5)
- [v0.7.x](docs/changelog/v0.7.md) (v0.7.0)
- [v0.6.x](docs/changelog/v0.6.md) (v0.6.0 to v0.6.2)
- [v0.5.x](docs/changelog/v0.5.md) (v0.5.0)
- [v0.4.x](docs/changelog/v0.4.md) (v0.4.0)
- [v0.3.x](docs/changelog/v0.3.md) (v0.3.0)
- [v0.2.x](docs/changelog/v0.2.md) (v0.2.0)
- [v0.1.x](docs/changelog/v0.1.md) (v0.1.0 to v0.1.2)

[Unreleased]: https://github.com/listen-fire/listen-fire/compare/v0.11.0...HEAD
[v0.11.0]: https://github.com/listen-fire/listen-fire/compare/v0.10.9...v0.11.0
