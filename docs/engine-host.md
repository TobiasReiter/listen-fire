# The engine host

The movement engine (`apps/api/src/services/movement_engine/`) runs a program. Everything outside the program goes through one interface the caller hands it, `EngineHost` (`movement_engine/host.ts`): adapters, model calls, parking, cancellation, files, user lookup, write locks and the trace. The engine imports none of these itself.

This document is the host contract, frozen as JSON. Every host call is one request and one awaited answer, each plain JSON: no callback, live object, `Date`, stream or shared array crosses, and instants are ISO 8601 strings. An embedder in another language or process serves exactly these shapes.

Two tests hold the contract to this document (`movement_engine/__test__/seam_guard.unit.test.ts`):

- **The import rules.** An engine file that starts importing host code fails.
- **The round trip.** Every method of every family is wrapped in a JSON round trip (each request and answer serialised and parsed, anything JSON cannot carry refused by path), and representative programs reach every method. The set of methods is the manifest `HOST_FAMILIES` (`host.ts`), which the compiler holds equal to `EngineHost`, and which the test holds equal to the method headings below.

## Conventions

The shapes are TypeScript-ish. These rules apply to every one of them.

- **Optional fields.** `x?: T` means the field may be absent. An absent field and one that is `undefined` are the same; a host never sends `null` for an absent optional field unless the type says `| null`.
- **`unknown`.** Any JSON value, opaque to the receiver: carried, never interpreted.
- **Numbers.** Finite. Money is integer microdollars.
- **Instants.** ISO 8601 strings with an offset (`2026-10-07T09:00:00.000Z`).
- **Answers.** Every method answers a promise. A method shown answering `void` answers nothing (JSON `null` over a wire).
- **Failure.** A method fails one of two ways.
  - **As data**, in the answer: only `adapters.call` (an `error` variant) and the priced calls (a `budget` refusal). The engine branches on these.
  - **By throwing** (over a wire: an error response carrying `message`). The engine never branches on a thrown failure's class. It fails the statement with the message, exactly as it fails one on its own error, so a remote host may throw a plain error with the same message.
- **Retries.** The engine never retries a host call. A host that retries does so inside the call, and only where this document says the call is idempotent.

## Shared shapes

```ts
type TeamId = string;            // a UUID
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
  actor?: unknown;
  snapshotRunId?: string;
  snapshotComplete?: boolean;
  recordId?: string;
  externalRecordRef?: unknown;
  rootRecordType?: string;
  changedFields?: string[];
  idempotencyKey?: string;
  occurredAt?: string;
}

// A parked flow's whole state (movement_engine/serialize.ts), opaque to the host
interface ParkedScopeState { version: 1; address: string; bindingName: string | null; scopeChain: unknown[]; /* … */ }
```

`ParkedScopeState` and `MovementTraceEntry` (`movement_engine/expression.ts`) are engine-defined JSON. A host stores them and hands them back byte for byte; it never reads inside them.

## What a run is given

- **Data.** The source and its language version, a `CatalogSnapshot`, the credential ids its imports name (`credentialIds`: import name to id, beside the snapshot, never in it), the trigger event, the instant it fired (`firedAt`, an ISO 8601 string; every clock read in the run answers from it), the cost cap (`costCapMicrodollars`, absent for none) with what the run spent before this segment, and, on resume, the parked state. A run may also be handed addresses to suspend at (`suspendAt`: just before a statement, or before the k-th call a statement makes); the first flow to reach one parks there once.
- **The catalog snapshot.** The team's catalog as plain JSON: adapters and their schemas, credential names, plugins, models, and the saved files the program imports (file imports resolve from the snapshot's `files` only). Everything the engine knows of a plugin comes from the snapshot's `plugins`: the arguments a stage feeds it (`fedArgs`), the ones it must be handed (`requiredArgs`), what a plain call hands back (`output`, `earlierOutputs`), and whether it is `priced`.
- **A host.** The families below.

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
| `park` | `wake` | no |
| `park.callbacks` | `mint`, `calls` | yes: absent, `callback(…)` fails as unsupported |
| `park.bindings` | `record`, `findBoundCounterpart`, `delete` | no (may throw, if no program binds) |
| `control.cancel` | `cancelled`, `cancelledNow` | no (answer `false` for a run nothing cancels) |
| `files` | `resolveFileText`, `render` | no |
| `lookup` | `resolveActingUser` | no (answer `null` when no user is known) |
| `locks` | `acquire`, `release` | no |
| `trace` | `append` | yes: absent, the trace is on the run's result only |

