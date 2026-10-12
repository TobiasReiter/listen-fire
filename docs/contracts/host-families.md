# The host families

Version: 1

The movement engine runs a program. Everything outside the program goes through one interface the caller hands it, `EngineHost` (`apps/api/src/services/movement_engine/host.ts`): adapters, model calls, parking, cancellation, files, the acting principal, write locks, the trace, the clock and fresh ids. The engine imports none of these itself. This document is that interface and the four entry points into the engine. How this repository's two hosts serve it, and the engine's own notes, are in [`docs/engine-host.md`](../engine-host.md). The data shapes are in the `engine-contracts` package (`packages/engine-contracts/`).

This document is the host contract, frozen as JSON. Every host call is one request and one awaited answer, each plain JSON: no callback, live object, `Date`, stream or shared array crosses, and instants are ISO 8601 strings. An embedder in another language or process serves exactly these shapes.

Every call is made inside a segment. Each `segment.open` opens exactly one segment and answers its id; every other call names that id as `segmentId`. The host maps the segment to the run and the team it was opened for, so no request repeats the team. Every `segment.open` carries the version of this contract the engine speaks (`hostFamiliesVersion`), and a host refuses a version it does not serve (see [Versions](#versions)).

Two tests hold the contract to this document (`movement_engine/__test__/seam_guard.unit.test.ts`):

- **The import rules.** An engine file that starts importing host code fails.
- **The round trip.** Every method of every family is wrapped in a JSON round trip (each request and answer serialised and parsed, anything JSON cannot carry refused by path), and representative programs reach every method. The set of methods is the manifest `HOST_FAMILIES` (`packages/engine-contracts/host_families.ts`), which the compiler holds equal to `EngineHost` (`host.ts`), and which the test holds equal to the method headings below. A third test holds `HOST_FAMILIES_VERSION` (`packages/engine-contracts/versions.ts`) equal to the version at the top of this document.

## Versions

- **The version is an integer**, stated at the top of this document and held by `HOST_FAMILIES_VERSION`. This release serves version 1 only ([the index](README.md) lists what each release supports and deprecates).
- **On the wire:** every `segment.open` request carries `hostFamiliesVersion`. A host refuses an open whose version it does not serve, or that names none, before it opens anything. The refusal is a thrown failure whose message names the contract, the version it was handed and the versions it serves: `segment.open carries host families version 2, which this host does not serve (supported: 1)`. The entry fails before any statement runs.
- **What bumps it:** a change in meaning. A method removed or renamed, a field whose meaning changed, a required field added to a request, or an answer reshaped. An optional request field a host may ignore, or a new optional family, keeps the version.
- **A required family is part of the version.** Adding one bumps it, as any required addition does. A host that lacks a required method is refused by the engine before `segment.open`, with a message naming each missing method (`the host does not serve clock.now, ids.mint, which host families version 1 requires (the clock, ids families); no segment was opened`). The engine checks every method of every family the manifest does not mark optional.
- **How a break lands:** the engine sends the new version; a host that serves both branches on it at the point of difference. It is never a second host interface.

## Conventions

The shapes are TypeScript-ish. These rules apply to every one of them.

- **The segment.** Every request but `segment.open`'s carries `segmentId: string`, the id `segment.open` answered. A method with nothing else to say takes `{ segmentId }` alone. A call the host answers from what the segment is for (its team, its instances: `adapters.*`, `park.wake`, `park.bindings.*`, `lookup`) is refused when the segment is not open, never opened or already closed: `adapters.call` answers an `adapter_error`, the others throw, and the message names the segment. Closing a segment twice is not refused (see `segment.close`).
- **Optional fields.** `x?: T` means the field may be absent. An absent field and one that is `undefined` are the same; a host never sends `null` for an absent optional field unless the type says `| null`.
- **`unknown`.** Any JSON value, opaque to the receiver: carried, never interpreted.
- **Numbers.** Finite. Money is integer microdollars.
- **Instants.** ISO 8601 strings with an offset (`2026-10-07T09:00:00.000Z`).
- **Answers.** Every method answers a promise. A method shown answering `void` answers nothing (JSON `null` over a wire).
- **Failure.** A method fails one of two ways.
  - **As data**, in the answer: only `adapters.call` (an `error` variant) and the priced calls (a `budget` refusal). The engine branches on these.
  - **By throwing.** Over a wire, a thrown failure travels as an error envelope (below). The engine fails the statement with the message, exactly as it fails one on its own error, so a remote host may throw a plain error with the same message. The engine branches on the class of three thrown failures (`movement_engine/errors.ts`), and a host that means one of them throws it under that class:
    - **`RunCancelledSignal`:** the run was cancelled by request. The cancel gate (`control.cancel.cancelled`) throws it. The engine stops the run and reports it cancelled; the writes already made stand.
    - **`RunLeaseLost`:** the segment no longer holds the run, so another instance may. The cancel gate throws it, as does a park the lease fence refused. The engine stops the run and records or settles nothing.
    - **`MovementEngineError`, with its `code`:** the engine's own failure (`MOVENG_RUNTIME`, `MOVENG_NOT_FOUND`, …). The run fails as though the engine had raised it, under that code, which the caller reads.
    - The first two are control flow, not failures: no collection op's `onError` forgives either. Every other class is a plain failure.

  **The error envelope.** A thrown failure as JSON, wherever one crosses as data (a host over a wire, a conformance recording):

  ```ts
  interface ThrownError {
    class: string;      // the thrown class's name (`RunLeaseLost`); `Error` for a plain one
    code?: string;      // a `MovementEngineError`'s code; absent otherwise
    message: string;    // the thrown message; a `MovementEngineError`'s may lead with its `CODE: `, which a reader drops when it rebuilds one
  }
  ```

  A reader rebuilds the three classes above as themselves and any other as a plain error under the recorded name.
- **Retries.** The engine never retries a host call. A host that retries does so inside the call, and only where this document says the call is idempotent.

## Shared shapes

```ts
type TeamId = string;            // the tenant: an opaque id the host mints (`TenantId` in `engine-contracts`)
type LanguageVersion = number;   // the movement's pin (1 = "Quiet Heron", …)

// Priced calls
interface Budget { remainingMicrodollars: number | null }   // null: no cap
interface CostLine { source: string; microdollars: number } // source is `kind:name`, e.g. `model:claude-sonnet-5`
type Priced<I> = I & { budget: Budget };
type Costed<O> = O & { cost?: CostLine[] };                  // absent: spent nothing
type BudgetRefusal = Costed<{ error: HostCallError & { kind: 'budget' } }>;
type PricedAnswer<O> = Costed<O> | BudgetRefusal;

// Failures as data
interface HostCallError {
  kind: 'call_ceiling' | 'adapter_error' | 'budget';
  message: string;
  name?: string;            // the failure's own class name on the host (`SlackApiError`); absent for a plain Error
  detail?: HostErrorDetail;
}
interface HostErrorDetail {
  status?: number;          // the HTTP status the remote answered
  code?: string;            // the remote's error code
}

// A file, as a descriptor: never the bytes
interface FileRef {
  __brand: 'FileRef';
  name?: string;
  contentType?: string;
  size?: number;
  source?:
    | { adapterType: string; credentialId?: string; constructionArgs?: Record<string, string>; handle: string }
    | { store: 'document'; objectUri: string }
    | { ownerAdapterType: string; handle: string };   // an earlier spelling, read from old parks only
  url?: string | null;
}

// The event a run fired on (translation_graph/triggers/types.ts)
interface TriggerEvent {
  pipelineInputId: string;
  adapterType: string;
  triggerType: 'snapshot' | 'poll' | 'changes-feed' | 'webhook' | 'mutation' | 'extraction';
  payload: unknown;
  objectType?: string;
  triggerEntryId?: string;
  changeType?: 'create' | 'update' | 'delete';
  actor?: { type: 'user' | 'api-token' | 'system'; id: string | null };   // who acted, as the producing system asserts it; the opaque principal reference comes later
  snapshotRunId?: string;
  snapshotComplete?: boolean;
  recordId?: string;
  externalRecordRef?: { adapterType: string; externalId: string; recordType?: string };  // the source system's id for the record
  rootRecordType?: string;
  changedFields?: string[];
  idempotencyKey?: string;
  occurredAt?: string;
}

// A parked flow's whole state (`ParkedScopeState` in `engine-contracts`), opaque to the host
interface ParkedScopeState { version: 1; address: string; bindingName: string | null; scopeChain: unknown[]; /* … */ }

// Who an event acts as: an opaque reference the host mints
interface PrincipalReference { id: string; display?: string }
```

`ParkedScopeState` ([`park-state.md`](park-state.md)) and `MovementTraceEntry` (`movement_engine/expression.ts`) are engine-defined JSON. A host stores them and hands them back byte for byte; it never reads inside them.

## What a run is given

- **Data.** The source and its language version, a `CatalogSnapshot`, the credential ids its imports name (`credentialIds`: import name to id, beside the snapshot, never in it), the trigger event, the instant it fired (`firedAt`, an ISO 8601 string; every clock read the program makes answers from it), the cost cap (`costCapMicrodollars`, absent for none) with what the run spent before this segment, and, on resume, the parked state. A run may also be handed addresses to suspend at (`suspendAt`: just before a statement, or before the k-th call a statement makes); the first flow to reach one parks there once.
- **The catalog snapshot** ([`catalog-snapshot.md`](catalog-snapshot.md)). The team's catalog as plain JSON: adapters and their schemas, credential names, plugins, models, and the saved files the program imports (file imports resolve from the snapshot's `files` only). Everything the engine knows of a plugin comes from the snapshot's `plugins`: the arguments a stage feeds it (`fedArgs`), the ones it must be handed (`requiredArgs`), what a plain call hands back (`output`, `earlierOutputs`), and whether it is `priced`.
- **A host.** The families below.

## Entry points

A run is entered one segment at a time. Each entry is one call into the engine with one JSON input, the host beside it; the engine opens one segment for it and closes it as it returns. Four engine calls serve every way in: `runMovement`, `resumeMovement`, `settleRaceFrame` and `fireCallbackBody` (`movement_engine/run.ts`). What follows is each input, and which a run host passes in each situation. (Production's run host is `translation_graph/movement/execute.ts` and the resume drivers beside it.)

### The input every entry takes

```ts
interface RunInput {
  source: string;                         // the pinned version's source, byte for byte (a resume re-parses it, so every address is the same)
  languageVersion?: LanguageVersion;      // the pin the run started under; absent: the current version
  movementName?: string;                  // which movement in the file; absent: the file's only one
  event: TriggerEvent;                    // the event the run fired on (a resume passes the run's original)
  teamId: TeamId;                         // the team the segment is opened for
  runId?: string;                         // the run record; absent for a test or a dry run
  firedAt?: string;                       // ISO 8601: when the run first fired; every clock read answers from it
  costCapMicrodollars?: number;           // the cap, read by the run host as each segment starts; absent: no cap
  priorSpentMicrodollars?: number;        // what the run spent in its earlier segments; absent: 0
  capBaselineMicrodollars?: number;       // what the run had spent when last resumed from a limit pause; absent: 0
  limitPaused?: boolean;                  // the run is paused at a limit (see "Operator limit resume")
  catalog: CatalogSnapshot;
  credentialIds?: Record<string, string>; // import name to credential id
  dryRun?: boolean;                       // rehearse every target
  suspendAt?: string[];                   // addresses to suspend at, once each
}
```

- A run host passes the run's own `firedAt` on every entry, the first included (production: the run row's `started_at`). Absent, the engine asks `clock.now` once as the segment opens and pins that, which a park does not survive.
- The cap counts `priorSpentMicrodollars - capBaselineMicrodollars` plus what this segment spends.

### First firing

```ts
runMovement(input: RunInput)
```

- A fresh run: `priorSpentMicrodollars` and `capBaselineMicrodollars` are 0 (or absent), `limitPaused` is absent.

### Resume

```ts
resumeMovement(input: RunInput & {
  state: ParkedScopeState;        // the parked leaf's state, as park.sink stored it
  answer?: unknown;               // what to bind on a step-past resume (an ask's answer)
  reenter?: boolean;              // absent: false
  deferRaceSettlement?: boolean;  // batch mode; absent: false
})
```

- **The address.** `state.address` is the parked leaf's own address, the `address` its `commitTimerPark`, `commitAwaitPark` or `commitSuspension` was given. The resume descends the program to it through `state`'s frames and scopes.
- **Step past** (`reenter` false). The parked statement is done. The resume binds `answer` (when given) at `state.bindingName` and continues with the statement after it. An answer is a JSON scalar, or a curated row set `{ __correct: { type: string; rows: Array<{ fields: Record<string, unknown> }> } }`. A timer's `sleep` resumes this way, with no answer.
- **Re-enter** (`reenter` true). The parked statement runs again: an await re-checks its edge live and binds its own landing, an `until` timer re-tests its condition, and a limit suspension re-runs its statement, replaying the calls it had finished. `answer` is ignored.
- Which a host passes, by what the leaf was parked on:

| Parked on | `reenter` | `answer` |
|---|---|---|
| an ask (answered) | false | the validated answer |
| a timer `sleep` | false | absent |
| a timer `await until(…)` | true | absent |
| an await (woken) | true | absent |
| a limit suspension (operator resume) | true | absent |

- The result says what became of the leaf: `parked` with `parkedAddress` (the same address: an await or `until` that re-armed; another: the branch parked further on), `cancelled`, or neither (the branch completed; see "Join closing").

### Race settlement

- **Inline** (`deferRaceSettlement` false). A race arm that completes on resume persists its exports and decrements the race's frame, as a join branch does (see "Join closing"; a race's frame is pending one). The first to complete wins: in the same segment it cancels the arms still parked (`park.sink.cancelSubtrees`) and runs the race's continuation. A later one stops.
- **Batch mode** (`deferRaceSettlement` true). A host that resumes every resolvable leaf of a run in one pass (production's await drain) defers each race: a completing arm persists its exports and decrements the frame, but settles nothing, and the result lists the race's frame address in `deferredRaceFrames`. Once every leaf of the pass has been stepped, the host settles each listed frame once, so every branch that completed in the pass is a winner:

```ts
settleRaceFrame(input: RunInput & {
  state: ParkedScopeState;  // any completed branch's state from the pass
  frameAddress: string;     // one of the pass's deferredRaceFrames
})
```

- The settlement builds the race's answer from every completed branch's exports (`park.sink.collectBranchExports`), cancels the arms still parked, and runs the continuation after the race statement.

### A callback body

```ts
fireCallbackBody(input: RunInput & {
  state: ParkedScopeState;          // the callback's captured continuation, as park.callbacks.mint was given it
  values: Record<string, unknown>;  // the call's values, validated against the callback's parameters
  callIndex: number;                // the call's index on the callback's ledger
})
```

- `state.address` is the callback expression's address. The body runs in a child of the captured scope, at its own address frame (`callIndex`), so the bodies of a repeatable callback's calls never share a leaf.
- A body never suspends: one that meets the cost cap fails, as that call's failure only.
- A body never settles the run. The run's main continuation stays parked; a body that parks gets a leaf of its own. A host wakes the run's awaiters on the callback after the body (production: in the same process, with a queued wake behind it).

### Operator limit resume

- A run paused at its cost limit is resumed by an operator only. The host lifts the pause first, then resumes each leaf the pause suspended (`commitSuspension`) with `reenter: true`, `limitPaused` absent, `priorSpentMicrodollars` the run's spend, and `capBaselineMicrodollars` the run's spend at this moment, so the cap counts afresh.
- Any other entry into a run that is paused, except a callback body, passes `limitPaused: true`. A callback body never suspends (see "A callback body"), so it runs whole, pause or not. For the others, the woken branch takes its event (binds the answer, steps past the sleep) and then suspends before its next statement, joining the pause.

### Join closing

The decision that a join has closed is split between the engine and the run host.

- **The engine closes the frame.** A resumed branch that completes walks back up through its join frames (`parallel`, a fan-out, a race). At each one it persists its exports (`park.sink.persistBranchExport`) and decrements the frame (`park.sink.decrementJoin`). `closed: true` comes back for exactly one branch, which collects the exports (`collectBranchExports`) and runs what follows the join, in its own segment. Any other branch's segment ends there. Without `park.sink`, a resumed join closes only its own leaf.
- **The run host closes the run.** Whether the whole run is complete is not a host call: the host decides it from what its park sink persisted, once the segment has returned without parking, cancelling or failing. The run is complete when no join frame is still pending and no leaf other than the one just resumed is parked (production: `settleBranchComplete` in each resume driver). Complete, the host settles the run `success`; otherwise it records the segment's writes and keeps the run parked.

### What an entry answers

Every entry answers the segment's result (`MovementRunResult`, `movement_engine/run.ts`), or throws carrying the same result as far as it got.

- **`writes`** is every write, link, unlink and delete the segment made, in program order: as the program's text orders them, and the writes of concurrent branches (a collection op's members, a `race`'s or `parallel`'s arms) by branch index, each branch's writes together at the place of the fork. It is never the order the writes landed in, so two hosts that answer at different speeds get the same ledger. A write that cites another (`origin.writeIndex`; a provenance origin `{ kind: 'write', write }`) names its position in this list.
- **`trace`** is in the same order: each branch's entries together, in branch order.

