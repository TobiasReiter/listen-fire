import type { Chapter } from '../types';

export const protocol: Chapter = {
  id: 'protocol',
  title: 'The protocol: transport, auth, and methods',
  content: `## The protocol: transport, auth, and methods

A remote adapter is **one HTTP endpoint** that answers JSON-RPC-style
calls. This chapter is the wire contract: how requests and responses are
framed, how the endpoint authenticates, and the full table of methods
you may implement.

### Transport contract

- **One endpoint.** All methods POST to a single URL (your \`baseUrl\`).
  The method name is in the request body, not the path.
- **Request body** (\`application/json\`):
  \`\`\`json
  { "protocolVersion": "1", "method": "describe", "cacheScopeId": "<opaque>", "params": { "typeId": "Company" } }
  \`\`\`
  \`protocolVersion\` is always \`"1"\`. \`cacheScopeId\` is an opaque
  string you may use to scope any per-call caching; you can ignore it.
- **Response body** — always one of these two, and (importantly) **both
  use HTTP 200**:
  \`\`\`json
  { "ok": true,  "result": <method-specific result> }
  { "ok": false, "error": { "code": "string", "message": "string", "retryable": true } }
  \`\`\`
  Return \`ok:false\` for application-level failures — Listen-Fire decides
  whether to retry based on \`retryable\`. Reserve non-200 status codes
  for genuine transport faults:
  - **401** — authentication failed (see below).
  - **400** — malformed request body.
- **Auth** is checked on every request.

### Authentication

Listen-Fire sends your secret in a header on every request. Pick ONE strategy
and declare it in the manifest:

- \`bearer\` → header \`Authorization: Bearer <secret>\`
- \`shared_secret\` → a header of your choosing (default
  \`X-Adapter-Secret\`), value \`<secret>\`

Your server checks that header and returns **401** if it is missing or
wrong. The secret is entered into Listen-Fire separately (at install time) and
stored encrypted — **it never lives in the manifest**.

### Methods to implement

For a **write-target CRM** (Listen-Fire pushes records into it), implement the
methods below. Each row gives the \`params\` you receive and the
\`result\` you return (inside the \`ok:true\` envelope).

| Method | params | result |
|---|---|---|
| \`manifest\` | \`{}\` | your manifest result (see below) |
| \`listEntryPoints\` | \`{}\` | array of entry points (see the schema chapter) |
| \`describe\` | \`{ typeId }\` | a type descriptor, or \`null\` if unknown |
| \`resolveEntity\` | \`{ record, recordType, candidates, constraints }\` | \`{ candidates: ExternalRecordRef[] }\` |
| \`getFieldValue\` | \`{ position, fieldId }\` | the field's value (any JSON), or \`null\` |
| \`getRelated\` | \`{ position, fieldId, direction }\` | array of related results (\`[]\` if none) |
| \`createRecord\` | write input (below) | write result (below) |
| \`updateRecord\` | write input **+ \`externalId\`** | write result **+ \`association\`**, OR \`{ "notFound": true }\` |
| \`deleteRecord\` | \`{ recordType, externalId, mutationContext }\` | \`{}\` (optionally \`{ events: [] }\`) — for a type whose descriptor says \`"deletable": true\` |

\`deletable\` is an additive descriptor field, so the protocol version
is unchanged and an adapter written before it still works. But its absence
means "this type cannot be deleted": under language version 5 (Dancing
Wren) every \`delete\` of a record of your system is refused while it is
authored until your \`describe\` says \`"deletable": true\` on the
types your \`deleteRecord\` removes. Movements pinned to version 4 or
earlier are unaffected.

If your system is read-only, implement \`getFieldValue\` /
\`getRelated\` for real and stub the writes. If it is write-only (a pure
sink), implement the writes, return \`null\` / \`[]\` from the read
methods, and mark entry points \`readable: false\`.

**Optional methods** (implement only if relevant; omit from
\`manifest.methods\` and Listen-Fire will not call them): \`readRecord\`
(enables no-op detection on updates — recommended), \`iterateRelated\`,
\`getDedupRules\`, \`translateFilter\`, \`describeOpaqueId\`,
\`invokeFieldFunction\`, and the inbound/event methods
\`preprocessInbound\` / \`listEventTypes\` / \`getActorCandidates\` /
\`extractActor\` / \`resolveFileRef\`.

### The manifest method result

\`\`\`json
{
  "adapterType": "acme_crm",
  "supportedTriggers": [],
  "runtimeCapabilities": { "traversal": { "incoming": false, "edgeProperties": false }, "resources": false },
  "methods": ["listEntryPoints","describe","resolveEntity","getFieldValue","getRelated","createRecord","updateRecord","deleteRecord"],
  "webhookEventTypeId": null
}
\`\`\`
\`methods\` MUST list exactly the methods you implement — Listen-Fire prunes
calls to anything absent.

### resolveEntity (matching / dedup)

Listen-Fire calls this to decide whether an incoming record matches an
existing one (so it updates rather than duplicates). You are given the
incoming \`record\`, its \`recordType\`, a list of \`candidates\`, and
the \`constraints\` (an OR-of-AND set of field names that define
identity). **Always return an object** of the form
\`{ "candidates": [ ...ExternalRecordRef ] }\` — put the matching records
in the array, and return \`{ "candidates": [] }\` when nothing matches
(do NOT return a bare \`[]\`). A correct-but-minimal implementation may
always return \`{ "candidates": [] }\` (Listen-Fire then creates) — but real
matching prevents duplicates.

An **\`ExternalRecordRef\`** is the flat record-reference currency used
in results:
\`\`\`json
{ "adapterType": "acme_crm", "externalId": "<your id>", "recordType": "Company", "url": "https://...", "data": { } }
\`\`\`

### Write input (createRecord / updateRecord)

\`\`\`json
{
  "recordType": "Company",
  "fields": { "Name": "Vireo Robotics", "Stage": "Seed" },
  "mutationContext": { "source": { }, "occurredAt": "2026-07-08T12:00:00Z" },
  "parentLinks": [ { "recordType": "Deal", "externalId": "d_1", "edgeName": "company" } ],
  "externalId": "<present on updateRecord only>"
}
\`\`\`
- \`fields\` is keyed by your **natural field names** (the
  \`displayName\`s from \`describe\`). Create or update the record
  accordingly.
- \`parentLinks\` (optional) are edges to attach — connect the record to
  those parents via the named edge. They arrive on \`updateRecord\` too:
  a record that already existed still has to end up attached, and an
  empty \`fields\` bag with a parent link means exactly that — attach it,
  change nothing else.
- On \`updateRecord\`, if the \`externalId\` no longer exists, return
  \`{ "notFound": true }\` (do not throw).

### Write result

An \`ExternalRecordRef\` for the record you created or updated.
\`externalId\` is your system's id for it; \`data\` may echo computed
fields; \`url\` is optional.

An \`updateRecord\` result carries one more field, and it matters: say
what became of each \`parentLink\` you were handed.

\`\`\`json
{ "adapterType": "acme_crm", "externalId": "c_9", "data": { }, "association": "made" }
\`\`\`
- \`"made"\` — the record was not attached to that parent and now is.
- \`"already"\` — it was already attached; you sent nothing.
- \`"unsupported"\` — your system cannot attach an EXISTING record along
  that edge. Listen-Fire fails the run and names the edge, rather than telling
  the author a relationship exists when it does not.
- \`"none"\` — the write named no parent.

Omit it and Listen-Fire reads the silence as \`"unsupported"\`: a write that
named a parent fails rather than claiming a link you never confirmed. A
connector with no parent edges never sees a \`parentLink\`, so it is
free to omit the field.`,
};
