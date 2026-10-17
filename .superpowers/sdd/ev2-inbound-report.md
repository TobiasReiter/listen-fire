# ev2-inbound report — D1, one inbound-doors core

Branch `ev2-inbound` from da4342f9. Commits: d46ef2e6 (core + adapters + corpus), e16a7888 (CHANGELOG), plus this report.

## Done
- Core in the engine package (no apps/api dependencies), exported from `packages/movement-engine/public/inbound.ts`:
  - `services/inbound/verify.ts`: the seven declarative schemes (the INBOUND_SIGNATURE_SCHEMES names), each the exact check its door ran; `verifyInbound` (escape hatch or scheme); `authenticateInbound` (key set: verify; key unset: the host's no-secret rule).
  - `services/inbound/deliver.ts`: `receiveDelivery` (the pipeline over `InboundStore`) and `answerDelivery` (the HTTP answer, framework-free; `PAYLOAD_TOO_LARGE`; `answerIntercepts` for Slack's url_verification).
  - `services/inbound/push.ts`: emit and wake over `PushStore`.
  - `services/inbound/contract.ts`: 28 HTTP-level cases plus an in-memory reference store (the world is plain data, so lf and Rust can build it).
- apps/api thin adapters:
  - `services/webhook_sync/handler.ts` is the platform `InboundStore`; `services/inbound/legacy_signature_headers.ts` is the frozen table (today's chain per provider minus `x-listen-fire-signature`).
  - `interfaces/rest/webhookSync.ts` and `adapterDoors.ts` are router factories over a store; `services/webhook_sync/adapter_doors.ts` is the platform `PushStore`.
  - Slack events, Slack actions, Telegram shared bot and the WhatsApp door verify through the core.
  - Providers lost `verifySignature`.

## The three deliberate fixes (golden cases re-recorded; I read each diff, nothing else changed)
1. `attio-remote-header-ignored-for-builtin`: 401 → 200.
2. `receipt-enqueue-failure-is-isolated`: 200 → 500 (the wakes are still queued).
3. `body-over-100kb`: HTML 413 → `{"error":"payload_too_large"}` 413.
- Also `mount_paths`: the webhook-sync mount line in server.ts loses its `express.raw(...)`, because the router now brings its own parser plus the 413 handler. An error from a parser placed in front of the router never reaches the router's handlers, so the mount line had to change. Every path and route table is unchanged.
- `webhook_target_urls`: unchanged. No migration.

## Decisions
- Core in the package, not apps/api (the brief preferred this, and D2 can use it).
- Schemes keep each door's leniency, so no signature changes:
  - `attio` and `airtable_mac` verify with an empty secret.
  - `affinity_hex_or_b64` accepts any delivery when no key is set.
  - `hmac_sha256_hex` is WhatsApp's: optional `sha256=` prefix, refuses an empty secret.
  - The native outbox providers use `attio` (behaviour identical).
  - A bring-your-own Telegram bot uses the escape hatch `() => true`, as before.
- `attio-first-header-in-chain-wins` stays 401: the first header present still decides, as the protocol says.
- A module's `WireInboundDeclaration` is already a valid `InboundVerifier` (structurally), so A-wave modules can hand theirs straight to the core.
- `webhook_sync_route.unit.test.ts` was deleted. Its cases (queue before ack, 500 on queue failure, harness drain, refusal codes, Slack challenge) are now contract cases run against the express doors.

## Not done / flags for Henry
- Emit/wake: a body over 1 MB still gets express's HTML 413. It is outside the brief's three fixes; it is a one-line change with `inboundBodyRefusals`.
- Resend (Svix) and Mailgun are untouched: there is no scheme for them. They stay on their own door until D3.
- The shared Telegram bot and Slack app fan-out pipelines stay bespoke; only their verification moved.
- Before modules declare schemes: should the core refuse an empty or placeholder (`pending`) secret for every scheme? That would tighten `attio`, `airtable_mac` and `affinity_hex_or_b64`, which is a behaviour change, so I did not make it.
- Integration tests were not run: the worktree has no apps/api/.env (DATABASE_URL_TEST), and the rules forbid copying it. `inbound_work.integration` was updated (it type-checks) but has not been executed.

## Tests (done tier)
- `services/inbound/`: 64/64 (golden 22, contract 28, schemes 14).
- Scoped set across webhook_sync, interfaces/rest, whatsapp, body parser, public entries and r_routing: 380/380 after updating capture_then_ack to fix #2.
- Type-check clean: movement-engine, apps/api (with the oracle config and the boundary guard), apps/cli.
- Engine boundary baseline lowered 813 → 806.

## Files outside the stream
- `apps/api/src/server.ts`: the one mount line.
- `scripts/engine-boundary-baseline.json`: lowered.
- `packages/movement-engine/public/inbound.ts`: four export lines added (a wave-1 entry; inbound is this stream).