"No (may throw…)" means the family must be present, and a method of it may throw naming itself: the engine fails only a run that reaches it.

### `segment`

A segment is one entry into the interpreter: a fresh run, a resume, a race settlement, a callback body. The engine opens one at each entry point and closes it however the segment ends (completes, parks, throws). The host's half of a segment holds what the segment's adapter calls have read (a read memo, so a record read three times is one request), how many third-party calls they have made (the call ceiling: `AFFINITY_MAX_CALLS_PER_RUN`, default 2000), the pin they answer under, and the adapter instances and lock session it holds.

#### `segment.open`

```ts
request: { runId?: string; teamId: TeamId; languageVersion: LanguageVersion }
answer:  { segmentId: string }
```

- `runId` is absent for a test or a dry run with no run record.
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
  adapterType: string;
  teamId: TeamId;
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

- The same live instance answers to the same `instance` id within a segment; its rehearsal (`dryRun`) answers to a different one.
- `methods` lists the `adapters.call` methods the instance implements, plus `iterateRelated` when it streams a traversal (the engine walks the stream with `iterateRelatedPage`). An instance may stream, page, both or neither.
- **Rehearsal.** A `dryRun` instance captures each create, update, delete, link and unlink into the host's write sink instead of making it, and answers with ids it invents; its reads go to the live system. The rehearsal (the sink, the invented ids) belongs to the segment, because a write chained off a rehearsed parent routinely crosses systems.
- **Throws** when the adapter cannot be constructed (an unknown type, a credential it cannot load).
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

- **`args` and `result`** are the adapter protocol's `params` and `result` for the method (`translation_graph/protocol/schema.ts`, `METHODS`; prose in `docs/adapter-protocol.md`). Three spellings are this boundary's own:
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

`address` is a flow's lexical address (`s0.b1.s0`); a frame's address is a prefix of its children's. `state` is a `ParkedScopeState`.

#### `park.sink.recordJoin`

```ts
request: { frameAddress: string; parkedChildren: number }
answer:  void
```

- A join frame (a `parallel`, a fan-out, a race) is pending until its parked children resolve. A race records `1` however many arms parked (first wins).
- **Persist:** the frame's pending count.
- **Retry:** idempotent on (run, `frameAddress`): a re-run that reaches the same frame overwrites the count with the same value.

#### `park.sink.commitTimerPark`

```ts
request: { address: string; state: ParkedScopeState; wakeAt: string }   // wakeAt: ISO 8601
answer:  void
```

- **Persist:** a timer park for (run, `address`) and the run marked parked. The host wakes it at `wakeAt` by resuming the run with `state` (not re-entering: the resume steps past the sleep).
- **Retry:** idempotent on (run, `address`).

#### `park.sink.commitAwaitPark`

```ts
request: { address: string; state: ParkedScopeState; adapterType: string; correlationKey: string }
answer:  void
```

- `adapterType` is the awaitable adapter's type, or the reserved callback identity.
- **Persist:** an await park for (run, `address`), and the correlation from (`adapterType`, `correlationKey`) to it. A wake on the key resumes the run re-entering the await, which re-checks live.
- After this answers, the engine re-checks the await once itself and calls `park.wake` when it already resolved.
- **Retry:** idempotent on (run, `address`).

#### `park.sink.decrementJoin`

```ts
request: { frameAddress: string; branchAddress: string; leafAddress: string }
answer:  { closed: boolean }
```

- Called as a resumed branch completes. `closed` is true for exactly one branch: the one that closes the frame and runs what follows the join.
- **Persist:** the decrement, claimed per `branchAddress` (each branch decrements at most once, even when re-scanned after a crash), and the closer's `leafAddress`.
- **Retry:** idempotent per `branchAddress`; a repeat answers the same `closed`.

#### `park.sink.persistBranchExport`

```ts
request: { frameAddress: string; branchAddress: string; branchIndex: number; exports: unknown }
answer:  void
```

- A completed branch's values for the code after the join (a `parallel`'s slot), persisted before its decrement.
- **Persist:** `exports` for (run, `frameAddress`, `branchAddress`). **Retry:** idempotent (an upsert).

#### `park.sink.collectBranchExports`

