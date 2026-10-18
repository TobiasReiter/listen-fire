# The loop guard slot's wire

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A movement that writes to a source it listens to hears its own write come back: Attio sends `record.updated` for the update a run just made, a poll returns the row a run just changed. A loop guard module tells that echo from a real change, so the echo runs nothing.

**The slot is empty by default.** With no guard in `core:`, neither lf nor the platform suppresses anything, and the echo runs the movement again. lf ships one, `@lf/fingerprint-guard`; the platform's own opt-in, the listen flag `suppress_self`, is unchanged and separate. A guard whose memory is elsewhere (Redis, a database) is a third-party module lf starts and speaks to over this wire.

## Using one

```yaml
core:
  loopGuard: "@lf/fingerprint-guard"
```

- The host's part is two moments. After a run writes a record to a source that sends webhooks or is polled, and can read a record back (`readRecord`), the host reads the record back and tells the guard (`guard.recordWrite`). When an inbound event (webhook or poll) names a record, the host asks the guard whether it is the echo of a listen's own write (`guard.isEcho`). An echo fires none of that listen's movement; other movements' listens and everyone else's changes fire as usual.
- Everything else is the guard's: how long it remembers, what "unchanged" means, where its memory lives. Any doubt, a failed call, or a source that cannot read a record back means the event fires.
- `@lf/fingerprint-guard` remembers a hash of the record as the write left it, for an hour, per record and writing movement; the event is the write's echo while the record still hashes the same. Its settings (all optional): `path` (its file, default `.lf/guard.db`) and `url` (a Postgres database every lf worker shares, in its own `lf_guard` schema, created when the guard is set up or opened). The store slot knows nothing of it.
- Installing a module of your own: a folder in the externals folder with an `lf-external.yaml` saying `kind: core`, `slot: loopGuard` and its `command`, as [the limiter's](limiter-slot.md#installing-one). `lf connect <module>` asks its settings and opens it once.

## The envelope

The store slot's envelope ([store-slot.md](store-slot.md#the-envelope)): JSON-RPC 2.0, one message per line on the module's stdin and stdout, one request at a time, stderr its log, stdin closing ends it.

## Methods

| method | params | result |
|---|---|---|
| `guard.open` | `{ settings: { [name]: string } }` | `null` |
| `guard.recordWrite` | `{ adapter, recordType, externalId, writer, record }` | `null` |
| `guard.isEcho` | `{ adapter, externalId, writer, current? }` | `{ echo: boolean }`, or `{ read: { recordType } }` |

- **`recordWrite`**: `writer` (`listen:<file>:<movement>`) wrote the record `externalId` of `adapter`; `record` is what the source answered when read back right after (`null`: the record is gone). The same writer's later write to the same record replaces the earlier.
- **`isEcho`** asks whether an event naming `externalId` is the echo of `writer`'s write. A guard with no memory of that write answers `{ echo: false }`. One that has asks for the record as it stands, `{ read: { recordType } }`; the host reads it and asks again with `current: { recordType, record }`, and the guard answers `{ echo }`. A guard that needs no record may answer `{ echo }` at once.
- A guard decides by the record alone, not by who made the change; that is how a second user's edit still runs the movement.

## The contract suite

[`contract.ts`](../../packages/movement-engine/services/loop_guard/contract.ts) holds every guard to the same cases (none waits on the guard's memory span). `apps/cli` runs it over `lf --contract-guard` (lf's built-in, file and Postgres) and `lf --contract-guard-slot` (a test module filling a project's slot, `apps/cli/src/__test__/loop_guard_module/serve.ts`); the in-process TypeScript one passes it in `services/loop_guard/__test__`. The platform defines the same slot (`loopGuard` in `CORE_SLOTS`), default empty.

## Changes

- **2026-10-18** (within adapter protocol 2): the loop guard slot, its wire, and process modules filling it.
