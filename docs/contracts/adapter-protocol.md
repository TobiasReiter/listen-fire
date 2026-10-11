# The adapter protocol

Version: 2

A remote adapter connects a system you run to Listen-Fire. It is an HTTP
server you host, in any language. Listen-Fire calls it to learn your data
model, to read and write your records, and to wait on things that happen in
your system. Your server calls Listen-Fire back when something happens.

This document is the contract. The source of truth is the zod schema in
`packages/engine-contracts/protocol.ts`; where this page
and the schema disagree, the schema wins. The reference adapter is the fake
CRM in `apps/api/src/scripts/dev/fake_crm_adapter.ts` (see
[Build your first adapter](#build-your-first-adapter)).

Contents:

- [The envelope](#the-envelope)
- [Versioning](#versioning)
- [Authentication](#authentication)
- [The manifest and installing](#the-manifest-and-installing)
- [Methods](#methods)
- [Waiting on your system (awaits)](#waiting-on-your-system-awaits)
- [Telling Listen-Fire something happened](#telling-listen-fire-something-happened)
- [Paging](#paging)
- [Files](#files)
- [Limits and timeouts](#limits-and-timeouts)
- [Errors](#errors)
- [Build your first adapter](#build-your-first-adapter)
- [Changes](#changes)

## The envelope

Every call is a `POST` of JSON to one URL, your `baseUrl`. The method name is
in the body, not the path.

```json
{
  "protocolVersion": "2",
  "method": "describe",
  "cacheScopeId": "c0ffee",
  "params": { "typeId": "Company" }
}
```

- `protocolVersion` is the string `"2"`.
- `cacheScopeId` is opaque. You may scope a per-call cache by it, or ignore it.
- `params` is the method's input (see [Methods](#methods)).

You answer with HTTP 200 and one of two bodies:

```json
{ "ok": true, "result": { "typeId": "Company", "displayName": "Company", "fields": [], "references": [] } }
```

```json
{ "ok": false, "error": { "code": "adapter_error", "message": "CRM timed out", "retryable": true } }
```

- An application failure is still HTTP 200, with `ok: false`.
- Non-200 is for transport faults only: 401 when authentication fails, 400 when
  the body is not a request envelope. Listen-Fire treats any non-2xx as a
  transport error, marked retryable (see [Limits](#limits-and-timeouts) for
  what that does today).
- Listen-Fire validates every `result` against the method's schema. A wrong
  shape fails the call and names the method and the offending path.

Types, fields and edges each have two names, and the two may differ:

- `typeId` (and a field's `fieldId`) is your own id. Listen-Fire hands a
  `typeId` back to `describe` and reads it in a reference's `targetTypeId`.
  Keep it stable.
- `displayName` (a reference's `name`, for an edge) is the natural name.
  Automations write it (`crm-[:Company]->`), and every other call names the
  type, field or edge by it: `recordType: "Company"`, the keys of `fields`,
  `edge: "Comments"`. It is not just presentation: renaming it breaks the
  saved automations that use it.
- `describe` may be asked by either name, so accept both. Simplest: give each
  type one name and use it for both.

Record ids are identity, and cross the wire unchanged.

## Versioning

- A request carries `"protocolVersion": "2"`. A server built on the reference
  kit answers any other version with the error code `protocol_version`.
- Your `manifest` answer carries `"protocolVersion": 2` (a number).
- Installing probes your server: Listen-Fire calls `manifest` with the secret
  and refuses the install unless it answers `protocolVersion: 2`.
- An install made before its secret is supplied stores the version the
  manifest file claims. The probe runs when the secret is linked.
- Additions that older servers can ignore (a new optional field, a new
  optional method) do not change the version. A change in meaning does.
- The version is an integer on the manifest and its decimal string on a
  request. `MANIFEST_PROTOCOL_VERSION` and `PROTOCOL_VERSION`
  (`packages/engine-contracts/protocol.ts`) hold it, and a test holds them
  equal to the version at the top of this page. [The contracts
  index](README.md) lists what each release supports.

## Authentication

Listen-Fire sends your secret on every call. Your manifest picks how:

| `authStrategy` | Header Listen-Fire sends |
|---|---|
| `{ "kind": "bearer" }` | `Authorization: Bearer <secret>` |
| `{ "kind": "shared_secret" }` | `x-listen-fire-adapter-secret: <secret>` |
| `{ "kind": "shared_secret", "header": "x-acme-key" }` | `x-acme-key: <secret>` |

- Check the header on every request; answer HTTP 401 when it is missing or wrong.
- The secret is entered at install time and stored encrypted. It never goes in
  the manifest.
- Every call to your server carries `x-listen-fire-team: <team id>`, the UUID of
  the team whose install is calling. A server that serves several teams learns
  from it which one. It is not a credential: authenticate by the secret.
- When your server calls Listen-Fire (the push doors), it sends the same secret.
  The team header is optional there; send it only to disambiguate a secret
  shared across teams. See [the doors](#the-two-doors-you-call).

## The manifest and installing

The manifest file registers your server with a team:

```json
{
  "protocolVersion": 2,
  "adapterType": "acme_crm",
  "displayName": "Acme CRM",
  "description": "Our internal CRM.",
  "baseUrl": "https://crm.acme.example/listen-fire",
  "authStrategy": { "kind": "bearer" },
  "supportedTriggers": ["webhook"],
  "runtimeCapabilities": {
    "traversal": { "incoming": false, "edgeProperties": false },
    "resources": false
  },
  "methods": [
    "listEntryPoints", "describe", "resolveEntity", "getFieldValue", "getRelated",
    "iterateRelatedPage", "createRecord", "updateRecord", "deleteRecord",
    "preprocessInbound", "listEventTypes", "wakeKeys", "resolveAwait",
    "ensureEventSubscription", "removeEventSubscription"
  ]
}
```

- `adapterType` is the slug an automation imports (`import { acme_crm } from adapters`). One install per slug per team. Charset: `^[a-z][a-z0-9_]*$` (ASCII lower case).
  It may not be a name a built-in adapter answers to (`slack`, `gmail`,
  `inbound_email`, `kg_mutation`, …, in any casing), nor `callback` or `ask`:
  the install is refused.
- `methods` lists exactly what you implement. Listen-Fire never calls an
  optional method you did not list.
- The file is what Listen-Fire uses. Installing calls your `manifest` method
  only to check its `protocolVersion` and its shape; `methods`,
  `supportedTriggers` and `runtimeCapabilities` come from the file. Keep the
  two answers the same.
- `supportedTriggers` is `["webhook"]` if your system announces events, else `[]`.
- Optional fields: `handbookSection` (`{ title, content }`, prose the authoring
  handbook shows about your system), `vocabulary` (an icon and event phrasing),
  `webhookEventTypeId`.

Install it on the **Adapters** page, pasting the manifest and the secret
together. An agent can instead give the user a link to enter the secret
out of band.

## Methods

Required: `manifest`, `listEntryPoints`, `describe`, `resolveEntity`,
`getFieldValue`, `getRelated`, `createRecord`, `updateRecord`, `deleteRecord`.
A pure sink returns `null` and `[]` from the reads; a read-only source can
throw from the writes. Everything else is optional and declared in `methods`.

Each example shows `params` → `result` (the `result` inside `ok: true`).

### manifest

`{}` → the same declarations as the manifest file:

```json
{
  "protocolVersion": 2,
  "adapterType": "acme_crm",
  "supportedTriggers": ["webhook"],
  "runtimeCapabilities": { "traversal": { "incoming": false, "edgeProperties": false }, "resources": false },
  "methods": [
    "listEntryPoints", "describe", "resolveEntity", "getFieldValue", "getRelated",
    "iterateRelatedPage", "createRecord", "updateRecord", "deleteRecord",
    "preprocessInbound", "listEventTypes", "wakeKeys", "resolveAwait",
    "ensureEventSubscription", "removeEventSubscription"
  ]
}
```

Listen-Fire reads only `protocolVersion` from it (see
[installing](#the-manifest-and-installing)).

`webhookEventTypeId` (a string) is optional.

### listEntryPoints

`{}` → the types an automation can start from:

```json
[
  { "typeId": "Company", "displayName": "Company", "writable": true, "readable": false, "fires": true,
    "description": "A company. A listen is delivered each one somebody creates in the CRM." },
  { "typeId": "Comment", "displayName": "Comment", "writable": false, "readable": false }
]
```

- `writable`: automations may create this type.
- `readable`: automations may enumerate it from the root.
- `fires`: a listen is delivered records of this type (see
  [emit](#emit-new-data)). An event type is usually `readable: false`: it is
  pushed, never listed.
- Publish every type your edges reach, even one only reached along an edge
  (`Comment` above), so it is named.

### describe

`{ "typeId": "Company" }` → one type, or `null` if unknown:

```json
{
  "typeId": "Company",
  "displayName": "Company",
  "fields": [
    { "fieldId": "Name", "displayName": "Name", "kind": "string", "writable": true, "required": true },
    { "fieldId": "Description", "displayName": "Description", "kind": "string", "writable": true, "required": false }
  ],
  "references": [
    { "fieldId": "Comments", "name": "Comments", "targetTypeId": "Comment", "cardinality": "many",
      "direction": "outgoing", "writable": false, "awaitable": true, "watchable": true, "resolvesEmpty": true }
  ]
}
```

- A field's `kind` is one of `string`, `number`, `boolean`, `date`,
  `file`, `json` or `enum` (with `enumValues`), or `reference` (an edge, not
  a value). A field with any other `kind` is silently dropped, and the
  type's position is then left open: automations may read any field name
  off it unchecked. Add `"cardinality": "many"` for a list.
- Fields and references pass through with whatever extra keys you declare.
  On a reference Listen-Fire reads:
  - `readable` — defaults to true; `false` marks a write-only edge;
  - `writable` — only an explicit `true` allows creating along the edge;
    absent means read-only;
  - `awaitable`, `watchable`, `resolvesEmpty` (see
    [awaits](#waiting-on-your-system-awaits)).
- `edgesFrom` (optional) replaces `describe` for nested systems: `{ position, cursor? }`
  → `{ descriptor, targetPositions?, nextCursor? }` or `null`. The adapter
  handbook's schema chapter covers it.

### resolveEntity

Decides whether a record Listen-Fire is about to write already exists.

```json
{
  "record": { "Name": "Vireo Robotics" },
  "recordType": "Company",
  "candidates": [],
  "constraints": { "any": [ { "all": [ { "field": "Name" } ] } ] }
}
```
→
```json
{ "candidates": [ { "adapterType": "acme_crm", "externalId": "company-7", "recordType": "Company", "data": { "Name": "Vireo Robotics" } } ] }
```

Return `{ "candidates": [] }` when nothing matches; Listen-Fire then creates.

### getFieldValue

```json
{
  "position": { "adapterType": "acme_crm", "recordType": "Company",
                "identity": { "kind": "stable", "recordId": "company-7", "data": { "Name": "Vireo Robotics" } } },
  "fieldId": "Name"
}
```
→ `"Vireo Robotics"` (any JSON value, or `null`).

A position is how Listen-Fire hands a record back to you: the `recordType`,
your `recordId`, and the `data` you attached when you returned it. Read from
`data` when you can; it saves a call to your system.

A position an automation produced, rather than read from you, also carries
`originRef` (its `kind` is `extract`, `transform` or `resource`) and may carry
`evidence` and `resources`. You may ignore all three. A file ref inside them
is in the wire's spelling ([Files](#files)): its owner type and handle, never
Listen-Fire's credential or construction args.

### getRelated

```json
{
  "position": { "adapterType": "acme_crm", "recordType": "Company", "identity": { "kind": "stable", "recordId": "company-7" } },
  "fieldId": "Comments",
  "direction": "outgoing"
}
```
→
```json
[ { "position": { "adapterType": "acme_crm", "recordType": "Comment",
                  "identity": { "kind": "stable", "recordId": "comment-1", "data": { "Text": "approved" } } } } ]
```

- Every position you return must name its `recordType`; a typeless one is rejected.
- `where`, `orderBy` and `limit` may arrive as hints. You may ignore them;
  Listen-Fire applies them again.
- For a large collection, implement [`iterateRelatedPage`](#paging) too.

### createRecord

```json
{
  "recordType": "Company",
  "fields": { "Name": "Vireo Robotics" },
  "mutationContext": { "source": { "type": "structured_input" }, "occurredAt": "2026-10-07T09:54:31Z" },
  "parentLinks": [ { "recordType": "Deal", "externalId": "d_1", "edgeName": "Company" } ]
}
```
→
```json
{ "adapterType": "acme_crm", "externalId": "company-1", "recordType": "Company", "data": { "Name": "Vireo Robotics" } }
```

- `fields` is keyed by your field display names.
- `parentLinks` (optional) are parents to attach the new record to, along the named edge.
  A link may carry `data`: the parent's own payload, in its adapter's shape.
- Optional inputs: `evidence` (per field), `resources`, `bridgeToExternal`.
- The `data` you return is what an automation reads off the written record,
  and what [`resolveAwait`](#waiting-on-your-system-awaits) later receives as `headData`.
- Optional outputs: `url`, `events`.

### updateRecord

The `createRecord` input plus `externalId` →

```json
{ "adapterType": "acme_crm", "externalId": "company-1", "recordType": "Company", "data": { "Name": "Vireo" }, "association": "none" }
```

- If the record is gone, return `{ "notFound": true }`; do not throw.
- `association` says what became of the `parentLinks`: `made`, `already`,
  `unsupported` (you cannot attach an existing record along that edge) or
  `none` (no parent was named). Omitted, it reads as `unsupported`.

### deleteRecord

`{ "recordType": "Company", "externalId": "company-1", "mutationContext": { … } }` → `{}` (optionally `{ "events": [] }`).

### Optional methods

| Method | params | result |
|---|---|---|
| `iterateRelatedPage` | `getRelated` params + `cursor?` | `{ items, nextCursor? }` ([Paging](#paging)) |
| `resolveAwait` | `{ recordId, edge, headData? }` | `pending` / `landed` / `empty` ([awaits](#waiting-on-your-system-awaits)) |
| `wakeKeys` | `{ raw }` | `string[]` ([awaits](#waiting-on-your-system-awaits)) |
| `preprocessInbound` | `{ raw, checkpoint? }` | `{ events, checkpoint? }` — **required** to receive webhooks through the [host door](#inbound-through-the-host-door) |
| `listEventTypes` | `{}` | `[{ tag, positionType, match? }]` |
| `ensureEventSubscription` | `{ events, callbackUrl, current?, scope? }` | `{ externalId?, secret }` |
| `removeEventSubscription` | `{ callbackUrl, externalId?, scope? }` | `null` |
| `readRecord` | `{ recordType, externalId, fieldIds? }` | the record's fields, or `null` (lets an update with no changes be skipped) |
| `linkRecords` / `unlinkRecords` | `{ from: { recordType, externalId }, edgeName, to: { … }, mutationContext }` | `{ created }` / `{ removed }` |
| `resolveFileRef` | `{ ref }` | `{ url, contentType? }` ([Files](#files)) |
| `translateFilter` | `{ expression, entityType }` | `{ native, residual }` |
| `getDedupRules` | `{ typeRef }` | `{ constraints }` or `null` |
| `getActorCandidates` | `{ event }` | `[{ identity, source }]` |
| `extractActor` | `{ event }` | an actor identity, or `null` |
| `describeOpaqueId` | `{ fieldPath, value }` | a label, or `null` |
| `invokeFieldFunction` | `{ recordType, fieldId, functionName, args: { instructions, data } }` | the composed value |
| `edgesFrom` | `{ position, cursor? }` | see [describe](#describe) |

`listEventTypes` example — the CRM's one event, delivered as a `Company`:

```json
[ { "tag": "company.created", "positionType": "Company" } ]
```

## Waiting on your system (awaits)

An automation can wait for something to happen in your system:

```
c = write crm-[:Company]-> { Name: "Vireo Robotics" }
r = await FIRST(c-[:Comments]->)
```

The run stops at the `await` and resumes when a comment arrives. Listen-Fire
owns all the waiting state. Your server answers two questions: "has it
happened yet, and if not, what key will you wake it with?" (`resolveAwait`)
and "which keys does this event wake?" (`wakeKeys` or the `wake` door).

### Declaring an awaitable edge

On the reference in `describe`:

- `awaitable: true` — automations may `await` it.
- `watchable: true` — you will wake waiting runs (through `wake` or a delivery
  to the host door). Without it, `await FIRST(…)` is refused when the
  automation is saved, and the author is told to poll instead.
- `resolvesEmpty: true` — the wait can end with nothing (for example, the
  record was deleted). Then what follows the `await` runs zero times.

### resolveAwait

```json
{ "recordId": "company-1", "edge": "Comments", "headData": { "Name": "Vireo Robotics" } }
```

- `recordId` is the `externalId` you returned when the record was written.
- `headData` is the `data` you returned with it, when there was any.

Answer one of three:

```json
{ "status": "pending", "correlationKey": "thread:company-1" }
```

```json
{ "status": "landed", "correlationKey": "thread:company-1",
  "landings": [ { "recordId": "comment-1", "recordType": "Comment", "fields": { "Text": "approved" } } ] }
```

```json
{ "status": "empty" }
```

- `pending`: nothing yet. `correlationKey` is required: it is the key you
  will later wake with. Listen-Fire stores the key against the waiting run.
- `landed`: here is what arrived. `correlationKey` is required here too: if
  no landing passes the automation's `WHERE`, the run keeps waiting on it.
- `empty`: the wait is over with nothing, and what follows the `await` runs
  zero times. Only on an edge declared `resolvesEmpty`. Listen-Fire does not
  yet enforce this: an `empty` on any other edge is bound anyway, and its
  downstream silently runs zero times where the author never planned for it.
  Never return it there.
- Each landing's `fields` are read back through your `getFieldValue` for its
  `recordType`, so key them the way your positions' `data` is keyed.
- The first landing that passes the `WHERE` wins.

When Listen-Fire calls it:

- once at the `await`;
- once more right after the run is parked, so a wake that arrived between the
  two is not lost;
- again on every wake for the run's key.

Make it a cheap, current read of your system. It must be safe to call any
number of times.

### Waking a run

Wake by key, two ways:

- push the keys yourself: `POST …/wake` ([the doors](#the-two-doors-you-call));
- or, if Listen-Fire receives your webhooks ([host door](#inbound-through-the-host-door)),
  implement `wakeKeys`: `{ "raw": <the delivery body> }` → `["thread:company-1"]`.
  Listen-Fire calls it for every delivery, whether or not the delivery also
  carries events. If `wakeKeys` fails, the delivery's events are still
  receipted and queued, and the delivery is answered 500 so you send it
  again; the resend replays the events without running them twice and
  retries the wakes.

**Commit before you wake.** A wake makes Listen-Fire call `resolveAwait` for
the key at once. If the landing is not yet visible to that read (still in an
open transaction, or on a replica that lags), the run parks again on
`pending` and nothing follows: no second wake comes unless you send one.

A wake for a key nobody is waiting on does nothing. A run woken early simply
calls `resolveAwait` again and parks again on `pending`.

Cancelling a waiting run is Listen-Fire's alone: it drops its key. A later
wake for that key finds nothing.

## Telling Listen-Fire something happened

There are two ways in. Use whichever fits your system:

- **You push** to the two doors (`emit`, `wake`). Simplest: no subscription,
  no signatures.
- **Listen-Fire subscribes** to you and you deliver webhooks to the URL it
  gives you (the host door). Use this when your system already sends webhooks.

The two are independent and unordered. Nothing relies on a wake arriving
before or after an event.

### The two doors you call

```
POST {listen-fire}/api/public/adapter/{adapterType}/emit   { "events": [ … ] }
POST {listen-fire}/api/public/adapter/{adapterType}/wake   { "keys": [ … ] }
```

Authentication:

- Send the same header, with the same secret, that Listen-Fire sends you (your
  `authStrategy`). The install whose secret matches is the team.
- You never name the team, except with the optional `x-listen-fire-team`
  header (the same header, and the same team id, Listen-Fire sends on every
  call to you). Use it when one secret serves several teams' installs of your
  adapter: it narrows the lookup to that team. Its value must be the team's
  id, a UUID; anything else is answered 401 with no further detail.

Answers:

| Status | Body | When |
|---|---|---|
| 202 | `{ "accepted": n }` | queued |
| 400 | `{ "error": "bad_request", "issues": [{ "path", "message" }] }` | malformed body |
| 401 | `{ "error": "unauthorized" }` | the secret matches no install of this type, the type is not installed, the named team has no matching install, or the type is a name a built-in adapter answers to |
| 409 | `{ "error": "ambiguous_credential", "message" }` | the secret matches installs on several teams and no `x-listen-fire-team` was sent |
| 413 | | the body is over 1 MB |
| 500 | `{ "error": "capture_failed", "accepted", "failed" }` | some events could not be receipted (see below) |
| 500 | `{ "error": "internal" }` | retry later |

- Authentication is checked before the body, so an unauthenticated caller
  learns nothing about the body's shape.
- 401 is the only refusal for anything unauthenticated: never 404.
- A body carries 1 to 1,000 events or keys, in at most 1 MB of JSON
  (`content-type: application/json`).
- Delivery is at least once. Retry on 5xx or a network failure.
- A `capture_failed` 500 on `emit` is partial: the events counted in
  `accepted` were receipted and queued before the 500. Since `emit` is not
  idempotent, resending the whole batch runs those again. Resend only the
  events that failed, or accept the duplicate runs.

#### emit: new data

```json
{
  "events": [
    {
      "payload": { "id": "company-3", "Name": "Larch Bio" },
      "externalId": "company-3",
      "tag": "company.created",
      "eventType": "company.created",
      "changeType": "create",
      "recordType": "Company"
    }
  ]
}
```

- Each event is matched against the team's listens on your adapter, exactly
  as a webhook delivery's events are. `tag` is matched against your
  `listEventTypes` to decide the event's type.
- `payload` is what the automation reads: it becomes the delivered record's
  data, read through your `getFieldValue`.
- Every field but `payload` is optional; there are also `actor`,
  `occurredAt` and `changedFields`.
- `accepted` counts receipts: one per listen the event matched. An event no
  listen selects is accepted as 0 and leaves nothing behind.
- One malformed event fails the whole request with 400; nothing is queued.
- `emit` is not idempotent in protocol 2. Sending an event twice runs its
  automations twice. (A dedupe key is a planned addition.)
- While your request is open, Listen-Fire calls you back (`listEventTypes`).
  A single-threaded server must not block on its own push.

#### wake: resume waiting runs

```json
{ "keys": ["thread:company-1"] }
```

- `accepted` is the number of keys queued. A key nobody waits on is accepted
  and does nothing.

### Inbound through the host door

If your system sends webhooks, let Listen-Fire subscribe:

1. While any automation listens to your adapter, Listen-Fire calls
   `ensureEventSubscription` on every reconcile of the team's listens (each
   time an automation is saved or deleted), even when nothing changed:

   ```json
   { "events": [], "callbackUrl": "https://listen-fire.example/api/public/webhook-sync/acme_crm/5f0c…" }
   ```
   →
   ```json
   { "externalId": "crm-sub-1", "secret": "8c1d…" }
   ```

   - `events` is the selection. An empty selection means every event you offer.
   - Make it an idempotent upsert. `current` (the previous `externalId` and
     `events`) arrives when a subscription already exists; update it rather
     than adding another.
   - Return the same secret to keep it. A different secret rotates it:
     Listen-Fire stores it and verifies the next delivery with it.
   - Being asked again is how a subscription you lost (a restart, a wiped
     store) comes back.
   - Treat `callbackUrl` as opaque. It is stable for the install.
   - `secret` is required. Without one the subscription is refused, withdrawn
     (`removeEventSubscription`), and reported as a problem when the automation
     is saved.

2. Deliver each webhook as a `POST` to `callbackUrl`, signed:

   ```
   x-listen-fire-signature: <lowercase hex HMAC-SHA256 of the exact raw body, keyed by the secret>
   ```

   The body is your own format, sent as `content-type: application/json`, at
   most 100 KB. Listen-Fire answers:

   | Status | When |
   |---|---|
   | 200 `{ "ok": true, "eventsProcessed": n }` | accepted |
   | 400 `{ "error": "provider_mismatch" }` | the URL's adapter segment does not match the subscription |
   | 401 `{ "error": "signature_invalid" }` | bad or missing signature |
   | 404 `{ "error": "subscription_not_found" }` | unknown or deleted subscription |
   | 500 | your adapter does not implement `preprocessInbound`; `wakeKeys` failed or its wakes could not be queued (the events are already receipted: send the delivery again); or an internal failure |

3. While your delivery is open, Listen-Fire calls you back:
   `preprocessInbound({ raw })` turns your body into events, `wakeKeys({ raw })`
   turns it into keys, and `listEventTypes` types the events. A
   single-threaded server must not block on its own delivery.

   ```json
   { "raw": { "companies": [ { "id": "company-3", "Name": "Larch Bio" } ] } }
   ```
   →
   ```json
   { "events": [ { "payload": { "id": "company-3", "Name": "Larch Bio" }, "externalId": "company-3", "tag": "company.created" } ] }
   ```

   `checkpoint` is optional: whatever you return is handed back on the next delivery.

4. When no listen needs the subscription any more, Listen-Fire calls
   `removeEventSubscription`.

Protocol 2 has no replay protection: a captured signed delivery verifies
again. Keep the callback on HTTPS.

## Paging

`getRelated` returns everything at once. For a large collection implement
`iterateRelatedPage` and list it in `methods`:

```json
{ "position": { … }, "fieldId": "Company", "direction": "outgoing", "cursor": 2 }
```
→
```json
{ "items": [ { "position": { … } }, { "position": { … } } ], "nextCursor": 4 }
```

- The first call has no `cursor`. Return `nextCursor` while more remain and
  omit it on the last page.
- The cursor is any JSON value you like. Listen-Fire echoes it back unchanged.
- Returning the same cursor you were given fails the walk (it would never
  end), and so does a walk past 10,000 pages.
- Refuse a cursor you did not mint with `bad_request` (not retryable). On
  the TypeScript reference kit, throw `AdapterBadRequestError`; any other
  throw becomes `adapter_error`, which is marked retryable: a caller that
  honours the flag would ask again with the same cursor.

The TypeScript reference kit (`createAdapterProtocolHandler`) serves
`iterateRelatedPage` for you. If your in-process adapter only offers a stream
(`iterateRelated`), the kit drains it into one page capped at 1,000 items,
with no `nextCursor`, and logs a warning naming the adapter. If it offers
neither, the method answers `method_not_implemented`.

## Files

File bytes never ride the JSON envelope; they move by URL. A file is what
the envelope declares one, never a shape the data carries: a field your
catalog declares `"kind": "file"` (in `describe`), or a resource's `fileRef`.
A file ref anywhere else is data to Listen-Fire, whatever keys it carries.

- **Into your system.** A write may carry a file (in a field you declare a
  file, or a resource's `fileRef`) with a `url`:

  ```json
  { "__brand": "FileRef", "name": "deck.pdf", "contentType": "application/pdf",
    "source": { "ownerAdapterType": "email", "handle": "…" },
    "url": "https://listen-fire.example/api/files/blob/abc123" }
  ```

  `GET` the `url` at write time; it is short-lived. `__brand` is the ref's
  spelling; the field it sits in is what makes it a file. The `source` names
  the owner type and its handle only: no ref Listen-Fire sends names its
  credential or construction args. The reference kit makes the value at each
  field you declare a file a file before your code sees it.

- **Out of your system.** Return a file ref only at a field your catalog
  declares a file. Its `source` is
  `{ "ownerAdapterType": "<your adapterType>", "handle": "<your id>" }` (or a
  `url` alone), and you implement `resolveFileRef`:

  ```json
  { "ref": { "__brand": "FileRef", "name": "deck.pdf", "source": { "ownerAdapterType": "acme_crm", "handle": "f_42" } } }
  ```
  →
  ```json
  { "url": "https://crm.acme.example/files/f_42?sig=…", "contentType": "application/pdf" }
  ```

  Listen-Fire fetches the URL server-side, so it can be signed and
  short-lived. The reference kit answers `resolveFileRef` only for a ref that
  already carries a `url`; any other ref answers `method_not_implemented`.
  A ref returned at a field you do not declare a file reaches Listen-Fire as
  data: it is never read as a file (the conformance CLI's `files-declared`
  check names such a field).

## Limits and timeouts

- **Push doors** (`emit`, `wake`): a JSON body of at most 1 MB, carrying 1 to
  1,000 events or keys. A larger body is answered 413 before anything is
  read.
- **Host webhook door**: the raw body is read only for
  `content-type: application/json`, up to 100 KB. A larger body is answered
  413. A body of any other content type is not read, so its signature cannot
  verify (401).
- **Calls to your server**: Listen-Fire sets no timeout of its own; Node's
  `fetch` defaults apply (about 5 minutes for the response headers, and 5
  minutes between body chunks). A call is never retried in place, and the
  `retryable` flag is not yet acted on: a failed call fails the automation
  run that made it (an install's `manifest` call fails the install).

## Errors

Inside the envelope (HTTP 200, `ok: false`):

| `code` | `retryable` | Meaning |
|---|---|---|
| `method_not_implemented` | false | Unknown method, or one you do not implement |
| `adapter_error` | true | Your code failed (the flag is not yet acted on: [Limits](#limits-and-timeouts)) |
| `bad_request` | false | `params` did not match the method's schema (the message is `<method>: <path>: <problem>`), or you refused the request (a cursor you never minted) |
| `protocol_version` | false | The request's `protocolVersion` is not `"2"` |

Outside it:

- HTTP 401 `unauthorized`: authentication failed.
- HTTP 400 `bad_request`: the body is not JSON, or not a request envelope.

Use your own `code` for anything else; set `retryable` honestly.

## Build your first adapter

The fake CRM is a complete protocol-2 adapter in one file:
`apps/api/src/scripts/dev/fake_crm_adapter.ts`. It has one type, `Company`,
with a comment thread. It uses both push doors and the host door's methods,
and it pages. Read it next to this walkthrough.

Its paging is exercised by its integration test
(`scripts/dev/__test__/fake_crm_adapter.integration.test.ts`) and by the
conformance CLI (step 1), not by an automation: `Company` is not readable
from the root, so no automation can walk the collection.

1. **Run the conformance CLI against your server.** Start with it and keep
   it green as you build. It needs no Listen-Fire stack and no database:

   ```bash
   export ADAPTER_CONFORMANCE_SECRET=<your secret>
   pnpm adapter:conformance --url https://crm.acme.example/listen-fire --auth bearer \
     --scratch-type Company --scratch-fields '{"Name":"Conformance Co"}' \
     --sample-delivery '{"companies":[{"id":"c1","Name":"A"}]}' \
     --wait-for-push 30
   ```

   It prints one line per check (`PASS`, `FAIL` or `SKIP`, then the check's
   name and detail) and exits 1 on any `FAIL`. The checks: the manifest and
   its version; the refusal of an older `protocolVersion`; the error
   envelopes (`bad_request` naming the method and path, `method_not_implemented`);
   `listEntryPoints`, `describe` and the natural names; `resolveEntity`,
   `getRelated`, `iterateRelatedPage` (paging), `getFieldValue`, `createRecord`,
   `files-declared` (no field answers a file ref unless your catalog declares
   it a file), `updateRecord`, `deleteRecord`; `resolveAwait`; the event subscription
   (a secret, a stable `externalId`); `listEventTypes`, `preprocessInbound`
   and `wakeKeys`; and the two push doors.

   Flags:

   - `--url <baseUrl>` and `--auth bearer|secret` are required. For
     `--auth secret`, `--auth-header <name>` names the header (default
     `x-listen-fire-adapter-secret`).
   - The secret is read from the environment variable `--secret-env` names
     (default `ADAPTER_CONFORMANCE_SECRET`), never from the command line.
   - `--scratch-type <typeId>` with `--scratch-fields '<json>'` names a type
     the CLI may write. It creates three records with those fields (the first
     string field gets ` #1`, ` #2`, ` #3` appended), updates one, reads a
     field back and compares it with what it wrote, deletes them all, and uses them to check paging and `resolveAwait`.
     Without the flags, those checks are skipped with a notice.
   - `--sample-delivery '<json>'` is a webhook body your server sends. The CLI
     cannot make you deliver one, so it hands this body to `preprocessInbound`
     and `wakeKeys` and checks the shapes.
   - `--wait-for-push <seconds>` makes the CLI wait for your server to push
     to the doors. The CLI serves a stand-in for Listen-Fire's host and
     prints its URL on stderr (`--host-port <n>` fixes the port, `--host-bind <address>`
     picks the address, default `127.0.0.1`: use one your server can reach); point your
     server's host URL at it, then trigger an event and a wake. It checks the
     credential and the body of each push against the doors' own schemas.
     At `0` (the default) the door checks are skipped.
   - `--json` prints the report as a JSON array.

   The fake CRM passes every check. The CLI cannot check what the real host
   does with a push; the dev loop in step 7 does.

2. **Describe your data.** `listEntryPoints` publishes `Company` (writable,
   fires) and `Comment`. `describe` gives `Company` its fields and its
   `Comments` edge, declared `awaitable`, `watchable` and `resolvesEmpty`.

3. **Implement the required methods.** `resolveEntity` always answers no
   match, so every write creates. `createRecord` stores the company and
   returns its id and fields. `getFieldValue` reads the position's `data`.

4. **Serve it.** In TypeScript, wrap your adapter with the reference kit:

   ```ts
   const handler = createAdapterProtocolHandler({
     adapter,
     authenticate: (headers) => headers['authorization'] === `Bearer ${secret}`,
   });
   http.createServer((req, res) => void handler(req, res)).listen(port);
   ```

   The kit answers `manifest`, checks the version, validates `params`, maps
   throws to `adapter_error`, and serves paging. In another language, follow
   [the envelope](#the-envelope).

5. **Make the thread awaitable.** `resolveAwait` answers `empty` for a
   deleted company, `pending` with `thread:<company id>` for a thread with no
   comments, and `landed` with the comments otherwise.

6. **Push.** When somebody comments, the CRM `POST`s `{ "keys": ["thread:<company id>"] }`
   to `/wake`. When somebody creates a company, it `POST`s the event to
   `/emit`. Both send `Authorization: Bearer <secret>`.

7. **Try it in the dev loop.**

   ```bash
   pnpm dev:loop:agent                # starts the fake CRM with the stack
   pnpm dev:seed                      # installs it; the install probes for protocol 2
   ```

   Save these two automations (`pnpm dev:movement provision --file <file>`):

   ```
   import { manual, acme_crm } from adapters
   crm = acme_crm()
   runs = manual()
   function crm_review(go: <runs-[:Invocation]->>) {
     c = write crm-[:Company]-> { Name: "Vireo Robotics" }
     r = await FIRST(c-[:Comments]->)
     write crm-[:Company]-> { Name: "Vireo Robotics (reviewed)", Description: COALESCE(r.Text, "no comment") }
   }
   listen to runs {} fire crm_review
   ```

   ```
   import { acme_crm } from adapters
   crm = acme_crm()
   function crm_intake(e: <crm-[:Company]->>) {
     write crm-[:Company]-> { Name: "Seen: ${e.Name}" }
   }
   listen to crm {} fire crm_intake
   ```

   Then:

   ```bash
   pnpm dev:movement run crm_review                                  # writes company-1, then waits
   pnpm dev:inspect crm                                              # the wait, keyed thread:company-1
   pnpm dev:inject crm-comment --company company-1 --text "approved" # the CRM pushes wake; the run finishes
   pnpm dev:inject crm-company --name "Larch Bio"                    # the CRM pushes emit; crm_intake runs
   pnpm dev:inspect crm                                              # every company the CRM holds
   ```

## Changes

- **Conformance CLI.** `pnpm adapter:conformance` checks a server against this protocol; run it first when building an adapter ([Build your first adapter](#build-your-first-adapter)).
- **Version 2** (current; the only version this release speaks). Breaking for a server built against version 1:
  - Requests carry `protocolVersion: "2"`, and the `manifest` answers `protocolVersion: 2`. Installing probes the server and refuses anything older.
  - Names on the wire are the natural display names; `typeId` and `fieldId` are the server's own ids.
  - Params are validated, and a mismatch answers `bad_request` naming the path.
  - New: awaits (`resolveAwait`, `wakeKeys`), the two push doors (`emit`, `wake`), paging (`iterateRelatedPage`), and files by URL.
  - A webhook subscription must return a secret, and deliveries are signed.
  - Clarified within version 2 (no bump; the reference adapter declares no file field, and conformance is unchanged for it): a file is read only at a field the catalog declares `kind: "file"` or in a resource's `fileRef`; a file ref anywhere else is data. File refs Listen-Fire sends (in a write, a position's resources, evidence) name no credential. The CLI gains `files-declared`.
- **Version 1**: the first protocol. Not supported: an install that answers it is refused, naming the version.