```ts
request: { frameAddress: string }
answer:  Array<{ branchAddress: string; branchIndex: number; exports: unknown }>   // ordered by branchIndex
```

- Read by the branch that closed the frame. **Persist:** nothing. **Retry:** idempotent.

#### `park.sink.cancelSubtrees`

```ts
request: { subtreeAddresses: string[]; excludeLeaf?: string }
answer:  void
```

- The race cascade: once an arm wins, every park at or below each prefix (except `excludeLeaf`) is withdrawn: its await correlation dropped (a late resolution lands as data), its park deleted, and any join frame inside the subtree cleared.
- **Retry:** idempotent (a repeat finds nothing).

#### `park.sink.commitSuspension`

```ts
request: { address: string; state: ParkedScopeState }
answer:  void
```

- An engine-initiated suspension: a flow that met the run's cost cap, or reached a `suspendAt` address. The resume re-enters at the statement and replays the calls it had finished. No correlation, no wake time: resuming the run resumes it.
- Optional within the family: a sink without it cannot suspend, so a run that meets its cap there fails on the cap instead.
- **Persist:** the suspension for (run, `address`). **Retry:** idempotent on (run, `address`).

#### `park.sink.commitLimitPause`

```ts
request: { limit: 'cost'; capMicrodollars: number; spentMicrodollars: number }
answer:  void
```

- The run has met a limit and is pausing. Called once, by the first flow to meet it, before any flow's `commitSuspension`.
- Optional within the family, like `commitSuspension`.
- **Persist:** the run marked paused, with the limit, what it spent and the cap. Production also emits the `Run Paused` system event.
- **Retry:** idempotent.

### `park`

#### `park.wake`

```ts
request: { adapterType: string; teamId: TeamId; correlationKey: string }
answer:  void
```

- "Resume whatever is parked on this key." After an await park is durable, the engine asks the await's question once more itself, its WHERE included. A landing that arrived between the first check and the park woke nothing, because a wake for a key with no parked run does nothing. So when the second check finds the await resolved (or cannot tell), the engine asks for the wake.
- When the second check cannot answer (the remote is down), the engine logs an error naming the key and leaves the run parked without a wake; the adapter's own at-least-once wake covers later landings. The known gap: a landing whose only wake arrived before the park, on a re-check that then failed.
- **Persist:** a queued wake that outlives the process (production: a `wake_await` work row).
- **Retry:** idempotent; a duplicate wake resumes nothing twice. A wake that cannot be queued throws; the engine logs it and the park stands.

### `park.callbacks`

Minting `callback(…)` and reading its call ledger. Separate from `park.sink` on purpose: a park is a leaf the run is waiting on, a callback is not one. An `await cb-[:Called]->` parks through `park.sink.commitAwaitPark` like any await.

#### `park.callbacks.mint`

```ts
request: {
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
request: callbackId: string      // the method's one argument is the id itself, not an object
answer:  Array<{ at: string; values: Record<string, unknown> }>   // at: ISO 8601, the landing's `At`
```

- The live ledger: what `cb-[:Called]->` reads and what a re-entered `await cb-[:Called]->` re-checks.
- **Persist:** nothing. **Retry:** idempotent.

### `park.bindings`

