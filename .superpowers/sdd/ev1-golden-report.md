# ev1-golden report (stream D0)

Branch ev1-golden, cut from 4ba5f821. No handler was changed.

## What exists
`apps/api/src/services/inbound/__golden__/`
- `cases/*.ts`: 10 door groups, 174 request cases (method, path, headers, body; signatures computed from test secrets in `secrets.ts`).
- `recordings/*.json`: what today's handlers answered (status, content-type/length, body bytes) and the effects each case had (captured, queued, fired, sent).
- `inbound_golden.unit.test.ts`: replays every case through the real routers over HTTP and compares byte for byte. `GOLDEN_RECORD=1` re-records.
- `recordings/webhook_target_urls.json`: `buildWebhookTargetUrl` for every webhook provider key, a remote install key, and the key of every registered adapter.
- `recordings/mount_paths.json`: each inbound router's route table plus the mount lines as written in server.ts, rest/index.ts, valuations/index.ts, webhooks/index.ts.

## How it is faked
Routers, body parsers, signature verification, the webhook-sync pipeline and the Resend door are real. Faked: the DB query builder, adapter resolution, trigger lookup and receipt capture/enqueue, wake queue, work drain, callback and ask stores, Telegram/Slack/WhatsApp service entry points, outbound sends (Telegram adapter, Meta API, Slack response_url), clock (Date only).
Two test-only mounts exist in `app.ts`: the WhatsApp door built with no app secret (the production router reads its secret at import), and the Resend door behind a shim for the auth funnel.

## Behaviours worth Henry's attention (recorded as-is, not fixed)
- WhatsApp POST with a signed body whose `object` is not `whatsapp_business_account` is never answered (request hangs).
- BYO WhatsApp through webhook-sync ignores Meta's own `x-hub-signature-256`; it only reads the header chain (`x-webhook-signature` for that provider).
- A receipt whose work row fails to queue is logged and the delivery is still acked 200; only a failing wake enqueue or wakeKeys gives a 500.
- The first present header in the chain decides, so `x-listen-fire-signature` shadows a good `attio-signature`.
- Raw parser limit is 100 KB: larger bodies get express's HTML 413 before any route runs; adapter doors allow 1 MB.
- `/api/public/slack/events` and Telegram shared bot answer 200 with an error body on handler bugs (no retry storm).

## Not covered
- Mailgun inbound (`/api/mailgun/callback`) and the Mailgun event sink: not in the brief's list; routing there is not mockable without a deeper seam.
- Adapter `preprocessInbound` per provider is faked (the corpus pins the door, not each adapter's parsing).
- valuations `/v1/valuations/webhooks` is the destination management API (authenticated), recorded with a faked query builder; the inbound side for valuations is the `NATIVE_VALUATIONS` webhook-sync provider.

## Verification
- `pnpm test:unit --testPathPattern 'inbound/__golden__'`: 22 tests (10 groups x 2, plus 2 snapshots), run three times, stable.
- Mutation check: changing a status code in webhookSync.ts and the webhook-sync URL path in urls.ts each fail the replay.
- `pnpm code:type-check` (apps/api) clean; eslint on the directory clean.
