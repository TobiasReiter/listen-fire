import type { Chapter } from '../types';

export const events: Chapter = {
  id: 'events',
  title: 'Events and waits: telling Listen-Fire something happened',
  content: `## Events and waits: telling Listen-Fire something happened

Two things flow from your system to Listen-Fire: **events** (a record was
created — run the automations listening for it) and **wakes** (something an
automation is waiting on happened — resume it). This chapter covers both,
and the two ways they reach Listen-Fire.

### Declaring what you announce

- An event type is an entry point with \`"fires": true\`, usually
  \`"readable": false\` (pushed, never listed). An automation listens with
  \`movement m(e: <crm-[:Company]->>) { … }\` and \`listen to crm {} fire m\`.
- \`listEventTypes\` maps your event tags to that type:
  \`\`\`json
  [ { "tag": "company.created", "positionType": "Company" } ]
  \`\`\`
- An edge an automation can wait on (\`await FIRST(c-[:Comments]->)\`)
  declares, on its reference in \`describe\`:
  - \`"awaitable": true\` — it may be awaited;
  - \`"watchable": true\` — you will wake waiting runs. Without it the
    automation is refused at save and told to poll;
  - \`"resolvesEmpty": true\` — the wait can end with nothing (the record
    was deleted); authors must then handle the absent case.

### resolveAwait: has it happened yet?

Listen-Fire keeps all the waiting state. You answer one question for a
record and an awaitable edge:
\`\`\`json
{ "recordId": "company-1", "edge": "Comments", "headData": { "Name": "Vireo Robotics" } }
\`\`\`
\`recordId\` is the id your \`createRecord\` returned; \`headData\` is the
\`data\` you returned with it. Answer one of:
\`\`\`json
{ "status": "pending", "correlationKey": "thread:company-1" }
{ "status": "landed", "correlationKey": "thread:company-1",
  "landings": [ { "recordId": "comment-1", "recordType": "Comment", "fields": { "Text": "approved" } } ] }
{ "status": "empty" }
\`\`\`
- \`correlationKey\` is **required** on \`pending\` and on \`landed\`: it is
  the key you will wake with. On \`landed\` it is used when no landing passes
  the automation's \`WHERE\`, and the run keeps waiting.
- \`empty\` is only allowed on an edge declared \`resolvesEmpty\`.
- Landing \`fields\` are read back through your \`getFieldValue\` for the
  landing's \`recordType\`.
- Listen-Fire calls it at the \`await\`, once more right after parking the
  run (so a wake that slipped in between is not lost), and on every wake.
  Keep it a cheap, current read that is safe to repeat.

### Way 1 — you push

Two doors, authenticated with the same header and secret Listen-Fire sends
you; the install whose secret matches is the team:
\`\`\`
POST {listen-fire}/api/public/adapter/{adapterType}/emit   { "events": [ { "payload": { }, "tag": "company.created", "externalId": "company-3" } ] }
POST {listen-fire}/api/public/adapter/{adapterType}/wake   { "keys": ["thread:company-1"] }
\`\`\`
- Both answer **202** \`{ "accepted": n }\`. For \`emit\`, \`n\` counts
  receipts — one per listen the event matched; an event nothing listens for
  counts 0. For \`wake\`, \`n\` is the keys queued; a key nobody waits on
  does nothing.
- **401** for anything unauthenticated (never 404). **409** when one
  secret matches installs on several teams: send the team's id in the
  \`x-listen-fire-team\` header. **400** for a malformed body — one bad
  event fails the whole \`emit\`. Retry on 5xx.
- 1 to 1,000 events or keys per call. Delivery is at least once, and
  \`emit\` is not idempotent: an event sent twice runs twice.
- An event's \`payload\` is the delivered record's data, read through your
  \`getFieldValue\`. The other fields (\`externalId\`, \`tag\`,
  \`eventType\`, \`changeType\`, \`recordType\`, \`actor\`,
  \`occurredAt\`, \`changedFields\`) are optional.
- While your push is open, Listen-Fire calls you back (\`listEventTypes\`).
  Never block your own server on its push.

### Way 2 — Listen-Fire receives your webhooks

If your system already sends webhooks:

1. Implement \`ensureEventSubscription\`
   (\`{ events, callbackUrl, current? }\` → \`{ externalId?, secret }\`).
   An empty \`events\` means everything you offer. **Return a secret** — a
   subscription without one is refused and withdrawn.
2. \`POST\` each webhook to \`callbackUrl\` with header
   \`x-listen-fire-signature\`: the lowercase hex HMAC-SHA256 of the exact
   raw body, keyed by that secret. There is no replay protection.
3. Implement \`preprocessInbound\` (\`{ raw }\` → \`{ events }\`) and
   \`wakeKeys\` (\`{ raw }\` → \`["thread:company-1"]\`). Listen-Fire calls
   both, and \`listEventTypes\`, while your delivery is still open. A failing
   \`wakeKeys\` never costs a delivery its events.
4. Implement \`removeEventSubscription\` (\`{ callbackUrl, externalId? }\` →
   \`null\`).

The two ways are independent and unordered; use one or both.`,
};