The symmetric correspondence store a `write … bind other { … }` keeps: "this record IS the counterpart of that one". The engine skips every binding write on a dry run.

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
request: { teamId: TeamId; from: BindingEndpoint; to: BindingEndpoint }
answer:  void
```

- **Persist:** the binding, both directions. **Retry:** idempotent (re-asserting a binding is a no-op).

#### `park.bindings.findBoundCounterpart`

```ts
request: { teamId: TeamId; endpoint: BindingEndpoint; counterpart?: Omit<BindingEndpoint, 'recordId'> }
answer:  EncodedEndpoint | null
```

- The record bound to `endpoint`, restricted to `counterpart`'s instance and type when given; the most recently bound when there are several. **Retry:** idempotent.

#### `park.bindings.delete`

```ts
request: { teamId: TeamId; from: BindingEndpoint | EncodedEndpoint; to: BindingEndpoint | EncodedEndpoint }
answer:  void
```

- The self-heal: the bound record was deleted in its system, so the stale binding goes before a fresh record is created and bound. **Retry:** idempotent.

### `control.cancel`

The cooperative cancel gate. A user's cancel stops the run at the next statement boundary, and at the boundaries inside a statement too (every model call and plugin invocation of an extraction), never mid-write.

#### `control.cancel.cancelled`

```ts
request: (no argument)
answer:  boolean
```

- Checked at every boundary, so a host debounces it (production: one read per three seconds, latched once true). Fail open: a read fault answers `false`.

#### `control.cancel.cancelledNow`

```ts
request: (no argument)
answer:  boolean
```

- The same check without the debounce, for the run's final boundary, where a stale "no" would discard a cancel forever.
- The reason a run was cancelled is the host's to report; it never crosses.

### `files`

A file crosses as its descriptor (`FileRef`), never its bytes. The engine carries descriptors: it hands them to `files.resolveFileText` and gets text back, gets one back from `files.render`, and passes them through write fields. Every byte read is on the host: a target adapter or the file-text resolver resolves the instance the descriptor names, with its credential, and asks it for the bytes. A parked run holds the descriptors as they are, so a resume needs nothing rebound.

#### `files.resolveFileText`

```ts
request: Priced<{ file: FileRef }>
answer:  PricedAnswer<
  | { text: string; rawTextId?: string }
  | { unreadable: 'unsupported_type' | 'bytes_unavailable' | 'extraction_failed' | 'no_text'; detail?: string }
