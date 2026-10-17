# ev3-lfdoors report (D2: lf onto the inbound core)

Done. Branch ev3-lfdoors from 30843618.

## What changed
- apps/cli/src/doors.ts: lf's two store interfaces for the core (InboundStore, PushStore) over the session; the old hand-written verify/emit/wake is gone. Also `/hooks` target mapping, `deliverInline`, `receiveWebhook` (moved from runs.ts, which no longer verifies anything itself).
- apps/cli/src/serve.ts: routes `/api/public/webhook-sync/<provider>/<install>` (100 KB limit, as hosted), `/api/public/adapter/<external>/{emit,wake}` and `/hooks/...` through the core's answerDelivery/answerEmit/answerWake.
- Verification: manifest `inbound` (scheme, headers, intercepts) first; else the yaml `webhook:` block as scheme `remote`. Secret field: yaml `secretField`, else `webhook_secret`.
- Signed-inbound rule: missing, empty or "pending" secret gives a verifier that refuses everything. Enforced in lf's store (not in the core, to keep inbound/* untouched).
- Pull cursor: new SQLite table `inbound_checkpoint` in state.ts (old state files gain it via `create table if not exists`).

## Decisions
- `/hooks` keeps its legacy answer (202 `{runs}`, events run inside the request) so existing projects and the Rust-lf-shared tests are unchanged; the canonical door queues and answers 200 `{ok, eventsProcessed}`. Error bodies now carry core codes.
- No receipts in lf: capture returns the event; the durable step is the `fire_event` work row.
- No `listEventTypes` call on delivery (lf routes by the event; saves an RPC).
- Contract case "synthetic subscription" is skipped on lf (no test-harness team). Named in the test.

## Tests
- apps/cli: inbound_contract.test.ts 28 pass + 1 skip (the whole shared suite against real `lf serve`); inbound_lf.test.ts 4 pass (declared scheme, signed-inbound rule, /hooks + canonical door, cursor). Full apps/cli suite: 216 tests, 204 pass, 0 fail, 12 skipped. `tsc --noEmit` clean in apps/cli.
- No integration tests, no dev loop.

## Files outside the stream
- apps/cli/src/state.ts (table + two methods), externals.ts (`inbound` on RunningExternal), runs.ts (receiveWebhook removed), main.ts (import).
