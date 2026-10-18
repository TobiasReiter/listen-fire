# The store slot's wire

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A store module keeps a host's run state: runs, parks, joins, await correlations, leases, the work queue, library sources, callbacks, pull cursors and event receipts. lf ships two (`@lf/sqlite-store`, the default, and `@lf/postgres-store`). A third-party one is a process lf starts and speaks to over this wire.

## Installing one

A folder in the project's externals folder, with an `lf-external.yaml`:

```yaml
name: acme_store
kind: core
slot: store
command: [node, store.mjs]      # started in this folder
settings:                       # optional; prompted by `lf connect acme_store`
  - { name: path, label: the state file, secret: false, optional: false }
env: { LOG_LEVEL: info }        # optional
```

- lf.yaml names it for the slot: `core: { store: acme_store }`.
- `lf connect acme_store` asks its settings, keeps them on its install entry in the secrets file, and opens it once (so a module that sets itself up, a schema say, does so then).
- Only the store slot takes a process module. The models, judge and files slots take a built-in: lf runs them as its own code paths, with no wire to drive a process over yet.

## The envelope

- JSON-RPC 2.0, one message per line: lf writes requests to the module's stdin and reads answers from its stdout, one at a time, in order.
- stderr is the module's own log; lf passes it through.
- The module ends when its stdin closes. One still running a second later is killed.
- A method's `params` is one object, keyed in camel case. Its `result` is the answer; `null` for a method that answers nothing.
- An absent optional string is `null`.
- Instants are `Date.toISOString` strings; ids and tokens are strings the module mints.
- A failure is an `error` with a `message`. Code `-32001`, with `data: { name: "RunLeaseLost", runId }`, means a fenced write found the run's lease gone: lf treats it as losing the run. Any other code is a store failure.

## Methods

The first request is always `store.open`. The others are the run host's store families (`RunHostStore`, `CallbackStore` in `packages/movement-engine/services/run_host/`), method for method. Their meaning is the contract suite's: [`contract.ts`](../../packages/movement-engine/services/run_host/contract.ts) holds every store to the same cases, and `apps/cli` runs it through a store module (`run_host_contract.test.ts`).