>
```

- Transcription and OCR are model calls, so the call is priced.
- The byte reads happen outside any segment: they are not counted against a segment's call ceiling and not kept in its read memo.
- **Persist:** the text (production: the team's `raw_text` table, whose id comes back as `rawTextId`; a test run stores nothing durable). **Retry:** idempotent.

#### `files.render`

```ts
request: { content: string; type: 'pdf' | 'text' }
answer:  FileRef            // a document-store descriptor
```

- `FILE(content, type)`: the host renders the composed string, stores the artifact, and answers its descriptor.
- **Persist:** the artifact's bytes in the document store. **Retry:** not idempotent (each call stores a new artifact).

### `lookup`

#### `lookup.resolveActingUser`

```ts
request: {
  teamId: TeamId;
  triggerId?: string;      // the trigger the event dispatched through; absent for events that predate trigger-aware dispatch
  segmentId: string;
  instance: string;        // the source instance, as adapters.resolve answered it
  event: TriggerEvent;
}
answer: { id: string; email: string; name?: string | null } | null
```

- The team user an event acts as (`@user_*`). The host maps the event's actor to a team user through the trigger (its creator override and creator fallback), asking the source instance for the event's actor candidates itself (`getActorCandidates`, inside the segment) only when the trigger does not already decide the user. `null`: no user matches.
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
request: { token: string }
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

## Spend

The engine keeps the run's ledger (`movement_engine/run_context.ts`). The budget it sends with each priced call is the run's cap less what it has spent against it (`null` with no cap), and every answer's `cost` is charged. A host refuses priced work past the budget by answering a `BudgetRefusal` carrying what the call spent first; the engine charges that, raises the run's cap (`RunCostCapExceeded`) from its own figures, and suspends the run there (`park.sink.commitLimitPause`, then `commitSuspension`).

The production host meters each priced call under its budget (`withSpendMeter`, `lib/run_spend.ts`). The model and service clients far below the call charge the meter and check it before they start. A client past the budget throws `BudgetExhausted` inside the host, and the host turns it into the refusal. The meter and the billing context are host state, set around each call; the engine imports neither.

## Write locks

The engine keeps two writes from colliding at two levels.

- **Within a run:** an in-process gate serialises flows of one run (collection members, combinator arms) whose writes could find each other's records.
- **Across runs:** each effect asks `host.locks` for the names it needs (`acquire({ segmentId, names })` answers a token) and gives them back when it finishes (`release({ token })`), never holding them for the whole segment. The host keeps one `WriteLockHolder` per segment, opened at its first acquire and closed with the segment, which lets go of anything still held. A record, an edge or a binding is locked as itself. An identity write (`unique by`) locks its whole record type in the team, exclusively. So identity writes to one record type in a team run one at a time across all runs, for the length of each find-then-create.

`WriteLocks` has two implementations (`services/write_locks/`):

- **`PostgresWriteLocks`:** session-level advisory locks on a dedicated connection per segment, keyed by the team and the lock name. This is the production default.
  - **Tried, never waited on.** All parallel flows of a segment share the one connection, which runs one query at a time. A blocking lock call would stall a sibling's unlock behind it, and two runs touching overlapping records in different orders would deadlock where no flow does. So a lock is tried, and retried with backoff (25 ms doubling to 250 ms, jittered) until it is granted or the timeout passes.
  - **Timeout.** A name not granted within `MOVEMENT_WRITE_LOCK_TIMEOUT_MS` (default 60 s) fails the write with `write lock timeout: <name>`. A real cross-run deadlock surfaces this way too: Postgres cannot see it, because nobody blocks inside Postgres. It never hangs.
  - **Lost connection.** A dropped connection releases everything, which covers a process dying. Server-side TCP keepalive (30 s idle, 10 s interval, 3 probes) frees a dead machine's locks in about a minute. If nothing was held when the connection dropped, the next acquire reconnects (one warning). If something was held, the segment's writes fail with `write lock session lost: <name>` until it ends, and its release logs which names were held, since the write they guarded may have run unprotected. A connection that drops under a waiting acquire fails that acquire the same way.
  - **Sizing.** Each in-flight segment that writes holds one Postgres connection of its own, outside the shared pool. In-flight segments are bounded by the drain limit (10 by default, at most 100 per external tick) plus firings on request paths. Size `max_connections` for that.
- **`InMemoryWriteLocks`:** the same holder logic over an in-process gate. `makeTestHost` uses it, and so do test runs: a test run captures its writes instead of making them, so it must never wait on a live firing.

## Supplying a host

- **Production:** `productionEngineHost` (`translation_graph/movement/engine_host.ts`). It wires each family to Postgres, the adapter registry and the model providers. Given a run id, it bills each model call to the run. The run host reads the cost cap (`MOVEMENT_MAX_RUN_COST_USD`) once as each segment starts and passes it as `costCapMicrodollars`. Firings, resumes and callbacks build their snapshot with `runCatalogSnapshotForTeam`, which returns the snapshot and, beside it, the credential ids the run is given as `credentialIds`. A test run hands the host its write sink (`writeSink`).
- **Tests:** `makeTestHost(overrides)` (`movement_engine/test_host.ts`, host side). A test supplies only the pieces its program reaches; no default touches a network or a database. `makeFakeParkSink()` records parks in memory. A piece left out does one of three things:
  - **Throws, naming itself, when the run reaches it:** resolving an adapter (a test supplies its live fakes as `adapters.resolve`; they sit in the same table the production host keeps, and the engine reaches them through `adapters.call`), every `llm.*` method, `park.bindings`, `files.resolveFileText`.
  - **Defaults quietly:** `segment.open` answers a fresh id and `segment.close` answers nothing spent, with no memo or ceiling behind them; `files.render` answers a document-store descriptor whose store key holds nothing; `park.wake` records each request into `overrides.wakes`; a rehearsed write goes to `overrides.writeSink`, or nowhere; `lookup.resolveActingUser` answers `null` (a test's lookup is handed `getCandidates`, a call into its live source adapter); `control.cancel` never cancels; the trace goes only to the result unless the test hands an array (`overrides.trace`); `locks` are a fresh `InMemoryWriteLocks`, one lock session per segment.
  - **Is absent, so the run takes its no-substrate path:** `park.sink`, `park.callbacks`.
- **Another embedder** supplies its own object of the same shape, serving the JSON above.

## Remaining non-JSON

Nothing on the request/answer path. Three things stay outside it, by design:

- **Thrown failures carry only their message.** A host call that fails outright (a park that cannot be persisted, a lock timeout) throws; over a wire that is an error response with a message. The engine never branches on a thrown failure's class.
- **The stand-in is engine-local.** The engine wraps each resolved instance in an in-process stand-in `Adapter` (`movement_engine/host_adapter.ts`) whose every method is one `adapters.call`. It never crosses.
- **The test host's conveniences are host side.** `makeTestHost` takes live fakes, a lookup handed `getCandidates`, a `WriteLocks` and a trace array, and serves each as the JSON family. None of those crosses either.

## Changes since chunk 3

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
- **`locks`:** `acquire({ segmentId, names })` answers `{ token }`; `release({ token })`. No lock holder crosses.
- **`trace`:** new. `append({ segmentId, entries })` as the run goes.

## Recorded debts

- **Resumed segments do not heartbeat.** A timer, await or ask resume keeps the run `parked` and stamps no heartbeat. A crash mid-resume re-runs the parked step: at least once, as before.
