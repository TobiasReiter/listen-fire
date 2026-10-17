# ev3-otherdoors report (D3)

Branch `ev3-otherdoors` from 30843618. Nothing pushed.

## Done
- Golden corpus first: 17 Mailgun inbound cases and 4 Mailgun event cases (`recordings/mailgun.json`, `mailgun_events.json`), recorded from the old doors. The harness gained fakes for the service-address table, the Directory and routing-key triggers, so Mailgun runs through the real routing code.
- Mail core `packages/movement-engine/services/inbound/mail.ts` (+ `svix.ts`, moved from apps/api): `admitMailgunMail`, `admitResendMail`, `judgeMailgunEvent`, envelope readers, `parseEmailAddress`. The platform keeps only its signing-key rules and sender-keyed routing (`inbound_door.ts`).
- Shared doors: `services/inbound/shared.ts` (`SharedDoor` = verifier + intercepts, `admitShared`). Slack Events and the Telegram bot declare one and admit through it.
- emit/wake over 1 MB now answer the JSON 413.
- All exported from `public/inbound.ts`.

## Deliberate fixes (golden diffs read)
1. `adapter_doors/emit-over-1mb`: HTML 413 -> `{"error":"payload_too_large"}` 413.
2. `mailgun_events/signature-of-another-length`: 500 -> 406 (timingSafeEqual threw; Mailgun retries 5xx).
3. `mailgun_events/no-signature-object`: 500 -> 406 (same reason).
Nothing else in any recording changed.

## Decisions
- No Svix or Mailgun scheme added: protocol.ts is ev3-kit's. Resend and Mailgun are core functions behind store interfaces; Svix is also usable as a `verifyInbound` escape hatch when the kit wants it.
- "Fan-out to intercepts": read as admission (intercepts + key + signature) declared as data in the core. The fan-out itself (by sender identity or Slack team_id) is a directory/DB lookup and stays in apps/api.
- Telegram still parses JSON before checking the secret (a recorded behaviour), so `admitShared` is called by each door in its own order.
- Resend and Mailgun stay lenient/strict exactly as before; no per-door rule changed (both already refuse a missing secret).

## Tests
- Scoped unit: services/inbound, interfaces/rest, webhook_sync, adapters/email, r_routing, scripts/dev, middleware/authentication: 61 suites, 675 tests pass. Golden: 26. New mail/shared unit tests: 24. New contract case (push body over 1 MB, both verbs) runs under the express doors.
- Type-check clean: movement-engine, apps/api (oracle + boundary guard, baseline 799 unchanged), apps/cli.
- No integration tests, no dev loop.

## Outside my stream
- `adapters/email/index.ts` (imports `parseEmailAddress` from the package), `interfaces/rest/private.ts` (reader imports), `expressOverrides.d.ts` (type import), `scripts/dev/lib/resend-sign.ts` (comment) and two dev test imports. All import-path changes.
- `inbound/contract.ts` gained one case: ev3-lfdoors' `lf serve` must answer the JSON 413 on emit/wake when it runs this suite.