| method | params | result |
|---|---|---|
| `store.open` | `{ settings: { [name]: string } }` | `{ tenant }`: the team id lf's own runs are kept under |
| `runs.start` | `{ id, file, movement, startedAt, input }` | `null` |
| `runs.settle` | `{ runId, status, outcome, at }`; status `completed`, `parked`, `running` or `failed`; an ending revokes the run's live callbacks | `null` |
| `runs.markParked` | `{ runId }` | `null` |
| `runs.get` | `{ runId }` | a run row, or `null` |
| `runs.list` | `{ limit }` | run rows, most recent first |
| `runs.appendTrace` | `{ runId, segmentId, entries: [...] }` | `null` |
| `runs.traceLength` | `{ runId }` | integer |
| `runs.spent` | `{ runId }` | microdollars spent since the spend baseline |
| `runs.addSpend` | `{ runId, microdollars }` | `null` |
| `runs.resetSpendBaseline` | `{ runId }` | `null` |
| `runs.requestCancel` | `{ runId, reason }` | `null` |
| `records.cancelRequest` | `{ runId }` | `{ reason }`, or `null` when none was asked |
| `records.markFailed` | `{ runId, message }` | `null` |
| `parks.putLeaf` | `{ runId, address, reason, wakeAt, state, fence }` | `null` |
| `parks.claimLeaf` | `{ runId, address, reason }` | `{ reason, state }`, or `null` |
| `parks.finishLeaf` | `{ runId, address, fence }` | `null` |
| `parks.leaves` | `{ runId, parkedOnly, reason, dueBy }` | `[{ address, reason, status, wakeAt }]` |
| `parks.deleteLeaves` | `{ runId, addresses }` | `null` |
| `joins.recordJoin` | `{ runId, frameAddress, pending, fence }` | `null` |
| `joins.decrementJoin` | `{ runId, frameAddress, branchAddress, leafAddress }` | `{ closed }` |
| `joins.persistBranchExport` | `{ runId, frameAddress, branchAddress, branchIndex, exports }` | `null` |
| `joins.collectBranchExports` | `{ runId, frameAddress }` | `[{ branchAddress, branchIndex, exports }]` |
| `joins.hasPendingJoins` | `{ runId }` | boolean |
| `joins.frames` | `{ runId }` | frame addresses |
| `joins.deleteFrames` | `{ runId, frameAddresses }` | `null` |
| `correlations.correlate` | `{ runId, teamId, address, adapterType, correlationKey }` | `null` |
| `correlations.correlated` | `{ adapterType, teamId, correlationKey }` | `[{ runId, teamId, address }]` |
| `correlations.ofRun` | `{ runId, adapterType }` | `[{ runId, teamId, address, correlationKey }]` |
| `correlations.drop` | `{ runId, address }` | `null` |
| `correlations.dropRun` | `{ runId }` | `null` |
| `leases.claim` | `{ runId, ttlMs }` | `{ token }`, or `null` while another holds it |
| `leases.renew` | `{ runId, token, ttlMs }` | boolean |
| `leases.release` | `{ runId, token }` | `null` |
| `leases.dropRunState` | `{ runId, fence }` | boolean |
| `work.enqueue` | `{ kind, key, payload, dueAt, teamId }` | `null` |
| `work.claimDue` | `{ limit, leaseMs, dueBy, kinds? }`; `kinds` (a drain pool's) leases only rows of those kinds, absent every kind | `[{ id, kind, key, payload, claim }]` |
| `work.complete` | `{ id, claim }` | `null` |
| `work.release` | `{ id, claim, dueAt }` | `null` |
| `sources.put` | `{ teamId, hash, source }` | `null` |
| `sources.get` | `{ teamId, hash }` | the source, or `null` |
| `callbacks.mint` | `{ teamId, runId, address, params, state, singleUse, expiresAt }` | `{ id }` |
| `callbacks.get` | `{ id }` | a callback row, or `null` |
| `callbacks.record` | `{ id, values, bodyDueAt }` | `{ kind: "recorded", callback, callIndex }`, or `{ kind: "not_found" }`, `{ kind: "closed", callback }`, `{ kind: "expired", callback }` |
| `callbacks.markBodyStarted` | `{ id, callIndex, fence }` | boolean |
| `callbacks.landed` | `{ ids }` | those of `ids` with at least one call whose body started |
| `callbacks.revokeRun` | `{ runId }` | `null` |
| `inbound.checkpoint` | `{ subscriptionId }` | `{ checkpoint }`, or `null` |
| `inbound.saveCheckpoint` | `{ subscriptionId, checkpoint }` | `null` |
| `events.claim` | `{ listen, key }` | `true` the first time this event key reaches this listen; `false` for a redelivery, which runs nothing |
| `writes.remember` | `{ adapter, recordType, externalId, writer, fingerprint, expiresAt }`: a run's write to a record, for the writing movement's listens (`writer`, `listen:<file>:<movement>`), with the record's fingerprint as the write left it; the same writer's later write to the record replaces it | `null` |
| `writes.remembered` | `{ adapter, externalId, now }` | `[{ writer, recordType, fingerprint }]`, those not expired at `now`. An inbound event naming the record while it still has the fingerprint is that write's echo and fires none of the writer's listens |

The rows:

```ts
type RunRow = { id: string; file: string; movement: string; status: string; startedAt: string; input: string; outcome: string | null };
type CallbackRow = {
  id: string; teamId: string; runId: string; address: string;
  params: unknown; state: unknown; calls: unknown; singleUse: boolean;
  expiresAt: string | null; status: 'live' | 'fired' | 'revoked';
};
```

`lf --contract-store <state.db|postgres://…>` serves this wire over lf's own stores. A module may forward to it, as the test module does (`apps/cli/src/__test__/store_module/forward.mjs`). `runs.status` and `runs.complete` are the contract suite's helpers and are not called by lf.

## Changes

- **2026-10-18** (within adapter protocol 2): `writes.remember` and `writes.remembered`, so a movement's own write echoing back from the source it listens to runs nothing, across every lf process sharing the store.
- **2026-10-18** (within adapter protocol 2): `work.claimDue` takes `kinds`, for drain pools (`lf drain --kinds`).
- **2026-10-17** (within adapter protocol 2): the store slot's wire, and process modules filling the store slot.