## The families

| Family | Methods | Optional for an embedder |
|---|---|---|
| `segment` | `open`, `close` | no |
| `adapters` | `resolve`, `call` | no |
| `llm.client` | `call` | no (may throw, if the embedder's programs never call a model) |
| `llm.extractCall` | `call` | same as `llm.client` |
| `llm.transforms` | `invoke` | same as `llm.client` |
| `llm` | `arbitrateEntities` | same as `llm.client` |
| `park.sink` | `recordJoin`, `commitTimerPark`, `commitAwaitPark`, `decrementJoin`, `persistBranchExport`, `collectBranchExports`, `cancelSubtrees`, `commitSuspension`, `commitLimitPause` | yes: absent, a run that reaches a park fails (a dry run) |
| `park` | `wake` | no (may throw, if `park.sink` is absent: only an await park asks for a wake) |
| `park.callbacks` | `mint`, `calls` | yes: absent, `callback(…)` fails as unsupported |
| `park.bindings` | `record`, `findBoundCounterpart`, `delete` | no (may throw, if no program binds) |
| `control.cancel` | `cancelled`, `cancelledNow` | no (answer `false` for a run nothing cancels) |
| `files` | `resolveFileText`, `render` | no |
| `lookup` | `resolveActingUser` | no (answer `null` when no user is known) |
| `locks` | `acquire`, `release` | no |
| `trace` | `append` | yes: absent, the trace is on the run's result only |
| `clock` | `now` | no |
| `ids` | `mint` | no |

"No (may throw…)" means the family must be present, and a method of it may throw naming itself: the engine fails only a run that reaches it.

### `segment`

A segment is one entry into the interpreter: a fresh run, a resume, a race settlement, a callback body (see "Entry points"). The engine opens one at each entry point and closes it however the segment ends (completes, parks, throws). The host's half of a segment holds the run and team it is for, what the segment's adapter calls have read (a read memo, so a record read three times is one request), how many third-party calls they have made (an adapter call ceiling supplied by the host), the pin they answer under, and the adapter instances and lock session it holds.

#### `segment.open`

```ts
request: { runId?: string; teamId: TeamId; languageVersion: LanguageVersion; hostFamiliesVersion: number }
answer:  { segmentId: string }
```

- `runId` is absent for a test or a dry run with no run record.
- `hostFamiliesVersion` is the version of this contract the engine speaks. A host refuses, by throwing, a version it does not serve or an open that names none, before it opens anything; the message names the contract, the version seen and the versions served (see [Versions](#versions)).
- One open is one segment: the answer is a fresh id, and every later call of the segment names it. The host answers each of those calls for this `runId` and `teamId`.
- **Persist:** nothing durable. The segment lives as long as the process serving it.
- **Retry:** not idempotent; each call opens a fresh segment. A failed open fails the entry before any statement runs.

#### `segment.close`

```ts
request: { segmentId: string }
answer:  { cost?: CostLine[] }
```

- `cost` is what the segment's adapter calls spent on priced work of their own (an adapter's model call to match a record). The engine charges it to the run as the segment ends, so it reaches the run's figures but not the cap check inside that segment.
- Closing forgets the segment's adapter instances and closes its lock session, releasing any lock still held.
- **Persist:** nothing.
- **Retry:** idempotent. Closing a segment that is not open answers no cost. The engine calls it exactly once per opened segment and logs (never raises) a failed close.

### `adapters`

The engine never holds a live adapter. It resolves an instance to data and an opaque id, then calls it by method name with one JSON argument.

#### `adapters.resolve`

```ts
request: {
  segmentId: string;
  adapterType?: unknown;                       // a JSON value the host keys its registry by; normally text (absent: a value naming none)
  credentialsId?: string;
  constructionArgs?: Record<string, string>;   // non-credential construction args, unquoted (Sheets' `spreadsheet:`)
  role: 'source' | 'target';
  dryRun?: boolean;                            // rehearse writes: capture, never make
}
answer: {
  instance: string;                            // opaque, meaningful only within `segmentId`
  adapterType: string;
  supportedTriggers: TriggerEvent['triggerType'][];
  capabilities: {
    traversal: { incoming: boolean; edgeProperties: boolean };
    resources: boolean;
  };
  methods: Array<AdapterMethod | 'iterateRelated'>;   // what the instance implements
  walksContainers?: boolean;
  webhookEventTypeId?: string;
  metaRecordType?: string;
}
```

- An instance is its resolution. Within a segment, resolving the same `adapterType`, `credentialsId`, `constructionArgs` (in any key order) and `dryRun` again answers the same `instance` id, whichever `role` asks. A rehearsal (`dryRun`) is a different instance from the live one. The host constructs the instance for the segment's team.
- `methods` lists the `adapters.call` methods the instance implements, plus `iterateRelated` when it streams a traversal (the engine walks the stream with `iterateRelatedPage`). An instance may stream, page, both or neither.
- **Rehearsal.** A `dryRun` instance captures each create, update, delete, link and unlink into the host's write sink instead of making it, and answers with ids it invents; its reads go to the live system. The rehearsal (the sink, the invented ids) belongs to the segment, because a write chained off a rehearsed parent routinely crosses systems.
- **Throws** when the adapter cannot be constructed (an unknown type, a credential it cannot load), and when the segment is not open.
- **The slug is a key.** An instance a program reads from a value names its slug with whatever the value holds, and the engine forwards it as it is. The host looks it up as a property key (its text: a list `["email"]` finds `email`); a slug that names no adapter is the unknown-type throw, a host error the engine treats as any other.
- **Persist:** nothing. **Retry:** idempotent within a segment.

#### `adapters.call`

```ts
type AdapterMethod =
  | 'listEntryPoints' | 'describe' | 'edgesFrom' | 'resolveEntity' | 'getFieldValue' | 'getRelated'
  | 'iterateRelatedPage' | 'preprocessInbound' | 'listEventTypes' | 'createRecord' | 'updateRecord'
  | 'deleteRecord' | 'linkRecords' | 'unlinkRecords' | 'ensureEventSubscription' | 'removeEventSubscription'
  | 'resolveAwait' | 'wakeKeys' | 'readRecord' | 'translateFilter' | 'getDedupRules'
  | 'getActorCandidates' | 'extractActor' | 'describeOpaqueId' | 'invokeFieldFunction';

request: { segmentId: string; instance: string; method: AdapterMethod; args: object }
answer:
  | { result: unknown }
  | { error: HostCallError & { kind: 'call_ceiling' | 'adapter_error' } }
```

- **`args` and `result`** are the adapter protocol's `params` and `result` for the method (`packages/engine-contracts/protocol.ts`, `METHODS`; prose in [`adapter-protocol.md`](adapter-protocol.md)). Three spellings are this boundary's own:
  - `describe` takes `{ typeId: string }`; a method with no input takes `{}`.
  - `iterateRelatedPage` takes the `getRelated` input plus `cursor?: unknown` (absent on the first page, then the last page's `nextCursor`), and answers `{ items: RelatedResult[]; nextCursor?: unknown }` (absent `nextCursor`: the last page). An instance that only streams is drained into one page.
  - `removeEventSubscription` answers `null`.
- **Not callable here:** `manifest` (`adapters.resolve` answers it as data), `iterateRelated` (an async iteration never crosses; the engine pages), and `resolveFileRef` (its answer is a byte stream; bytes stay on the host, which redeems a descriptor itself).
- **Why the result is wrapped.** A record-shaped result (a `readRecord`'s field values) can carry its own `error` field, so the answer is `{ result }` or `{ error }`, never a bare result.
- **Errors as data:**
  - `call_ceiling`: the segment has made as many third-party calls as one segment may. The engine fails the run with the message (named `AdapterCallCeilingExceeded`), and a collection op's `onError` never forgives it.
  - `adapter_error`: the adapter failed, or the instance does not implement the method, or the segment is not open (the message names it). The engine fails the statement with the message, under the failure's own `name`, with `detail` on the error it raises. The host logs the original failure (class, stack, cause) at warn with the segment and run ids as it classifies it.
  - An adapter call carries no budget, so it is never refused as `budget`; its own priced work is charged as the segment closes.
- **Persist:** nothing; the host runs the call inside the segment's read memo and ceiling.
- **Retry:** reads (`describe`, `getFieldValue`, `getRelated`, `iterateRelatedPage`, `readRecord`, `resolveEntity`, `resolveAwait`, …) are idempotent. Writes are not: a host retries a write only where the adapter protocol says the method is idempotent.

### `llm.client`

The extraction keyword's and `AI()`'s model call.

#### `llm.client.call`

```ts
request: Priced<{
  segmentId: string;
  system: string;
  userMessage: string;
  label: string;          // the call's purpose, for logs and billing
  model: string;          // a tier alias or a logical model name
  effort?: string;        // one of movement-lang's AI_EFFORTS; absent: the model's default
  maxTokens?: number;
}>
answer: PricedAnswer<{
  parsedJson: unknown;    // the JSON body the engine's prompt asked for
  rawText?: string;       // the reply before repair; kept only on an anomaly
  effortSteppedDown?: { from: string; to: string };
  continuations?: number;
}>
```

- The engine checks `control.cancel.cancelled` before each call; a cancel stops the run there.
- **Persist:** usage rows against the run (production bills each call to the run it names).
- **Retry:** the host's own; the engine never retries. Transient provider errors are retried inside the host.

### `llm.extractCall`

The extraction call's model call (`extract(content, Shape)`), which sends its prompt as blocks with cache breakpoints.

#### `llm.extractCall.call`

```ts
request: Priced<{
  segmentId: string;
  system: string;
  blocks: Array<{ text: string; cacheBreakpoint?: true }>;
  label: string;
  model: string;
  effort?: string;
  maxTokens?: number;
}>
answer: PricedAnswer<{
  parsedJson: unknown;
  rawText?: string;
  effortSteppedDown?: { from: string; to: string };
  continuations?: number;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
}>
```

- Same cancel, persistence and retry rules as `llm.client.call`.

### `llm.transforms`

`through` stages and plugin calls. What the engine knows of a plugin comes from the snapshot; invoking it is the host's.

#### `llm.transforms.invoke`

```ts
request: Priced<{
  segmentId: string;
  plugin: string;                              // as registered (dashes allowed)
  config: Record<string, unknown>;             // the author's named arguments, resolved
  extractedContext: Record<string, unknown>;   // the entity's extracted fields so far
}>
answer: PricedAnswer<{
  text?: string;
  data?: Record<string, unknown>;
  records?: Array<Record<string, unknown>>;    // each thing fetched; a stored document is a FileRef under `file`
  outcome?: string;                            // what became of the invocation, for the trace only
}>
```

- The engine refuses a plugin the snapshot marks `priced` before it starts once the run's cap is spent, without calling the host.
- **Persist:** whatever the plugin stores (fetched documents go to the document store and come back as descriptors).
- **Retry:** the plugin's own.

### `llm`

#### `llm.arbitrateEntities`

The judge for identity matches the engine's own rules cannot settle (`unique by` with candidates the exactness rules leave ambiguous, or a lone fuzzy hit).

```ts
request: Priced<{
  segmentId: string;
  asserted: Record<string, unknown>;     // the write's identity fields
  candidates: Array<{ adapterType: string; externalId: string; recordType?: string; url?: string; data: Record<string, unknown> }>;
  recordType: string;
  constraints: unknown;                  // the held uniqueness constraints (translation_graph/uniqueness)
  languageVersion: LanguageVersion;
}>
answer: PricedAnswer<{
  index: number | null;                  // the candidate the write IS, or null to create
  judgeUnavailable?: string;             // the judge's failure message, when it could not be asked
}>
```

- `judgeUnavailable` is author-facing: the write notes "judge unavailable: <message>; created rather than merged". A host that could not ask answers `{ index: null, judgeUnavailable }`, never a throw.
- **Persist:** usage rows. **Retry:** the host's own.

### `park.sink`

Where a parked flow's state goes, to be persisted and woken later. Every method here is the durable substrate's; an embedder without one leaves the whole family out, and a run that reaches a park fails ("needs the durable trigger-run substrate").

`address` is a flow's lexical address (`s0.b1.s0`); a frame's address is a prefix of its children's. `state` is a `ParkedScopeState`. Every request names its segment; the park belongs to the segment's run.

#### `park.sink.recordJoin`

```ts
request: { segmentId: string; frameAddress: string; parkedChildren: number }
answer:  void
```

- A join frame (a `parallel`, a fan-out, a race) is pending until its parked children resolve. A race records `1` however many arms parked (first wins).
- **Persist:** the frame's pending count.
- **Retry:** idempotent on (run, `frameAddress`): a re-run that reaches the same frame overwrites the count with the same value.

#### `park.sink.commitTimerPark`

```ts
request: { segmentId: string; address: string; state: ParkedScopeState; wakeAt: string }   // wakeAt: ISO 8601
answer:  void
```

- **Persist:** a timer park for (run, `address`) and the run marked parked. The host wakes it at `wakeAt` by resuming the run with `state` (not re-entering: the resume steps past the sleep).
- **Retry:** idempotent on (run, `address`).

#### `park.sink.commitAwaitPark`

```ts
request: { segmentId: string; address: string; state: ParkedScopeState; adapterType: string; correlationKey: string }
answer:  void
```

- `adapterType` is the awaitable adapter's type, or the reserved callback identity.
- **Persist:** an await park for (run, `address`), and the correlation from (`adapterType`, `correlationKey`) to it. A wake on the key resumes the run re-entering the await, which re-checks live.
- After this answers, the engine re-checks the await once itself and calls `park.wake` when it already resolved.
- **Retry:** idempotent on (run, `address`).

#### `park.sink.decrementJoin`

```ts
request: { segmentId: string; frameAddress: string; branchAddress: string; leafAddress: string }
answer:  { closed: boolean }
```

- Called as a resumed branch completes. `closed` is true for exactly one branch: the one that closes the frame and runs what follows the join.
- **Persist:** the decrement, claimed per `branchAddress` (each branch decrements at most once, even when re-scanned after a crash), and the closer's `leafAddress`.
- **Retry:** idempotent per `branchAddress`; a repeat answers the same `closed`.

#### `park.sink.persistBranchExport`

```ts
request: { segmentId: string; frameAddress: string; branchAddress: string; branchIndex: number; exports: unknown }
answer:  void
```

- A completed branch's values for the code after the join (a `parallel`'s slot), persisted before its decrement.
- **Persist:** `exports` for (run, `frameAddress`, `branchAddress`). **Retry:** idempotent (an upsert).

#### `park.sink.collectBranchExports`

```ts
request: { segmentId: string; frameAddress: string }
answer:  Array<{ branchAddress: string; branchIndex: number; exports: unknown }>   // ordered by branchIndex
```

- Read by the branch that closed the frame. **Persist:** nothing. **Retry:** idempotent.

#### `park.sink.cancelSubtrees`

```ts
request: { segmentId: string; subtreeAddresses: string[]; excludeLeaf?: string }
answer:  void
```

- The race cascade: once an arm wins, every park at or below each prefix (except `excludeLeaf`) is withdrawn: its await correlation dropped (a late resolution lands as data), its park deleted, and any join frame inside the subtree cleared.
- **Retry:** idempotent (a repeat finds nothing).

#### `park.sink.commitSuspension`

```ts
request: { segmentId: string; address: string; state: ParkedScopeState }
answer:  void
```

- An engine-initiated suspension: a flow that met the run's cost cap, or reached a `suspendAt` address. The resume re-enters at the statement and replays the calls it had finished. No correlation, no wake time: resuming the run resumes it.
- Optional within the family: a sink without it cannot suspend, so a run that meets its cap there fails on the cap instead.
- **Persist:** the suspension for (run, `address`). **Retry:** idempotent on (run, `address`).

#### `park.sink.commitLimitPause`

```ts
request: { segmentId: string; limit: 'cost'; capMicrodollars: number; spentMicrodollars: number }
answer:  void
```

- The run has met a limit and is pausing. Called once, by the first flow to meet it, before any flow's `commitSuspension`.
- Optional within the family, like `commitSuspension`.
- **Persist:** the run marked paused, with the limit, what it spent and the cap. Production also emits the `Run Paused` system event.
- **Retry:** idempotent.

### `park`

#### `park.wake`

```ts
request: { segmentId: string; adapterType: string; correlationKey: string }
answer:  void
```

- "Resume whatever is parked on this key", in the segment's team. After an await park is durable, the engine asks the await's question once more itself, its WHERE included. A landing that arrived between the first check and the park woke nothing, because a wake for a key with no parked run does nothing. So when the second check finds the await resolved (or cannot tell), the engine asks for the wake.
- When the second check cannot answer (the remote is down), the engine logs an error naming the key and leaves the run parked without a wake; the adapter's own at-least-once wake covers later landings. The known gap: a landing whose only wake arrived before the park, on a re-check that then failed.
- **Persist:** a queued wake that outlives the process (production: a `wake_await` work row).
- **Retry:** idempotent; a duplicate wake resumes nothing twice. A wake that cannot be queued throws; the engine logs it and the park stands.

### `park.callbacks`

Minting `callback(…)` and reading its call ledger. Separate from `park.sink` on purpose: a park is a leaf the run is waiting on, a callback is not one. An `await cb-[:Called]->` parks through `park.sink.commitAwaitPark` like any await.

#### `park.callbacks.mint`

```ts
request: {
  segmentId: string;
  address: string;
  params: Array<{ name: string; type: 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'file' }>;
  state: ParkedScopeState;      // the captured continuation
  singleUse: boolean;
  expiresAt?: string;           // ISO 8601; absent: never
}
answer: { id: string; url: string }
```

- **Persist:** the callback (continuation, signature, expiry) under `id`; `url` is where it is fired.
- **Retry:** not idempotent: each call mints a new callback.

#### `park.callbacks.calls`

```ts
request: { segmentId: string; callbackId: string }
answer:  Array<{ at: string; values: Record<string, unknown> }>   // at: ISO 8601, the landing's `At`
```

- The live ledger: what `cb-[:Called]->` reads and what a re-entered `await cb-[:Called]->` re-checks.
- A call is in the answer once its body has started. Production runs a call's body under the run's lease and marks it started first, so a segment holding the lease never sees a call whose body has yet to run.
- **Persist:** nothing. **Retry:** idempotent.

### `park.bindings`

The symmetric correspondence store a `write … bind other { … }` keeps: "this record IS the counterpart of that one", in the segment's team. The engine skips every binding write on a dry run.

```ts
interface BindingEndpoint {
  adapterType: string;                          // any casing; the store normalises it
  credentialId?: string;                        // absent for construction-free instances and the KG
  constructionConfig?: Record<string, unknown>; // the instance's construction args, raw
  typeId: string;                               // the stable internal type id
  recordId: string;                             // the stable external record id
}
interface EncodedEndpoint { adapterType: string; instanceKey: string; typeId: string; recordId: string }
```

#### `park.bindings.record`

```ts
request: { segmentId: string; from: BindingEndpoint; to: BindingEndpoint }
answer:  void
```

- **Persist:** the binding, both directions. **Retry:** idempotent (re-asserting a binding is a no-op).

#### `park.bindings.findBoundCounterpart`

```ts
request: { segmentId: string; endpoint: BindingEndpoint; counterpart?: Omit<BindingEndpoint, 'recordId'> }
answer:  EncodedEndpoint | null
```

- The record bound to `endpoint`, restricted to `counterpart`'s instance and type when given; the most recently bound when there are several. **Retry:** idempotent.

#### `park.bindings.delete`

```ts
request: { segmentId: string; from: BindingEndpoint | EncodedEndpoint; to: BindingEndpoint | EncodedEndpoint }
answer:  void
```

- The self-heal: the bound record was deleted in its system, so the stale binding goes before a fresh record is created and bound. **Retry:** idempotent.

### `control.cancel`

The cooperative cancel gate. A user's cancel stops the run at the next statement boundary, and at the boundaries inside a statement too (every model call and plugin invocation of an extraction), never mid-write.

#### `control.cancel.cancelled`

```ts
request: { segmentId: string }
answer:  boolean
```

- Checked at every boundary, so a host debounces it (production: one read per three seconds, latched once true). Fail open: a read fault answers `false`.

#### `control.cancel.cancelledNow`

```ts
request: { segmentId: string }
answer:  boolean
```

- The same check without the debounce, for the run's final boundary, where a stale "no" would discard a cancel forever.
- The reason a run was cancelled is the host's to report; it never crosses.

### `files`

A file crosses as its descriptor (`FileRef`), never its bytes, and the descriptor stays on the host. The engine holds an opaque handle with the file's `name`, `contentType` and `size`: it hands a file to `files.resolveFileText` and gets text back, gets one back from `files.render`, and passes files through write fields, and the host is handed the descriptor for each. Every byte read is on the host, through a document the run's tenant owns or an adapter instance the tenant holds; any other is refused by name (`FileOutsideTeamError`). A parked run holds its files where the park format says one is (park-state), and the host makes each a file again on resume.

A descriptor is only ever data; the envelope that carries it is what makes it a file, and the engine marks the file it makes there (`fileValue`, `engine-contracts`). The envelopes: an adapter's `getFieldValue` answer at a field the catalog snapshot types `file` (or a list, dict, tuple or maybe-absent of them); a resource's `fileRef` slot; a field a plugin's declared output types `file`; `files.render`'s answer; a parked `file` (park-state). The same descriptor anywhere else — a webhook body's field, an answer at a `json` field, a knowledge-graph property — is data, whatever keys it carries, `__brand: "FileRef"` included. `__brand` stays the descriptor's spelling, read by nobody. The handle is opaque to the engine: the Rust engine holds a file as an opaque handle — on the eval wire `["F", id, { handle, name, contentType, size }]` from the shim, `["F", id]` back — while the shim keeps the descriptor in the segment's file table. The engine compares and carries `handle` (a FILE resource's `externalId`, a `file` provenance origin, the dedupe key) and never parses or reads inside it; a file's source — its credential, construction args, store, URL — never reaches it. The shim makes every file the envelope declares: an answer at a field whose declared type the engine names on the read (`filesAt`), a plugin output's declared files, `files.render`'s answer, and a resumed park's files. The TypeScript engine, being retired, keeps the descriptor on its file value; the two behave alike. On both engines a file reads and prints as its opaque view — `name`, `contentType`, `size` and `handle` — and nothing else: a read of `source`, `url` or any other descriptor member is absent, and a file written into text (JSON, a prompt, a trace's sample, `TEXT.PAIRS`) is that view. The host is handed the plain descriptor for `files.resolveFileText`. A URL handle's owner fetches only a URL its configuration says it issued (email: its provider's storage — Mailgun's attachment URL, Resend's handle; WhatsApp: the configured Twilio account's media, or a URL this deployment exposed for the Meta door's media); any other is refused by name, and WhatsApp with no `TWILIO_ACCOUNT_SID` issues no Twilio media.

#### `files.resolveFileText`

```ts
request: Priced<{ segmentId: string; file: FileRef }>
answer:  PricedAnswer<
  | { text: string; rawTextId?: string }
  | { unreadable: 'unsupported_type' | 'bytes_unavailable' | 'extraction_failed' | 'no_text'; detail?: string }
>
```

- **Only the run's team's bytes.** Bytes are read only (a) from a stored document the team owns — on the store's own reading of the key (`keyOf`: exactly its bucket, no empty, `.` or `..` segment), a key under the team's prefix (`movement-files/<teamId>/`, where `FILE()` artifacts and a manual run's files are stored) or the team's `knowledge.document` row — or (b) through an adapter instance the run's segment holds for the descriptor's adapter type (matched by its credential and construction args where the descriptor names them), never one the descriptor would build. A manual file's handle is a stored document, read by (a). Anything else — another team's document, an adapter type the run holds no instance of, a URL no held instance owns — is refused by name: the host throws `FileOutsideTeamError` (`code: 'FILE_OUTSIDE_TEAM'`, `engine/files/file_outside_team.ts`), never an `unreadable` answer, so the run fails naming the file. A target's upload of a file, inside an adapter call, redeems it the same way.
- Transcription and OCR are model calls, so the call is priced.
- The byte reads happen outside any segment: they are not counted against a segment's call ceiling and not kept in its read memo.
- **Persist:** the text (production: the team's `raw_text` table, whose id comes back as `rawTextId`; a test run stores nothing durable). **Retry:** idempotent.

#### `files.render`

```ts
request: { segmentId: string; content: string; type: 'pdf' | 'text' }
answer:  FileRef            // a document-store descriptor
```

- `FILE(content, type)`: the host renders the composed string, stores the artifact under the team's key prefix (what makes it the team's to read again), and answers its descriptor.
- **Persist:** the artifact's bytes in the document store. **Retry:** not idempotent (each call stores a new artifact).

### `lookup`

#### `lookup.resolveActingUser`

```ts
request: {
  segmentId: string;
  triggerId?: string;      // the trigger the event dispatched through; absent for events that predate trigger-aware dispatch
  instance: string;        // the source instance, as adapters.resolve answered it
  event: TriggerEvent;
}
answer: { principal: PrincipalReference; email?: string } | null
```

- The principal an event acts as (`@user_*`), in the segment's team. The host maps the event's actor to one of its own principals through the trigger (its creator override and creator fallback), asking the source instance for the event's actor candidates itself (`getActorCandidates`, inside the segment) only when the trigger does not already decide it. `null`: no principal matches.
- `principal.id` is opaque: the engine carries it (`@user_id`) and never looks it up. `principal.display` is how a person would see it named (`@user_name`); absent, `@user_name` reads as absent.
- `email` is supplied only by a host whose principals have one (this repository's production host does; the test host passes the email a test's user carries). Absent, `@user_email` reads as absent, exactly as it does when no principal matches. The engine never sees a user table.
- The engine asks only through a source the host resolved; an adapter the engine implements itself has no instance to ask, and the engine refuses (`MOVENG_UNSUPPORTED`) rather than answer null.
- A throw is forgiven: the engine reads `@user_*` as absent.
- **Persist:** nothing. **Retry:** idempotent; the engine caches the answer for the run.

### `locks`

Cross-run write locks. A token stands for one acquire.

#### `locks.acquire`

```ts
request: { segmentId: string; names: string[] }
answer:  { token: string }
```

- All or nothing: a failing acquire gives back what it took. A name another holder has is waited for, up to the host's timeout; then the acquire throws `write lock timeout: <name>`.
- The host opens the segment's lock session at its first acquire (scoped to the team `segment.open` named) and closes it with the segment.
- **Persist:** nothing durable (production: advisory locks on a connection per segment). **Retry:** not idempotent; each call answers a new token.

#### `locks.release`

```ts
request: { segmentId: string; token: string }
answer:  void
```

- Gives back exactly what that acquire took. A token released twice, or never acquired, throws.

### `trace`

#### `trace.append`

```ts
request: { segmentId: string; entries: MovementTraceEntry[] }
answer:  void
```

- The run's decision trace as it goes, so a caller can publish it before the run settles. The engine appends each run-level statement's new entries once the statement is done (never from inside a flow), and the rest as the segment ends. The whole trace is on the run's result either way, and what was appended equals it.
- **Persist:** the caller's choice (production: the live run view). **Retry:** not idempotent; entries are appended in order, exactly once each.

### `clock`

The engine reads no clock of its own. Every instant it needs that is not the run's firing instant comes from here: a sleep's wake time and an `every` timer's, a callback's expiry, the pin of a segment handed no `firedAt`, the instant a `WITHIN` measures recency from (one `clock.now` request per row the `WITHIN` is evaluated on: a hop filter holding one, over N rows, asks N times), and every measured duration on the trace (a plugin invocation's, a model call's).

#### `clock.now`

```ts
request: { segmentId: string }
answer:  { nowIso: string }   // ISO 8601
```

- The engine adds a sleep's duration to the answer for `commitTimerPark`'s `wakeAt`, and a callback's `ttl` for `mint`'s `expiresAt`.
- A measured duration is the difference of two answers, so each costs two `clock.now` requests: one before the plugin invocation or model call it measures, one after.
- A host may answer one instant for the whole segment (the test host answers the instant the segment opened at), or the wall clock (production). The engine refuses an answer that names no instant.
- **Persist:** nothing. **Retry:** idempotent.

### `ids`

The engine mints no id of its own. An extraction stamps each source and fetched file it carries as a resource with an id from here.

#### `ids.mint`

```ts
request: { segmentId: string; count: number }   // count ≥ 1
answer:  string[]                                // exactly count distinct, non-empty ids
```

- An id is unique within the segment's team; production answers UUIDs (a stored resource's id is a UUID), the test host `id-1`, `id-2`, … in the order asked.
- The engine asks once per batch, never with `count` 0, and refuses an answer that is not `count` distinct strings.
- **Persist:** nothing. **Retry:** not idempotent: each call mints fresh ids.

## Spend

The engine keeps the run's ledger (`movement_engine/run_context.ts`). The budget it sends with each priced call is the run's cap less what it has spent against it (`null` with no cap), and every answer's `cost` is charged. A host refuses priced work past the budget by answering a `BudgetRefusal` carrying what the call spent first; the engine charges that, raises the run's cap (`RunCostCapExceeded`) from its own figures, and suspends the run there (`park.sink.commitLimitPause`, then `commitSuspension`).

## The Rust engine's requests

The Rust engine (`crates/movement-engine`, behind `MOVEMENT_ENGINE=rust`) is an engine, not a host: it runs a segment the run host opened (`inRunContext` in `movement_engine/run.ts`), and its shim (`movement_engine/rust_host.ts`) forwards each request it makes to the run's `EngineHost`. Every request that names an `EngineHost` method is that method's request, in the shape above, with the segment's id; the engine's slice reaches `segment` only through the run host, and `adapters.resolve`, `adapters.call`, `llm.client.call`, `llm.extractCall.call` (an extraction call, `extract(…)`, `extractOne(…)`), `llm.transforms.invoke`, `llm.arbitrateEntities`, `files.resolveFileText`, `files.render`, `lookup.resolveActingUser`, `park.sink.*` (a timer, a suspension, an await's park under its correlation key, a limit pause, and a combinator's join: `recordJoin`, `persistBranchExport`, `decrementJoin`, `collectBranchExports`, `cancelSubtrees`), `park.wake` (a callback fired from inside the run), `park.callbacks.mint` and `park.callbacks.calls`, `control.cancel.*`, `locks.*`, `trace.append`, `clock.now` and `ids.mint` itself. It asks `ids.mint` for an extraction's resources (once per batch, in the tree's order); a callback's id is minted by `park.callbacks.mint`, as the TypeScript engine's is. An await of a landing asks the awaited adapter's `resolveAwait` through `adapters.call`. `parallel` and `race` arms run as concurrent flows: their requests are in flight together, interleaved as the TypeScript engine's arms interleave them, and effects take the run's in-run locks in the same order.

- **What it admits.** The engine decides what it runs on its own parse of the program, before it asks for the check or touches anything; a program or a parked state it does not run is refused with a stable reason (`crates/movement-engine/README.md`, "Admission"), and the TypeScript engine runs it. A refused run has made no host call.
- **The values on the eval wire.** In process, the shim hands the host the very JavaScript values the TypeScript engine would (key order, `undefined`), so `adapters.call`'s `args` and `result`, a park's `state`, a plugin's `config` and `extractedContext`, a file's descriptor, and the answers of `llm.client.call`, `llm.transforms.invoke` and `files.resolveFileText` cross between the engine and its shim on the eval wire (`wire: true`; `crates/movement-engine/src/env.rs`) and reach the host as plain objects. A value on the eval wire is data or one of the engine's records, and the two never share a form: every object the host sends is data, whatever keys it carries (a `kind` naming an engine binding's included); a record whose binding object is data (the event, a callback) reaches the host as `["x", id, descriptor]`, the host hands it back as `["x", id]`, and no other record crosses. A model reply's `parsedJson` therefore reaches the engine as `JSON.parse` left it — its key order, and a number past the double range as `Infinity`, which the engine's validator refuses as zod does. A remote host serves the JSON shapes above, where such a number is already `null`.
- **Positions by handle.** Between the engine and its shim, an `adapters.call` whose argument object leads with a `position` (`getFieldValue`, `getRelated`, `iterateRelatedPage`) names it by `positionRef`, a number per position object of the segment, and carries the position itself (`position`) only the first time. The shim keeps the segment's positions and hands the host `{ position, ...args }`, the very object it registered, so the host sees the method's request in the shape above. A remote host of the Rust engine keeps the same table (`crates/movement-engine/README.md`, "Positions by handle"). The table lives exactly as long as the segment: it starts empty when the segment opens, is dropped when it closes, and is never written into a park; a resumed run's segment numbers its positions from 0 again.
- **A traversal an expression reads.** A walk a fold, an `EXISTS` or a field read off hops makes (`COUNT(crm-[c:companies]->)`) asks one `adapters.call` `getRelated` per origin record and hop, even of an instance that streams, as the TypeScript engine's expression walk does; a pick (`x = FIRST(…)`) walks as a block head does, `iterateRelatedPage` by page for an instance that streams. An `EXISTS` asks every hop of every subject before it reads its WHERE. A walk down what an extraction yielded, and an `IS` test, ask nothing.
- **An extraction's requests.** Per through-free region of the tree: the cancel gate, `clock.now`, `llm.client.call`, `clock.now`; a plugin of a `through` stage is one `llm.transforms.invoke` with `clock.now` either side; a source file is one `files.resolveFileText`; the resources without ids are given them in one `ids.mint` (the `from` text, source files and the bundle's files), and every record's fetched files in a second, in the tree's order. Branches the TypeScript engine runs side by side are in flight together, at most four at a time. The engine never validates a reply on the host: an unreadable one is asked again once with the issues named. A plain plugin call outside an extraction is one `llm.transforms.invoke` between two `clock.now`.
- **Inputs only the Rust engine takes.** The shim reads each from its own process or deployment, so the engine reads no environment:
  - `localZone`: the IANA zone a date-time text with no offset of its own is read in (`new Date("2026-03-12T09:30")`, `Date.parse("March 12, 2026")`, an offset-less `firedAt`), the zone the TypeScript engine's `Date` reads such a text in. The shim takes `Intl`'s resolved zone and sends it only when `Date`'s wall clock agrees with it at a winter, a summer, a historic and a far-future instant; a zone `Intl` names none of (`TZ=utc`, `TZ=""`) is tried as `UTC`, and sent as that when `Date`'s clock agrees; under a `TZ` whose zone cannot be verified so (`GMT+3`, `UTC+3`) the run, or the expression, is left to the TypeScript engine (`local_zone_unverified`). Optional; UTC when absent; a zone the engine's zone database does not know declines the segment (`local_zone_does_not_read`).
  - `extractionFileChars`: how much of one source file's text an extraction prompt takes (extraction.ts `maxFileChars`, 50,000 when absent), the deployment's `EXTRACTION_FILE_CHARS` as written, a fraction included.
  - `maxCallDepth`: how many named calls deep one run may nest from version 3 (call_depth.ts `maxCallDepth`), the deployment's `MOVEMENT_MAX_CALL_DEPTH`.
  - `extractionTiers`: what the deployment buys for each extraction tier (`extract "careful" from …`), the deployment's `EXTRACTION_TIERS` parsed (ai_tiers.ts `extractionTierAssignments`): an object from a tier (`quick`, `careful`, `thorough`) to `{ model?, effort? }`, each member over the built-in row's (sonnet at `low`, `high`, `xhigh`). Optional; absent, or a tier it does not name, is the built-in table; the language version stays as it is (a tier's settings are the platform's, not the program's).

  The engine also reads the catalog snapshot's `plugins` before admission, to decide what a plugin's plain call binds (its declared output under the movement's pin) without a host call.
- **The trace, a statement at a time.** `trace.append` carries every entry one statement traced, at any depth, in one request, and once more as the segment ends for what a park or a failure left; the run's trace is the same entries in the same order as the TypeScript engine's.
- **The budget is the engine's.** The engine keeps the run's account for its segment, sends the budget with each priced call (the judge's, `llm.arbitrateEntities`, among them) and charges the cost each answers; the segment's charges reach the run's account as the segment ends. The engine refuses a priced plugin itself, before `llm.transforms.invoke`, once the run's own figures meet the cap (as `pricedCalls` in `run_context.ts` does); every other priced call is refused by the host only: a budget refusal that takes the run's own figures to its cap suspends the run at the next refused paid call, just before its statement, as the TypeScript engine does (`commitLimitPause`, then `commitSuspension`), and a run entered with `limitPaused` or `suspendAt` suspends where the TypeScript engine would.
- **What the host serves.** The shim hands the engine the methods the host serves (`servedHostMethods`, the list a recording names), and the engine asks an optional `park.sink` method only of a host that serves it: a host that cannot suspend (no `commitSuspension`, where the TypeScript engine's `canSuspend` is false) or park a timer is asked nothing, so the run makes the TypeScript engine's requests and no other.
- **The clock is the host's.** Every clock read a program makes (`DATE.TODAY`, a write's mutation context) answers from the run's pinned instant (`now` in the segment's input): `firedAt`, or, handed none, the run host's `clock.now` as the segment opened. Every other instant is a `clock.now` the engine asks where the TypeScript engine asks it: a sleep's wake (the answer plus the sleep) and the instant a `WITHIN` measures from (once per comparison in an expression, once per conjunct of a filter that reaches one, once per record of a `unique by` narrowing that reaches one). The engine reads no clock of its own.

Five requests are the Rust engine's own: they are not `EngineHost` methods, and no embedder serves them. The shim answers them in process, and a test holds every request it routes to the manifest above or to this list (`ENGINE_OWN_ROUTES`):

| request | answer | why it is not on the host |
|---|---|---|
| `check.program { source, languageVersion, upgradingFrom? }` | `{ diagnostics, link?, stamps, versionWarning? }`, the checker's AST stamps by path, and `versionWarning: { code, message }` for a deprecated pin as the host's engine reads its release (the warning the run traces); a program that fails its check gets no answer, and the run fails with `MOVENG_CHECK` (or `MOVENG_PARSE`, `MOVENG_LANGUAGE_VERSION`) as the TypeScript engine's does. It names no segment: the in-process run host checks before it opens the segment, as the TypeScript route does, and answers the request from that check, so a program that fails it makes no host request on either engine | the checker is TypeScript until it is ported |
| `check.compatible { source, languageVersion, declaration, schema, recordType }` | `{ fits }`, whether the instance schema's `recordType` carries everything the file's node declaration `declaration` declares (its `extends` folded in), by the checker's comparator (`surfaceMisfit`); `{ undescribed: true }` when the schema enumerates nothing at that type | an `IS <Decl>` test of a record a system describes (the event, a handle, a landed record): the verdict is the checker's assignability over its field types, which stays TypeScript with the checker |
| `builtins.function { id, args, now, languageVersion }` | `{ value }` or `{ threw: { class, code?, message } }`, values on the eval wire | a standard-library reading the Rust engine does not reproduce (a regex nested past 1,000 groups, astral text split into UTF-16 halves), answered by the TypeScript member |
| `builtins.compare { op, left, right, now? }` | the same two shapes, for the shared comparator; `now` is the `clock.now` answer a `WITHIN` measures from, carried on a `WITHIN` and only there | `WITHIN`, which reads the clock's answer, likewise |
| `log.write { lines }` | `undefined`; each line `{ level: 'info' \| 'warn', message, fields }` written to the platform's log, the run's id added; sent as a statement's trace is handed over | the log lines the TypeScript engine writes (an extraction stage skipped, a plugin's empty argument, a continued answer, a source file truncated for the prompt, a refinement kept) |

## Changes

- **Within version 1, the Rust engine's requests and inputs (chunk 7A).** None is an `EngineHost` method or a required member, so the version holds; an embedder of the Rust engine serves or sends each as "The Rust engine's requests" says:
  - **`localZone`** (input, optional): the zone an offset-less date-time text is read in; absent, UTC.
  - **`extractionTiers`** (input, optional): the deployment's tier table; absent, the built-in rows.
  - **`check.compatible`** (engine's own request): the checker's assignability, for `IS <Decl>` of a system's record.
  - **The files family's opaque handle:** the engine holds a file as an opaque handle with its `name`, `contentType`, `size` and `handle`, and the host is handed the plain descriptor (`files.resolveFileText`, write fields); a file is made only where an envelope declares one.
  - **`check.program` before the segment:** the in-process run host checks a program before it opens the segment and answers the engine's request from that check, so a program that fails it makes no host request.
- **Version 1 includes the clock and ids.** Two required families, `clock.now` and `ids.mint`, joined the manifest before version 1 was released, so they are part of it. The engine reads no wall clock and mints no random id: a sleep's wake, a callback's expiry, a segment's pin without `firedAt`, every measured duration and an extraction's resource ids come from the host, so a recorded run replays to the same values. A host without them is refused before `segment.open`, naming the missing methods.
- **Version 1** (the first version on the wire). Relative to the contract as chunk 4A left it:
  - **`segment.open`** carries `hostFamiliesVersion`, and a host refuses a version it does not serve.
  - **`lookup.resolveActingUser`** answers `{ principal: { id, display? }, email? }` in place of a team user `{ id, email, name? }`. The principal is an opaque reference; `email` comes only from a host that has one.
- Before the contract was versioned, its changes were logged per chunk:
  - **Since chunk 3:**
    - **`segment`:** new. `open({ runId?, teamId, languageVersion })` answers `{ segmentId }`; `close({ segmentId })` answers `{ cost? }`. The segment's read memo, call ceiling and pin are host state.
    - **`adapters`:** the engine holds no live adapter. `resolve` answers the instance as data and an opaque id; `call({ segmentId, instance, method, args })` answers `{ result }` or `{ error }`. `credentialId` is gone (credential ids are run input). `resolveFileRef` is not callable (bytes stay on the host).
    - **Adapter failures:** an `adapter_error` carries the failure's `name` and `detail` (`{ status?, code? }`); adapter calls are never refused as `budget`.
    - **Priced calls:** every `llm.*` call and `files.resolveFileText` takes `budget` and answers `cost?`, or a `budget` refusal as data. Nothing priced throws `BudgetExhausted` across the boundary.
    - **`llm.transforms`:** `invoke` is the one call; a plugin's arguments, output and whether it is priced come from the snapshot.
    - **`llm.arbitrateEntities`:** answers `{ index, judgeUnavailable? }`; the `onJudgeUnavailable` callback is gone.
    - **`park.sink`:** a timer's `wakeAt` is an ISO string. The await park and its wake carry no closure (the engine re-checks itself).
    - **`park.callbacks`:** `mint`'s `expiresAt` is an ISO string.
    - **`control`:** `suspendWhen` is gone (a run's `suspendAt` input replaces it); the cancel gate's `reason` is gone from the boundary (the host reports it).
    - **`files`:** `resolveFile` is gone (imports resolve from the snapshot); `resolveFileText` takes a descriptor and answers text; `render` answers a descriptor.
    - **`lookup`:** `resolveActingUser` names the source instance and the event; the host asks the source for candidates itself.
    - **`locks`:** `acquire({ segmentId, names })` answers `{ token }`; `release({ segmentId, token })`. No lock holder crosses.
    - **`trace`:** new. `append({ segmentId, entries })` as the run goes.
  - **In chunk 4A:**
    - **Every call names its segment.** `segmentId` joins every request of `park.sink`, `park.callbacks`, `park.wake`, `park.bindings`, `control.cancel`, `files`, `llm` and `locks.release`; `adapters`, `lookup`, `locks.acquire` and `trace` already carried it. `control.cancel.cancelled` and `cancelledNow` take `{ segmentId }`; `park.callbacks.calls` takes `{ segmentId, callbackId }` in place of the bare id.
    - **The team is the segment's.** `teamId` is gone from `adapters.resolve`, `park.wake`, `park.bindings.*` and `lookup.resolveActingUser`; the host answers each for the team `segment.open` named.
    - **An instance is its resolution.** `adapters.resolve` answers the same `instance` for the same (`adapterType`, `credentialsId`, `constructionArgs`, `dryRun`) within a segment, and refuses a segment that is not open.
    - **A call lands when its body starts.** `park.callbacks.calls` answers only the calls whose body has started.
