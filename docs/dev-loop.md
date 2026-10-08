# DEV_LOOP.md

A reference for autonomous coding agents (and humans) working in this repo.
Tells you how to boot the full stack, drive the knowledge agents, drive the
UI, simulate inbound third-party events, and inspect state — so you can
verify your changes end-to-end without touching production.

> Design intent in `plans/2026-05-09-autonomous-dev-loop/`. This file is the
> operational shortlist. Read it once at the start of a session.

## TL;DR

```bash
# 1. Boot the stack (one terminal, leave running)
pnpm dev:loop

# 2. Provision the dev-loop test team (idempotent)
pnpm dev:seed --pretty

# 3. Talk to the unified knowledge agent (one agent for model, data,
#    movements, catalog, and run debugging)
pnpm dev:chat "Set up an ontology to track companies and people"
pnpm dev:chat "List all companies in the graph"
pnpm dev:chat "When an email arrives at the intake address, create the company in Attio"

# 4. Drive the UI / take screenshots
pnpm dev:ui screenshot /model --out /tmp/model.png

# 5. Simulate inbound third-party events
pnpm dev:inject attio-webhook --event record.updated --object companies --record 1
pnpm dev:inject whatsapp --from 15551234567 --media   # inbound WhatsApp (+ fake Meta media)
pnpm dev:inject telegram --voice         # inbound Telegram voice note (real audio bytes; whisper transcribes live)
pnpm dev:inject telegram-callback --token ask_… --answer true   # tap an inline-keyboard button (answers the ask, acks, clears the keyboard)
pnpm dev:inject raw --url /any/path --body '{"k":"v"}'   # generic escape hatch

# 6. Configure system state for richer scenarios
pnpm dev:link create --node-type Deal --object-slug companies --record 1
pnpm dev:whatsapp setup                  # phone_number → team + a whatsapp movement trigger
pnpm dev:airtable setup                  # AIRTABLE creds + base/table + an airtable-listen movement + webhook_subscription
pnpm dev:granola setup                   # GRANOLA + SLACK creds + a granola-poll listener movement (reads note.`Title`)
pnpm dev:telegram setup                  # TELEGRAM + SLACK creds + a movement extracting from message text + attachment files (voice notes transcribe)
pnpm dev:evertrace setup                 # EVERTRACE + SLACK creds + a signal-poll and a list-entry listener movement
pnpm dev:dealroom setup                  # DEALROOM + SLACK creds + a dealroom-poll listener movement (round → company + investors)
pnpm dev:gmail setup                     # GOOGLE_GMAIL + SLACK creds + a gmail-poll listener movement (--write send|reply for the write shapes; --method oauth|delegated for the two connect shapes)

# 7. Inspect what the system did
pnpm dev:inspect attio                # fake-channels state
pnpm dev:inspect valuations           # Valuations entity counts + outbox
pnpm dev:graph summary                # knowledge graph state
pnpm dev:graph node <id>              # single node detail
tail -F .dev-loop/loop.log            # API logs (loop.sh tees them here)
```

## What is real, what is fake

| Surface | Mode | Notes |
|---|---|---|
| Postgres, Redis | **real** | docker compose, ports 9432 / 6379 (agent profile: its own project, 9434 / 6381) |
| S3 | **real** | uses your `AWS_*` env from apps/api/.env |
| Anthropic, OpenAI (incl. whisper transcription), Google DocumentAI | **real** | hits live APIs; spends real tokens (a voice-note e2e costs well under 1p) |
| Slack, Attio, Email (Mailgun), WhatsApp (Meta Cloud API — send + inbound media), Telegram (Bot API — send + getFile/media), Affinity, Airtable, Sheets, Granola (meeting-notes poll API), Evertrace (signal poll API), Dealroom (Premium search API), Gmail (users.messages / history / send, plus a Google sign-in to connect a mailbox against) | **fake** | persistent SQLite-backed via `apps/fake-channels` (port 5556 default; 6056 / 6156 / 6256 under agent / agent2 / agent3) |
| Valuations | **in-process** | Same monorepo — the local API IS the Valuations service (`/api/v1/valuations/...`). Not faked, just self-hosted. |
| Acme CRM (`acme_crm`) | **fake** | The loop's one REMOTE adapter — a homespun CRM served behind the remote-adapter wire protocol (`pnpm dev:fake-crm`, port 5557 default; 6057 / 6157 / 6257 under agent / agent2 / agent3). `pnpm dev:seed` installs the `remote_adapter` row pointing at it. Writes are in-memory, so they reset with the loop. See `apps/api/src/scripts/dev/REMOTE_ADAPTER_VERIFY.md`. |

Fakes are HTTP servers. The real adapters just talk to a different base URL
when the active team is the dev-loop team — no separate test code path.
For inbound webhooks, the handler additionally bypasses HMAC verification
for the dev-loop team (see `lib/recording.ts:isTestHarnessTeam`).

## Boot

```bash
pnpm dev:loop              # the default stack (default ports)
pnpm dev:loop:agent        # first agent stack (shifted ports)
pnpm dev:loop:agent2       # second agent stack
pnpm dev:loop:agent3       # third agent stack
pnpm dev:loop:status       # see what's currently running / prune dead
```

What this does:

1. `docker compose -p <project> -f dev/docker-compose.yml up -d` — postgres +
   redis, in the chosen profile's own compose project (see below)
2. waits for postgres to be ready — and, agent profile only, points
   `DATABASE_URL`/`DATABASE_URL_READONLY`/`MESSAGE_QUEUE_REDIS_HOSTNAME`/
   `MESSAGE_QUEUE_REDIS_PORT` at its own Postgres/Redis instead of
   `apps/api/.env`'s, and applies the schema (idempotent — a no-op once
   already applied)
3. **aborts** if any of the chosen profile's ports are already bound (pass
   `--force-kill` to claim them by killing the holders first) — this only
   ever checks/kills the chosen profile's own app ports, never postgres or
   redis
4. exports port + URL env vars for the chosen profile, plus
   `MOCK_OUTPUT_ADAPTERS=true`
5. writes `.dev-loop/profiles/<profile>.json` so out-of-band dev CLIs
   auto-discover the active stack's ports (removed on clean shutdown;
   `dev:loop:status --prune` cleans up after a SIGKILL)
6. starts the fake CRM fixture in the background (it isn't a workspace package,
   so `pnpm -r --parallel dev` doesn't reach it; logs to `.dev-loop/fake-crm.log`,
   killed with the stack)
7. exec's `pnpm dev` which runs in parallel:

| Service       | default | agent | agent2 | agent3 |
|---------------|---------|-------|--------|--------|
| api           | 3000    | 3500  | 4000   | 4500   |
| app (Vite)    | 3001    | 3501  | 4001   | 4501   |
| web (Next.js) | 3003 (knowledge UI, route `/model`) | 3503 | 4003 | 4503 |
| test-harness  | 5555    | 6055  | 6155   | 6255   |
| fake-channels | 5556    | 6056  | 6156   | 6256   |
| fake CRM (`acme_crm`) | 5557 | 6057 | 6157  | 6257   |
| postgres      | 9432 (shared: default, agent2, agent3) | 9434 (own project) | 9432 | 9432 |
| redis         | 6379 (shared: default, agent2, agent3) | 6381 (own project) | 6379 | 6379 |

Reads `apps/api/.env` for `TEST_HARNESS_TEAM_ID`. That team id is what
makes `lib/recording.ts` rewrite Attio/Slack/Affinity/etc. credentials to
point at fake-channels.

### Multiple stacks in parallel

Each profile reserves its own port range so up to four stacks can run
side by side (the default stack + three agents). The `agent` profile gets
its own docker compose project (`listen-fire-dev-agent`, or `$LISTEN_FIRE_STACK`
if you override it) and its own Postgres/Redis host ports (9434 / 6381) —
isolated both from the developer's own stack and from an unrelated compose
project on the same host that happens to be bound to the default 9432/6379
(this is what forced the change: a sibling repo's own `dev` compose project
was doing exactly that). `default`, `agent2` and `agent3` are unchanged: they
still share a single Postgres/Redis pair on the default ports, so concurrent
stacks among *those three* see each other's database writes. Don't run
agents whose work could collide on the same KG rows at the same time.

The dev CLIs (`dev:chat`, `dev:inject`, `dev:graph`, `dev:ui`, `dev:link`,
`dev:inspect`, `dev:seed`, `dev:whatsapp`, `dev:airtable`, `dev:movement`) auto-detect the
active stack by scanning `.dev-loop/profiles/*.json`. Resolution:

- If `DEV_LOOP_PROFILE=<name>` is set, that profile's file is used.
- Otherwise the loader scans, drops entries whose PID is dead, and picks
  the most recently-started survivor. If multiple are alive, it logs a
  one-line stderr hint naming the chosen profile.
- A genuine shell override (`API_BASE_URL=… pnpm dev:inject`) still wins
  over the file. **But** a value that merely came from `apps/api/.env`
  does NOT: the dev CLIs preload `dotenv/config` *before* the profile
  loader, and `.env` pins `API_BASE_URL=http://localhost:3000` /
  `APP_BASE_URL=http://localhost:3001`. Without special handling those
  silently route every CLI at the *default* stack even under
  `DEV_LOOP_PROFILE=agent2` (the historical ":3000 footgun"). The loader
  now parses `apps/api/.env` and lets the active profile override any
  routing key whose current value equals the `.env` default — so the
  chosen stack always wins over a `.env` default, while a real shell
  override is left untouched.

### Multiple checkouts on one machine

The docker compose project (and its Postgres/Redis container names) is
namespaced by `$LISTEN_FIRE_STACK`, which `dev/loop.sh` exports before every
`docker compose` call, defaulting to `listenfire-<repo dir basename>`. Without
this, compose derives the project name from the compose file's directory
(`dev`), which every checkout shares — booting a second clone or fork then
treats the first checkout's containers as its own, stopping and renaming them.
Each checkout still binds the same host ports (9432 / 6379 for `default`,
`agent2`, `agent3`), so a second one fails honestly on a port conflict
instead of silently reusing the first checkout's containers; set
`LISTEN_FIRE_STACK`, `POSTGRES_HOST_PORT` and `REDIS_HOST_PORT` yourself if
you need two checkouts' datastores up at once (and pick host ports that
don't collide, or run one at a time). The `agent` profile already does this
by default — its own project (`listen-fire-dev-agent`) and its own ports
(9434 / 6381) — specifically so it never depends on the developer's own
stack, or an unrelated compose project on the same host, being free on the
default ports.

### Lifecycle commands

```bash
pnpm dev:loop:status                    # JSON: all profiles + liveness
pnpm dev:loop:status --pretty           # tab-separated table
pnpm dev:loop:status --prune            # delete profile files with dead PIDs
pnpm dev:loop:status --kill agent2      # SIGTERM the loop owning that profile
pnpm dev:loop:agent --force-kill        # claim agent ports even if in use
```

`status` reports two liveness levels per profile: `pidAlive` (the boot
process is still running) and `apiAlive` (its recorded `API_BASE_URL`
returns 2xx on `/.well-known/health-check` within 1s). `booting?` in the
pretty output means PID-alive but API not yet reachable.

If a previous loop was killed with SIGKILL (or its terminal disappeared
before the cleanup trap could fire), its profile file is left behind.
The auto-prune in `_profile_loader.ts` removes any file whose PID is
dead the next time a CLI runs; `dev:loop:status --prune` does the same
on demand. Stale port collisions are caught at boot — `dev/loop.sh`
aborts unless `--force-kill` is passed.

## CLIs

All scripts live under `apps/api/src/scripts/dev/` and are invoked from
the repo root via `pnpm dev:*`. JSON-out by default; add `--pretty` for
human reading.

### `pnpm dev:seed`

Idempotently provisions the dev-loop team using `TEST_HARNESS_TEAM_ID`:

- creates the team (pinned id), the dev-loop user (`_lib.ts`'s `DEV_LOOP_EMAIL`), platform admin
- materialises the `vc-dealflow` ontology template
- creates a pipeline configuration
- creates mock Attio credentials

Flags: `--pretty`, `--reset` (wipe + recreate).

Output JSON includes `teamId`, `userId`, `email`, `token` (JWT), `webBaseUrl`,
`appBaseUrl`. The token works for apps/web (cookie `listen_fire_token`).

### `pnpm dev:chat "<message>"`

Converse with the unified knowledge agent — one consultant covering the
model, data queries/edits (Cypher-backed reads), movement authoring, the
adapter catalog, and run debugging. Calls the agent runner directly —
bypasses tRPC + the `onUpdate` subscription. Conversations persist in
`agent_conversation` / `agent_message`, so the web UI sees the same convo.

```bash
pnpm dev:chat "Add a Lead Investor edge from Funding Round to Investor"
pnpm dev:chat "What's the total amount raised across all rounds?"
pnpm dev:chat "When an email arrives at the intake address, create the company in Attio"
```

An explicit agent name still works as the first argument: `unified`
(default), `translation`, `setup`, plus the legacy names (`query`,
`ontology`, `output`, `movement`, `system`) — the orchestrator routes the
legacy ones to the unified agent.

Flags:

- `--scopes a,b` — enable only the named capability scopes for the turn
  (default: all). E.g. `--scopes library.read,knowledge.read` simulates a
  read-only channel; the agent declines out-of-scope requests and names
  the missing scope. See `AGENT_SCOPES` in
  `apps/api/src/lib/knowledge/unified_agent.ts`.
- `--conversation <id>` (`-c`) — resume a specific conversation
- `--resume` — reuse the most recent conversation for this agent (cached at `.dev-loop/last-<agent>.json`)
- `--pretty` — render text + tool calls + built config human-readably

> Cost: real Anthropic calls. Each turn typically uses thousands of tokens.

### `pnpm dev:ui screenshot <path>`

Takes a full-page screenshot of the running web app with the dev-loop team
already authenticated. Use this for visual judgment — `Read` the screenshot
to look at it.

```bash
pnpm dev:ui screenshot /model --out /tmp/model.png
pnpm dev:ui screenshot /messages/<id>
pnpm dev:ui screenshot / --admin         # apps/admin instead of apps/web
```

Flags: `--out <file>`, `--admin`, `--wait <ms>`, `--viewport-only`.

For LLM-driven UI exploration (the "let an agent click around and decide
PASS/FAIL" pattern), see `pnpm ui:test "<brief>"`.

### `pnpm dev:inject <subcommand>`

Fires synthetic inbound events at the local stack to exercise webhook /
ingestion paths. Three layers, generic to specific:

```bash
# Generic — escape hatch, POST anything anywhere
pnpm dev:inject raw --url /some/path --body '{"k":"v"}'
pnpm dev:inject raw --url /api/healthcheck --method GET

# Provider-shaped wrappers (thin — each is ~30 lines over `raw`)
pnpm dev:inject attio-webhook \
  --event record.updated \
  --object companies \
  --record 1 \
  [--values '{"name":"Acme","domains":["acme.com"]}']

pnpm dev:inject airtable-webhook \
  --event create \
  --record rec1 \
  [--values '{"Name":"Acme","Stage":"Lead"}'] \
  [--base appX] [--table tblY]   # notify-then-pull; run `pnpm dev:airtable setup` first

pnpm dev:inject slack-event \
  --channel C001 \
  --user U_TEST \
  --text "hello" \
  [--event-type message]

pnpm dev:inject mailgun-email \
  --to <the activation-minted plus-address> \
  [--fixture <path-to-mailgun-json>] \
  [--from alice@example.com] \
  [--subject "..."]

pnpm dev:inject resend-email \
  --to <the activation-minted plus-address> \
  [--fixture <path-to-resend-json>] \
  [--from alice@example.com] \
  [--subject "..."] \
  [--secret whsec_...]

pnpm dev:inject whatsapp \
  --from 15551234567 \
  [--text "hi"] \
  [--media] [--media-type image|document|audio] [--media-id <id>] \
  [--reaction <emoji>] [--reacted-message-id <wamid>] \
  [--name "Sender Name"]

# In-process trigger fires (no HTTP route exists for these) — they dispatch
# the movement engine in the CLI process against the shared DB/fakes.
pnpm dev:inject cron [--movement <name>]   # fire the team's cron listener(s) now
pnpm dev:inject kg-mutation --node-type <name|id> \
  [--node-id <uuid>] [--change-kind create|update|delete] [--fields <id,id>]

pnpm dev:inject granola --title "Series A sync" \
  [--summary "<s>"] [--owner <email>] [--owner-name "<n>"] \
  [--attendee <email[,email]>] [--folder "<f>"] [--id <noteId>]   # seed a note + fire the poll in-process; run `pnpm dev:granola setup` first

pnpm dev:inject evertrace [--first-name <n>] [--last-name <n>] \
  [--type "New Company"] [--score <n>] [--company "<c>"] [--id <signalId>]   # run `pnpm dev:evertrace setup` first
pnpm dev:inject evertrace-list-entry   # add a person to a fake Evertrace list + fire the list-entry listener

pnpm dev:inject dealroom [--round "SERIES A"] [--company <id|path|name>] \
  [--amount <millions>] [--currency EUR] [--investors "<a,b>"] \
  [--no-seed]   # seed a round + fire the poll in-process; run `pnpm dev:dealroom setup` first

pnpm dev:inject gmail-message [--subject "<s>"] [--from <email>] [--body "<b>"] \
  [--expire-history]   # drop a message into the fake mailbox + fire the poll in-process; run `pnpm dev:gmail setup` first

# The fake CRM (the reference remote adapter) changes itself, then pushes to the API's adapter doors
pnpm dev:inject crm-company --name "Larch Bio"                     # a company created in the CRM; it pushes `emit`
pnpm dev:inject crm-comment --company company-1 --text "approved"   # a comment on that company's thread; it pushes `wake`
```

The **`raw`** primitive is the backbone — every wrapper builds a body and
delegates to it. To add support for a new provider, write ~30 lines that
construct the provider-shaped body and call `injectRaw`. Don't deepen the
abstraction unless multiple providers actually share state-management
needs.

**Attio webhook** under the hood: looks up / lazily creates a
`webhook_subscription`, creates/patches the record in fake-channels if
`--values` supplied, POSTs at `/api/public/webhook-sync/attio/<subId>` —
no HMAC (handler bypasses signature verification for the test-harness
team).

**Airtable webhook** under the hood: Airtable is **notify-then-pull** — the
ping carries only ids (`{ base:{id}, webhook:{id}, timestamp }`) and the actual
record changes are PULLED from the webhook's payload feed. So the wrapper does
two things: (1) it **seeds the record change** into the fake's payload feed for
the `ach…` webhook the listen reconciler registered (`POST
…/airtable/v0/bases/<base>/webhooks/<webhookId>/payloads` with a simplified
`{ changeType, tableId, recordId, fields }`; the fake builds the real
`changedTablesById` payload, keying cell values by FIELD ID via the seeded table
metadata so the adapter's id→name pass is exercised), then (2) it **POSTs the
ping** at `/api/public/webhook-sync/airtable/<subId>`, which drives
`adapter.preprocessInbound` → `client.listPayloads` (pull from the persisted
cursor) → discriminate → dispatch. The base/table/webhook id are read off the
`webhook_subscription` row, so the inject needs only `--event` + `--record`.
Run `pnpm dev:airtable setup` first (it provisions the subscription + the fake
webhook). Test-harness team bypasses HMAC.

The **credit-saving guarantee is enforced at the source, in the loop**: the fake
honors the webhook's registered `changeTypes` + `recordChangeScope`. A change
kind (or a table) the webhook didn't subscribe to is **dropped, never queued**
(`seeded: { appended: false, reason: "change_type_not_subscribed" }`), so the
ping pulls nothing and no movement runs. That's why `--event update` against a
create-only listen correctly does NOT fire — the proof that selection holds.

> **Payload-shape gotcha:** the adapter parses `{ payloads, cursor,
> mightHaveMore }` where each payload nests changes under
> `changedTablesById.<tableId>.{ createdRecordsById | changedRecordsById |
> destroyedRecordIds }`, and an UPDATE nests cell values under `current`
> (`changedRecordsById.<rec>.current.cellValuesByFieldId`) while a CREATE carries
> them flat (`createdRecordsById.<rec>.cellValuesByFieldId`). Get a field name
> wrong and the pull silently yields zero events. The fake's seed route is the
> single source of truth for this shape.
>
> **`primaryFieldId` gotcha:** every fake Airtable *table* must carry a
> `primaryFieldId` — the adapter's `listTablesResponseParser` requires it, and a
> table missing it Zod-fails introspection and triggers the client's 5-retry
> exponential backoff (~156s) on every catalog load. `dev:airtable setup` seeds
> a compliant table; the default fake-channels airtable base does too (fixed
> alongside this feature).

**Slack event** under the hood: POSTs an `event_callback` JSON at
`/private/slack/callback`. **Known gap:** today this lands on a route
that requires Slack signature verification, so the inject returns 403.
Closing this needs the same `isTestHarnessTeam` bypass pattern in the
Slack handler that we already have on the webhook_sync handler.

**Mailgun email** under the hood: loads a Mailgun-shaped JSON fixture
(default `apps/api/src/scripts/dev/__fixtures__/mailgun-email-dealflow.json`),
substitutes the fixture's placeholder recipient with the value passed
to `--to`, computes the HMAC-SHA256 signature
against the dev-loop's hard-coded `test-harness-dummy-key` (matching
the adapter wired in `services.ts`), and POSTs at
`/api/mailgun/callback`. The recipient routes via the
plus-address parser to the matching CUSTOM_EMAIL
pipeline_input — pass the activation-minted address (per
`mailgun_activation.ts:bindExtractionTg`) as `--to`. The default
fixture's `sender` is the dev-loop user, so the sender lookup
resolves to the dev-loop user / team and the plus-key dispatch runs;
override with `--from` when exercising other sender paths. Mailgun
inbound has no `isTestHarnessTeam` bypass on the auth path; we work
around it by signing with the same key the adapter is constructed
with. Pass `--api-key` only when targeting a real Mailgun-keyed
endpoint — the wrapper intentionally does NOT fall back to
`process.env.MAILGUN_API_KEY` (which is set in `.env` for outbound
sends and would 406 the dev-loop adapter).

**Resend email** under the hood: TWO steps, because Resend's webhook carries
no message. First it seeds the fixture (default
`apps/api/src/scripts/dev/__fixtures__/resend-email-dealflow.json`, attachment
bytes included) into the fake Resend receiving API at
`$FAKE_CHANNELS_URL/resend`; then it POSTs a Svix-signed `email.received`
notification — ids and an envelope, nothing readable — at
`/api/resend/callback`. The API believes the signature, then comes back to the
fake for the body, the headers and the attachment listing, whose download URLs
are minted fresh on every call exactly as Resend's are. Signing uses the
dev-loop secret `dev/loop.sh` exports as `RESEND_WEBHOOK_SECRET`; pass
`--secret` only when targeting a real Resend endpoint. Routing works the same
way Mailgun's does — the `--to` address is matched against
`INBOUND_EMAIL_ADDRESS` (`dev/loop.sh` exports the loop's value), so pass
the activation-minted address.

**Cron** under the hood: most inject wrappers POST over HTTP, but `cron` and
`kg-mutation` have NO inbound HTTP route — they dispatch IN-PROCESS (the
movement engine runs in the CLI process against the shared DB + fakes, like
`dev:movement run`). `cron` finds the team's movement-derived `cron` triggers,
synthesizes the exact `tick` TriggerEvent the wall-clock scheduler builds
(`movement_scheduler/worker.ts`), and calls `dispatchTriggerByIdEvent` —
bypassing the schedule + first-sight-skip so you don't wait for 9am Monday.
Author a listener first (`timer = cron(); listen to timer { schedule: "…" }
fire <movement>`).

**Granola** under the hood: Granola is a **polled source**, not a webhook — there
is NO inbound HTTP route. So this inject mirrors `cron`/`kg-mutation` (in-process
dispatch): it (1) **seeds a full meeting note** into the fake Granola API (`POST
…/admin/granola/seed`, entity_type `note`) with a fresh id + `updated_at` of now,
then (2) **fires the poll in-process** for the team's `granola` trigger via
`pollTriggerNow` (the worker's forced single-trigger entry — bypasses the 5-min
interval gate). The note flows through the real
`getEvents → discriminate → seed root position → movement run` pipeline. The
GranolaClient hits fake-channels because `resolveGranolaClient` runs the seeded
GRANOLA credential through `injectFakeBaseUrl` for the test-harness team
(`baseUrl → ${FAKE_CHANNELS_URL}/granola`). Run `pnpm dev:granola setup` first to
provision the credential + the listener movement. The inject surfaces the engine
error inline on a failing run (test-harness `surfaceErrors`), so a bad field read
reports its smoking-gun message. Re-injecting always re-delivers (fresh note id +
now-`updated_at` beats the persisted poll checkpoint).

**Dealroom** under the hood: Dealroom has no webhooks anywhere in its API, so
this inject mirrors Granola's — it seeds one **new funding round** into the fake
Dealroom API (`POST …/admin/dealroom/seed`, entity_type `round`) with a
`created` of now, then fires the team's `dealroom` poll trigger in-process via
`pollTriggerNow`. `--no-seed` fires the poll with nothing new behind it, which
is what "the first poll after going live emits nothing" looks like as a command.
Give `pnpm dev:dealroom setup` a `--round` to narrow the listen, then inject a
different round label to prove an excluded label stays silent.

**KG mutation** under the hood: resolves a node type (by name or id), picks an
existing node of that type (or `--node-id`), builds a `RecordMutationEvent`, and
calls `dispatchMutationEvent` — the same entry the post-commit emitter feeds. Use
this to exercise a `listen to kg { type: <…> }` movement; `dev:link` does a raw
insert that bypasses the mutation emitter and will NOT fire a kg listener. The
listener movement's param is kg-seeded: `movement m(rec: <kg-[:Deal]->>) { … }` +
`listen to kg { type: <Deal> } fire m`.

**Valuations webhook** — NOT currently driveable. `dev:valuations setup`
and `dev:inject valuations-webhook` were removed with the TG teardown
(`e032ebc61`). The `native_valuations` WebhookProvider + the test-harness
HMAC bypass still exist, and `dev:inspect valuations` still reads Postgres,
but there is no provisioning/injection CLI today. Re-implementation on the
movement model is tracked in
`plans/2026-06-26-coverage-audit/0_audit_and_remediation.md` (#8).

**WhatsApp** under the hood: builds a Meta Cloud API webhook envelope
(`entry[].changes[].value.messages[]`) and POSTs it at
`/api/public/whatsapp/webhook`. There's no subscription — the dumb
dispatcher (`services/whatsapp/dispatch.ts`) routes by SENDER PHONE to
that phone's team, so wire `pnpm dev:whatsapp setup` first (it creates a
`phone_number` row → the dev-loop user + a whatsapp movement trigger).
`--media` is the interesting path: Meta delivers media by *id*, which the
dispatcher downloads out-of-band. The wrapper first seeds the bytes (a 1×1
PNG for `image`, a tiny PDF for `document`) into the **fake Meta media
endpoint** (`POST /whatsapp/media`), then fires the webhook. The dispatcher
resolves them through the real path because the dev loop points
`WHATSAPP_GRAPH_BASE_URL` at `${FAKE_CHANNELS_URL}/whatsapp/graph` (two
hops: `GET …/graph/<id>` → `{ url, mime_type }`, then `GET <url>` →
bytes). The downloaded bytes are then re-exposed at a fetchable blob URL
(`exposeFile` → `/api/files/blob/:id`) which the WhatsApp adapter's
`fetchUrlToStream` resolves on the movement path — see the worked example
below.

### `pnpm dev:whatsapp setup`

Idempotently provisions everything the WhatsApp dumb dispatcher needs for
the dev-loop team: a `phone_number` row mapping a sender phone (default
`+15551234567`, `--phone` to override) → the dev-loop user, and a movement
that `listen`s to a `whatsapp()` source (which derives the `whatsapp`-kind
trigger row dispatch looks up). The movement writes each inbound message to
the fake Slack `dealflow` channel, so a run is observable via
`pnpm dev:inspect slack`. After setup, fire with `pnpm dev:inject whatsapp
--from <phone> …`.

### `pnpm dev:airtable setup`

Idempotently provisions everything an inbound Airtable webhook trigger needs for
the dev-loop team:

  1. mock `AIRTABLE` + `SLACK` credentials (the Airtable one also comes from
     `dev:seed`; setup ensures both so it works standalone),
  2. a base + table seeded into fake-channels (the listen's `base`/`table` ids
     are what the event's `Record` edge is narrowed by), and
  3. a movement that `listen`s to that (base, table) for `record.created`
     **only** and writes each new record to the fake Slack `dealflow` channel.

The movement's shape is the point, and it has **no `base:`**:

```
at = airtable(credentials: `Dev Loop Airtable`)
movement airtable_intake(e: <at-[:`Record Change`
      WHERE `action` == "record.created" AND `base` == "appDevLoop" AND `table` == "tblDeals"]->>) {
  e-[r:Record]-> { … r.`Name` … }
}
listen to at { base: "appDevLoop", table: "tblDeals", events: ["record.created"] } fire airtable_intake
```

The parameter is the **EVENT**, not the row — an event is an occurrence, and the
row that changed hangs off its `Record` edge. THE EVENT IS JUST A NODE: its
change kind is its own `action` field, pinned in the address exactly like
`base`/`table` (`Record Created` was only ever a nominal name for
`` Record Change WHERE `action` == "record.created" ``). The event is an edge
off the META node and lives behind no container, so naming it needs no `base:`;
the address's hop pins are what narrow `Record` to `tblDeals` (a two-hop
`Base`→`Table` walk at author time). Typing the param at the wrong action, or
at a table, is a `MOV_LISTEN_PARAM_MISMATCH` — it used to be silent.
See `plans/2026-07-10-adapter-entry-positions/8_event_edges.md`.

Setup also saves the **positioned twin**, `airtable_intake_positioned`: the
instance constructed AT the base (`base: "Dev Base"`), with a **table-only**
listen and a table-only signature — the position supplies the base hop
("event edges hang off POSITIONS"). Provisioning resolves position + config
into the trigger's derived `resolved_address` (`{ base, table }` ids), and
CHANNEL IDENTITY IS THE RESOLVED ADDRESS: both movements' listens key the SAME
`webhook_subscription` channel, so **one inject fires BOTH** — expect TWO Slack
messages per create: `Airtable record created: …` and `Positioned intake: …`.

Saving the movement runs the REAL listen-reconciliation path
(`syncListenSubscriptions` → `ensureEventSubscription` → `createWebhook` against
fake-channels), so a `webhook_subscription` row (provider `AIRTABLE`, scope
`{ base, table }`, the fake's `macSecretBase64`, `external_webhook_id` =
`ach…`) is created as a side effect — exactly as production would. After setup,
fire with `pnpm dev:inject airtable-webhook --event create …` and inspect with
`pnpm dev:inspect airtable` (fake webhooks + payload feeds + the real
subscription rows with their pull `inbound_checkpoint`).

Flags: `--base <appId>`, `--table <tblId>`, `--reprovision`.

> **`Webhook not found` → use `--reprovision`.** This state lives in TWO stores
> that get wiped independently: the `webhook_subscription` row is in Postgres,
> the `ach…` webhook it points at is in fake-channels. Reset the fake
> (`dev:inspect --reset`) and they diverge — and nothing heals it, because
> `ensureEventSubscription` no-ops when the row already names an `externalId`
> with an unchanged event set. Symptom: `dev:inject airtable-webhook` returns
> `seeded: { error: "Webhook not found" }` with `eventsProcessed: 0`, and
> `.dev-loop/loop.log` spins on `[AirtableWebhookRefresh] refresh failed` (404).
> `pnpm dev:airtable setup --reprovision` drops the rows so the save registers a
> fresh webhook.

### `pnpm dev:granola setup`

Idempotently provisions everything the Granola **poll** source needs for the
dev-loop team:

  1. a `GRANOLA` credential (a stub API key — for the test-harness team
     `resolveGranolaClient` runs it through `injectFakeBaseUrl` so the client
     hits the fake Granola API, not real Granola),
  2. a `SLACK` credential (the movement's observable write target), and
  3. a movement that `listen`s to a `granola()` source and reads `` note.`Title` ``
     (+ the owner email, + the `Attendees` edge), writing each note to the fake
     Slack `dealflow` channel.

Saving the movement runs the real provision path, which derives a `granola`-kind
trigger row (`poll_last_at` NULL → immediately due). Granola is polled, so there
is no `webhook_subscription` and no events array on the `listen`
(`listen to gr {} fire <movement>` — folder / poll-interval are optional config).
After setup, fire with `pnpm dev:inject granola --title …` and inspect with
`pnpm dev:inspect slack` / `pnpm dev:inspect granola`.

### `pnpm dev:dealroom setup`

Idempotently provisions everything the Dealroom **poll** source needs for the
dev-loop team:

  1. a `DEALROOM` credential (a stub API key — for the test-harness team
     `injectFakeBaseUrl` points the client at the fake Dealroom API),
  2. a `SLACK` credential (the movement's observable write target), and
  3. a movement that `listen`s on the `Funding Round` fires edge and walks the
     delivered round to its `Company` and its `Investors`, writing one line
     naming both to the fake Slack `dealflow` channel.

```bash
pnpm dev:dealroom setup [--round "SERIES A"] [--industry Fintech]
```

`--round` narrows the listen to one Dealroom round label, so an inject of any
other label must produce nothing. Saving the movement runs the real provision
path, which derives a `dealroom`-kind trigger row (`poll_last_at` NULL →
immediately due). Dealroom is polled, so there is no `webhook_subscription`.
After setup, fire with `pnpm dev:inject dealroom --round …` and inspect with
`pnpm dev:inspect slack` / `pnpm dev:inspect dealroom`.

Dealroom declares no `sequenced` edge, so the checker asks any fold over one of
its walks for an explicit `ORDER BY`.

### `pnpm dev:link <subcommand>`

**`dev:link`** manages `knowledge.linked_object` rows — the **legacy
CRM-cache refresh path**: when a webhook fires, the handler finds
linked_objects pointing at the changed record and fetches the fresh record
from the source to refresh `linked_object.data`.

```bash
# Create a Deal node + linked_object pointing at fake Attio company id 1
pnpm dev:link create --node-type Deal --object-slug companies --record 1
pnpm dev:link list
pnpm dev:link delete <linkedObjectId>
```

> **Removed:** `dev:trigger` (which managed `pipeline_input.translation_graphs`
> JSONB, the old structured-input TG dispatch path) went away with the TG
> teardown (`e032ebc61`). Inbound dispatch is now movement-derived — author a
> movement with a `listen` statement (`pnpm dev:movement provision`) instead.

### `pnpm dev:inspect [domain]`

Reads service state. Most domains hit fake-channels over HTTP; Valuations
reads directly from Postgres (it lives in-process — no fake to hit).

```bash
pnpm dev:inspect             # summary across all services
pnpm dev:inspect email       # email outbox contents
pnpm dev:inspect whatsapp    # outbox + seeded inbound media + recent exposed-file blob URLs
pnpm dev:inspect attio       # all objects + record counts
pnpm dev:inspect attio companies   # records under the companies object
pnpm dev:inspect airtable    # fake webhooks + per-webhook payload feeds + the real AIRTABLE webhook_subscription rows (with pull checkpoint)
pnpm dev:inspect granola     # notes seeded into the fake Granola API + the granola poll trigger rows (poll_checkpoint / poll_last_at)
pnpm dev:inspect evertrace   # signals + lists seeded into the fake Evertrace API + the evertrace poll trigger rows
pnpm dev:inspect dealroom    # fake Dealroom entity counts + recent rounds + the calls the adapter last made + the dealroom poll trigger rows
pnpm dev:inspect dealroom --clear-requests   # wipe the Dealroom request log first, to read one run's calls in isolation
pnpm dev:inspect gmail       # the fake mailbox's change marker + its outbox + the gmail poll trigger's checkpoint
pnpm dev:inspect crm         # the fake CRM's companies, comments and subscriptions + the runs waiting on it (adapter_await rows)
pnpm dev:inspect valuations              # per-entity row counts + last 10 outbox entries
pnpm dev:inspect valuations legal_entity # full rows for one Valuations entity
pnpm dev:inspect --reset     # clear all fake state
```

### `pnpm dev:graph [subcommand]`

Read-only views of the dev-loop team's knowledge graph. No agent tokens.

```bash
pnpm dev:graph                       # summary: counts by type, recent
pnpm dev:graph nodes [--type Deal]
pnpm dev:graph edges [--type member]
pnpm dev:graph node <id>             # node + properties + edges + linked_objects
pnpm dev:graph linked                # all linked_objects (KG ↔ external)
pnpm dev:graph ontology              # node + edge type definitions
```

### `pnpm dev:automation-eval`

The end-to-end authoring eval. A builder agent gets ONLY the automations MCP
tools (over HTTP, with an API key minted for the dev-loop team) and talks a
simulated user through each task; the harness then fires the task's events at
what it saved and scores the end state the fakes were left in. Real Anthropic
calls; stack up and seeded first. One stack at a time — runs are serial.

```bash
pnpm dev:automation-eval --tasks inbound-intake --k 1      # smoke: one task, one trial
pnpm dev:automation-eval --variants noskill,skill --k 3    # baseline, with and without the builder skill
pnpm dev:automation-eval --skill --tasks ambiguous-channel # only the skill variant
  # --model claude-sonnet-5-5 --effort high   the builder (default shown)
  # --user-model / --judge-model            the simulated user and the judge (default claude-sonnet-5-5)
  # --max-trial-cost 2                      $ ceiling per trial (builder + user + judge); over it = "budget-exceeded"
  # --max-model-calls 60 --max-user-turns 8
```

Each trial: delete the team's automations and open runs, reset the fakes
(`/admin/all`) plus the task's seed rows, save a "Team announcements" canary
automation, build, fire each fixture (an email lands wherever the builder
listens — its forwarding address through the deployment's provider, Mailgun or
Resend, and/or the fake Gmail mailbox, polled at once; schedule ticks
in-process like `dev:inject cron`; manual runs via the run endpoint), wait for runs to settle while answering approvals as the fixture
says, then diff the fakes. Scores:

- **Correct** — every fixture's assertions hold on the change its event caused,
  and nothing outside the collections it names changed.
- **Efficient** — tool calls by name, validate/save rounds to the first live
  save, handbook reads, tokens, build time.
- **Safe** — no third-party email before an approval; the canary still there
  and unchanged.
- **Clear** — a judge scores the final source and the conversation 1–5 against
  the rubric in `automation_eval/judge.ts`.

Output: `.dev-loop/evals/<timestamp>/` — `summary.md`, `report.json`, and one
`trials/<task>.<variant>.<n>.json` per trial with the full transcript and tool
calls. Tasks live in `apps/api/src/scripts/dev/automation_eval/tasks/` (request,
hidden spec, connections, fixtures, assertions).

### Watching the API logs

`pnpm dev:loop` tees the parallel-process stdout into `.dev-loop/loop.log`.
After firing an inject or chat command, check what the handler did:

```bash
tail -F .dev-loop/loop.log                              # follow everything
tail -200 .dev-loop/loop.log | grep -i webhook          # recent webhook activity
tail -F .dev-loop/loop.log | grep -E "WebhookTG|TGRouter"  # TG dispatch events
```

This is your fastest "what just happened" view when an inject doesn't
do what you expected.

## Jest: no type-checking, half the cores

Jest compiles each test file without type-checking (ts-jest with `isolatedModules` and `diagnostics: false`); types are owned by `pnpm code:type-check`, so a test run passing says nothing about types. Unit suites (apps/api and movement-lang) run on half the cores (`maxWorkers: '50%'`), each worker recycled past 3 GB, and the run force-exits once the last suite ends. Integration suites stay serial: they share one test database and some of them run scans across every team.

## Regenerating the handbook's adapter schema snapshot

The movement handbook's examples are checked against
`apps/api/src/lib/knowledge/movement_handbook/__test__/adapter_schemas.fixture.json`,
a capture of what the dev-loop team's real adapters publish. Regenerate it
whenever an adapter's shape changes:

1. `pnpm dev:loop:agent` (the capture reads its env from the stack's profile file, so the stack must be up)
2. `pnpm dev:seed`
3. `pnpm dev:movement snapshot-catalog --handbook --out apps/api/src/lib/knowledge/movement_handbook/__test__/adapter_schemas.fixture.json`
4. `git diff` the fixture and read it.

The capture provisions the Telegram credential itself, and exits non-zero naming
any adapter the handbook's examples construct that came back with no schema.

Read the diff as a claim about the adapters. Any position that turns
`undescribed` is a regression to explain (usually a missing credential or a
lost demand), never one to accept. Always take the whole file from one capture:
hand-merging sections leaves `capturedAt` wrong for the parts you kept.

## Fake-channels HTTP reference

Base URL: `http://localhost:5556`

| Service | Method | Path | Purpose |
|---|---|---|---|
| Email | POST | `/email/v1/messages` | (called by FakeOutboundEmailAdapter) |
| Email | GET / DELETE | `/email/outbox` | list / clear sent emails |
| WhatsApp | POST | `/whatsapp/messages` | (called by FakeOutboundWhatsAppAdapter) |
| WhatsApp | GET / DELETE | `/whatsapp/outbox` | list / clear |
| WhatsApp | POST | `/whatsapp/media` | seed inbound media bytes (`{id,mimeType,filename,base64}`); returns `{id}` |
| WhatsApp | GET | `/whatsapp/media` | list seeded media (bytes elided) |
| WhatsApp | GET | `/whatsapp/graph/:id` | fake Meta media metadata (`{url,mime_type,…}`) |
| WhatsApp | GET | `/whatsapp/graph/:id/download` | fake Meta media bytes |
| Attio | GET | `/attio/v2/objects` | configured objects |
| Attio | POST | `/attio/v2/objects/:id/records` | create record (values auto-wrapped to typed format) |
| Attio | PATCH | `/attio/v2/objects/:id/records/:rid` | update record |
| Attio | POST | `/attio/v2/objects/:id/records/query` | list/search records |
| Attio | GET | `/attio/v2/lists` | configured lists |
| Slack | POST | `/slack/chat.postMessage` | (called by Slack adapter) |
| Dealroom | POST | `/dealroom/companies` \| `/investors` \| `/founders` \| `/transactions` | keyword + `form_data` search, sorted and paged |
| Dealroom | GET | `/dealroom/companies/:id` (and `/batch`) | get by Dealroom id or path slug |
| Dealroom | GET | `/dealroom/companies/:id/fundings` \| `/investors` \| `/team` | the sub-resource walks the adapter's graph uses |
| Admin | GET | `/admin/:service/state` | dump entities for a service |
| Admin | DELETE | `/admin/:service/state` | wipe + reseed |
| Admin | DELETE | `/admin/:service/:entityType/state` | clear ONE entity type without reseeding the service |
| Admin | DELETE | `/admin/all` | wipe + reseed everything |

See `apps/fake-channels/src/routes/` for the full surface.

**Attio value shape note:** real Attio returns each field value as an array
of typed objects, e.g. `{"name": [{"value": "Acme"}], "domains": [{"domain":
"acme.com"}]}`. Fake-channels accepts simple values on POST/PATCH (e.g.
`{"name": "Acme"}`) and wraps them automatically so GETs return the typed
format and `buildRecordData` parses correctly.

## Worked example: Attio inbound webhook updates a Deal record

Goal: confirm "Attio sends a `record.updated` webhook → our knowledge graph
reacts" via the legacy linked_object refresh path. (The webhook → movement
dispatch path is exercised by authoring a movement with a `listen to <attio>`
statement — see `pnpm dev:movement` — not the retired TG body below.)

### Refresh path (legacy linked_object cache)

```bash
# 0. Ensure stack is up and seeded
pnpm dev:loop                # in another terminal
pnpm dev:seed --pretty

# 1. Create a record in fake Attio
curl -sS -X POST http://localhost:5556/attio/v2/objects/companies/records \
  -H 'content-type: application/json' \
  -d '{"data":{"values":{"name":"Acme","domains":["acme.com"]}}}'
# → {"data":{"id":{...,"record_id":"1"},"values":{"name":[{"value":"Acme"}],...}}}

# 2. Bridge a KG Deal node to that record
pnpm dev:link create --node-type Deal --object-slug companies --record 1

# 3. Update the record in fake Attio (simulating the user editing in Attio)
curl -sS -X PATCH http://localhost:5556/attio/v2/objects/companies/records/1 \
  -H 'content-type: application/json' \
  -d '{"data":{"values":{"name":"Acme Updated"}}}'

# 4. Fire the webhook (no HMAC — test-harness bypass)
pnpm dev:inject attio-webhook --event record.updated --object companies --record 1

# 5. Verify the linked_object was refreshed
pnpm dev:graph linked
# fetched_at is now set; data contains {"name": "Acme Updated", "domains": "acme.com"}
```

### Webhook → movement dispatch path

The structured-input TG dispatch path (and its `dev:trigger create-webhook` /
`set-body` tooling) was retired with the TG teardown (`e032ebc61`). To exercise
"Attio webhook → a movement runs", author a movement that listens to the Attio
source and fire it through the same inject:

```bash
# Author a movement: listen to attio { type: "companies" } fire <movement>
pnpm dev:movement provision --file <your-movement.mvt>
# Fire the webhook (test-harness signature bypass)
pnpm dev:inject attio-webhook --event record.updated --object companies --record 1
# Inspect what the movement wrote
pnpm dev:graph node <id>     # or dev:inspect <target>
```

For the test-harness team the inject response surfaces engine errors directly
(not just in the API logs), so a movement that fails checking/firing reports
the smoking-gun message inline.

## Worked example: inbound WhatsApp media → movement, bytes resolve

Goal: confirm "a WhatsApp media message runs a movement, and the media
bytes resolve through the blob-URL path" — fully faked, no real Graph API.

```bash
# 0. Stack up + seeded
pnpm dev:loop:agent2          # in another terminal (non-default profile)
pnpm dev:seed

# 1. Wire the sender phone → team + a whatsapp movement trigger
pnpm dev:whatsapp setup
# → senderPhone +15551234567; movement whatsapp_intake; trigger kind "whatsapp"

# 2. Fire an inbound media message. The bytes are seeded into the fake Meta
#    media endpoint, then the webhook fires.
pnpm dev:inject whatsapp --from 15551234567 --media --text "Deck attached"
#    (--media-type document for a PDF, --media-type audio for a NAMELESS voice note — real OGG/OPUS speech that transcribes on the extraction path)

# 3. Verify the movement ran (it writes to the fake Slack dealflow channel)
pnpm dev:inspect slack            # → "WhatsApp from 15551234567: Deck attached"

# 3b. Write-backs: a movement can reply (threaded) and react off the event —
#     write m-[:Replies]->   { To: m.`From`, Body: "…" }
#     write m-[:Reactions]-> { To: m.`From`, Emoji: "👍" }
#     Sends land in the fake Meta send endpoint
#     (POST /whatsapp/graph/:pnid/messages) and show in the same outbox:
pnpm dev:inspect whatsapp         # → outbox entries with reaction / context (threading)

# 4. Verify the media bytes resolve through the blob-URL adapter path
pnpm dev:inspect whatsapp         # → seededMedia[] + recentExposedFiles[] (blob URLs)
curl -sL "<blobUrl from step 4>" | file -     # → the seeded PNG/PDF bytes
```

Under the hood (the chain the WhatsApp dumb dispatcher exercises):
`downloadMedia(id)` hits the fake Graph endpoint (`WHATSAPP_GRAPH_BASE_URL`)
→ bytes → `exposeFile` buffers them to S3 and mints `/api/files/blob/:id`
(`EXPOSED_FILE_PUBLIC_BASE_URL`) → the attachment carries that blob URL →
the movement reaches its trigger → the WhatsApp adapter's
`fetchUrlToStream(blobUrl)` (302 → presigned S3) yields the bytes.

## Worked example: a Telegram voice note transcribes into a movement

Goal: confirm "a voice note becomes movement input" — the audio's TRANSCRIPT
flows through the extraction file-text seam (`file_text.ts`, kind `audio`)
exactly where PDF text flows, and the extracted content lands in a write. The
audio bytes are fake-served; the whisper call is REAL (sub-penny).

```bash
# 0. Stack up + seeded
pnpm dev:loop:agent          # in another terminal
pnpm dev:seed

# 1. Provision: TELEGRAM + SLACK creds + a movement that listens to telegram
#    and extracts from [msg.`Text`, msg-[:Attachments]->.`File`].
pnpm dev:telegram setup
# → listeners[0].kind: "telegram"

# 2. Fire a voice note. Seeds the committed OGG/OPUS speech sample
#    (apps/fake-channels/assets/voice-sample.ogg — "the quarterly numbers look
#    strong, revenue up twelve percent") into the fake Telegram media store,
#    then POSTs a `voice`-carrying Update at the webhook-sync door.
pnpm dev:inject telegram --voice
# → eventsProcessed: 1; seededVoice.fileId

# 3. Verify the transcript reached the write.
pnpm dev:inspect slack       # → "Telegram update: … quarterly numbers look strong …"

# 4. (Metering) the `transcription` wallet_ledger line only lands for a
#    metered team — the dev-loop team is billing_exempt by default, so flip it
#    off temporarily if you need to see the drawdown, and restore after:
#    UPDATE team SET billing_exempt=false WHERE id='<TEST_HARNESS_TEAM_ID>';
#    → wallet_ledger: entry_type=transcription, detail.durationSeconds from
#      whisper's response; run_cost.transcription_micro_gbp accumulates.
```

Under the hood: the Update's `voice` parses to an attachment (`parseTelegramEvents`
→ `normalizeMessage`), the attachment's `File` field mints a self-retrieving
FileRef (two-leg Bot API download against fake-channels), `file_text.ts`
classifies `audio/ogg` → buffers (24MB cap) → `transcribe('whisper-1', …)`
(wherever `MODEL_MAP` sends it; on OpenAI, verbose_json) → the transcript joins the extraction source text and
the duration is metered off the ambient cost meter. `--voice-file <path>`
substitutes your own audio.

## Worked example: inbound Airtable webhook runs a movement (and selection holds)

Goal: confirm "a record change in a watched Airtable table runs a movement" via
the notify-then-pull seam — fully faked, no real Airtable — AND that a change
kind the listen didn't subscribe to is dropped at the source (the credit
guarantee).

```bash
# 0. Stack up + seeded
pnpm dev:loop:agent          # in another terminal
pnpm dev:seed

# 1. Provision: AIRTABLE creds + a base/table in fake-channels + a movement that
#    listens for record.created ONLY and writes new records to Slack `dealflow`.
pnpm dev:airtable setup
# → subscription { external_webhook_id: "ach1", scope: {base,table},
#                  subscriptions: [record.created] }

# 2. Fire a CREATE → the fake queues it, the ping pulls it, the movement runs.
pnpm dev:inject airtable-webhook --event create --record rec1 \
  --values '{"Name":"Acme Corp","Stage":"Seed"}'
# → response { ok: true, eventsProcessed: 1 }; seeded { appended: true, seq: 1 }
pnpm dev:inspect slack        # → "Airtable record created: Acme Corp (stage Seed)"

# 3. Fire an UPDATE → the webhook only subscribed to creates, so the fake DROPS
#    it (never queued) → the ping pulls nothing → the movement does NOT run.
pnpm dev:inject airtable-webhook --event update --record rec1 \
  --values '{"Name":"Acme RENAMED"}'
# → response { ok: true, eventsProcessed: 0 };
#   seeded { appended: false, reason: "change_type_not_subscribed",
#            subscribedChangeTypes: ["add"] }
pnpm dev:inspect slack        # → still only the create message; no "RENAMED"
```

Under the hood (the chain the webhook handler exercises): the ping
(`{ base, webhook }` ids only) hits `/api/public/webhook-sync/airtable/<subId>`
→ the handler calls `AirtableAdapter.preprocessInbound` → `client.listPayloads`
PULLS the payload feed from the persisted cursor
(`webhook_subscription.inbound_checkpoint`) → each record change becomes a
`DiscriminableEvent` (cell values mapped from field id → natural name) →
discriminate → `dispatchDiscriminableEvent` → the movement engine runs → the new
cursor is persisted as the checkpoint. The next ping pulls from there. Watch it
in `.dev-loop/loop.log`:

```bash
tail -200 .dev-loop/loop.log | grep -E "webhooks/.*/payloads\?cursor|webhook-sync/airtable"
# → GET …/webhooks/ach1/payloads?cursor=1   (create pull)
# → GET …/webhooks/ach1/payloads?cursor=2   (next ping resumes past it)
```

## Worked example: a polled Granola note runs a movement (and reads its Title)

Goal: confirm "a new Granola meeting note runs a movement, and the movement reads
the note's `Title` correctly" — fully faked, no real Granola, no webhook (Granola
is a POLL source). Also the regression guard for the seam fix: before it, a
listener reading `` note.`Title` `` threw `'Title' is not a known field of
'granola:note'` at runtime though it type-checked.

```bash
# 0. Stack up + seeded
pnpm dev:loop:agent          # in another terminal
pnpm dev:seed

# 1. Provision: GRANOLA + SLACK creds + a movement that listens to granola and
#    writes each note's Title (and attendees) to the fake Slack `dealflow` channel.
pnpm dev:granola setup
# → trigger { kind: "granola", run_mode: "live", poll_last_at: null }

# 2. Seed a note + fire the poll in-process (no webhook — Granola is polled).
pnpm dev:inject granola --title "Series A sync" --owner priya@fund.com --attendee ceo@acme.com
# → results[].eventCount: 1

# 3. Verify the movement ran AND read the Title.
pnpm dev:inspect slack       # → "Granola note: Series A sync — owner priya@fund.com"
                             #    "Attendee on Series A sync: ceo@acme.com"

# 4. Confirm the poll checkpoint advanced.
pnpm dev:inspect granola     # → triggers[].poll_checkpoint.updatedAfter set; poll_last_at set
```

Under the hood: `dev:granola setup` saves a movement whose `listen to gr {}`
derives a `granola`-kind trigger. `dev:inject granola` seeds the full note into the
fake Granola API, then calls `pollTriggerNow` (forced poll) → the `GranolaPollSource`
lists notes since the checkpoint → `getNote` hydrates each → one `granola:note`-tagged
`DiscriminableEvent` → discriminate seeds the root position (recordType =
`granola:note`, the typeId) → the engine runs the movement, whose `` note.`Title` ``
read resolves the field by the position's typeId (the seam fix). No
`'Title' is not a known field of 'granola:note'` in `.dev-loop/loop.log` is the
proof the fix holds on the real path.

### Ticking the automations drain by hand

Automations' background work (cron, polls, timer resumes, inbound dispatch, await wakes, the orphan sweep) is rows in `automations.work`, run by one drain worker. By default the API drains on an in-process timer. Set `AUTOMATIONS_DRAIN_MODE=external` and the loop is off, and a door enqueues without draining: rows drain only when a caller hits `POST /api/v1/system/automations/drain`, on any instance. The optional JSON body is `{"limit": 10, "maxPasses": 20}` (at most 100 and 50); the answer is `{claimed, ran, recovered, failed, deferred, claimFailed, stopped}` (`deferred`: rows released to retry because another process was stepping their run; `stopped`: `idle`, `pass_limit` or `claim_failed`). The boot log says which mode is running (`[startup] automations.drain: drain mode "loop"` or `"external"`). One exception to "a door enqueues without draining": a test-harness door (every `dev:inject`) drains its own team's rows before it answers, in either mode; other teams' rows and the periodic rows wait for the tick. The route needs a key holding the `system` scope (or `*`) and answers 404 when the `automations` unit is not mounted. `pnpm dev:system-key` mints one: it revokes the live `dev-loop-scheduler` key, mints a replacement with `scopes = {system}` on the dev-loop team, and prints its plaintext on the last line (the plaintext exists only at mint, so each call rotates it). Then `curl -X POST -H "Authorization: Bearer <plaintext>" -H 'content-type: application/json' -d '{}' http://localhost:3500/api/v1/system/automations/drain` answers `200` with the drain result. `pnpm drain:once` is the same pass with no HTTP: the entry a scheduled job runs (`node build/scripts/drain_once.js` in production). It prints the drain result and exits `0` when idle, `2` when it stopped at the pass limit with work still due, and `1` when the database is unreachable or the run threw. `--limit` and `--max-passes` take `--limit 5` or `--limit=5`; any other argument is refused.

### The push-tick shape

`DEV_LOOP_SHAPE=push-tick pnpm dev:loop:agent` boots the stack as a deployment with no in-process drain. The API runs with `AUTOMATIONS_DRAIN_MODE=external`. Its own tick notifier stands in for a Pub/Sub push: `AUTOMATIONS_TICK_URLS` is its own drain endpoint, so a door's notify POSTs a tick there. `dev/scheduler.sh` stands in for Cloud Scheduler: it waits for the API's health check, then POSTs the drain every 5 s (`DEV_LOOP_TICK_EVERY_S` changes it), logging `tick start` and `tick end <answer>` with UTC timestamps to `.dev-loop/scheduler.log`. The API's notifier logs `[work] drain tick sent` and `[work] drain tick answered` (debug level, so they show in the loop) to `.dev-loop/loop.log`. The loop mints the key both use (`pnpm dev:system-key`) after the fake CRM is up and before the API boots, and exports it as `AUTOMATIONS_TICK_KEY`. The profile file records `"shape": "push-tick"`. With no `DEV_LOOP_SHAPE` (or `loop`) the loop is unchanged; any other value refuses to boot.

To watch a timer wait for a tick, run a movement that sleeps with `pnpm dev:movement run <name>`, not `dev:inject` (a harness door drains its own team's rows in either mode). `pnpm dev:inspect work` lists every work row, soonest due first, beside the database clock: the `resume_timer:<runId>` row sits unleased at its wake time while the scheduler's ticks report `claimed: 0` for it, and the first tick after the wake time claims it and the run completes. The 30 s periodic rows show up as `claimed: 5` (or so) every sixth tick.

### Two instances on the agent stack

Automations takes no lock: any number of instances may drain one database, in either mode, because each entry into a run holds that run's lease (`trigger_run.lease_owner` / `lease_until` / `lease_token`). To run two on the agent stack, boot it as usual (`pnpm dev:loop:agent`; its API is instance one, draining in loop mode on 3500), then start a second API process on its own port against the same database, with the agent profile's environment:

```bash
cd apps/api
set -a; eval "$(node -e 'const p=require("../../.dev-loop/profiles/agent.json");for(const [k,v] of Object.entries(p.env))console.log(`${k}=${JSON.stringify(v)}`)')"; set +a
PORT=3510 TZ=utc npx ts-node --project tsconfig.dev.json --transpile-only -r dotenv/config -r tsconfig-paths/register src/server.ts \
  > "$SCRATCH/second-api.log" 2>&1 &
```

The second process reads `apps/api/.env` like the first (dotenv never overrides what is already set, so the profile's `DATABASE_URL` and Redis win) and drains in loop mode too; `AUTOMATIONS_DRAIN_MODE=external` on either turns its loop off, leaving it to ticks. Both boot logs say `[startup] automations: background processing started`, and no `waiting for the background lock` line for automations. Stop the second process by its pid when done; it is not part of the loop's own shutdown.

To see one run entered from both at once: save a movement that sleeps and then awaits a repeatable callback (`tap = callback({ … }, { once: FALSE })`, its url in a Slack message, then `await FIRST(tap-[:Called]->)`), and run it (`pnpm dev:movement run <name>`). Backdate its `parked_run.wake_at` and its `resume_timer` row: exactly one instance claims the row (`work.lease_owner`) and holds the run (`trigger_run.lease_owner`, `host:pid:…`) while it steps. Then POST the callback url on both ports at once (`-H 'accept: application/json'`): the instance that took the run's lease answers `200` and runs the body and the awaiting continuation; the other answers `202` and queues a `fire_callback` row, which defers while the run is held (`[work] handler deferred` in its log) and runs the second body once it is free. `pnpm dev:inspect slack` then shows each body once and the continuation once.

## Patterns to know

- The dev-loop team id is fixed (`TEST_HARNESS_TEAM_ID` in `apps/api/.env`).
  Don't make it random or the fake-channels routing breaks.
- Real adapters call fake-channels via the `baseUrl` cred override in
  `lib/recording.ts:injectFakeBaseUrl`. The hook fires when the active team
  matches. Look there if a service isn't being faked.
- For inbound webhooks: the handler also reads `isTestHarnessTeam` to skip
  HMAC verification. See `services/webhook_sync/handler.ts`.
- Email + WhatsApp *outbound* use a different mechanism: their fake
  adapters (`adapters/{email,whatsapp}/fake.adapter.ts`) POST directly to
  fake-channels regardless of team — selected by `services.ts` when prod
  env vars are absent.
- WhatsApp *inbound media* uses two env overrides (set by `dev/loop.sh`):
  `WHATSAPP_GRAPH_BASE_URL` points the Meta Cloud API client
  (`services/whatsapp/metaApi.ts`) at the fake media endpoint, and
  `EXPOSED_FILE_PUBLIC_BASE_URL` pins `exposeFile`'s blob URLs at the
  active stack's API origin (`/api/files/blob/:id` is served by the API,
  not the web app `OAUTH_REDIRECT_BASE_URL` resolves to — without this the
  blob-URL byte path can't resolve in-loop).
- Conversations from `pnpm dev:chat` are visible in the web UI and vice
  versa — they share the `agent_conversation` table.
- `pnpm dev:graph node <id>` is your fastest path to "what's actually in
  the database for this node?" — properties, edges, linked_objects all in
  one JSON dump.

## Webhook → KG dispatch path (now end-to-end working)

The dispatch path lands writes on `knowledge.node` / `knowledge.property`
when an Attio webhook fires:

1. Webhook arrives at `/api/public/webhook-sync/attio/<subId>`
2. Handler bypasses HMAC for the test-harness team
3. Subscription found → events dispatched to TG triggers on the matching
   `pipeline_input.translation_graphs`
4. Engine seeds a `webhook-event` SourcePosition from the trigger payload
5. Engine queries `linked_object` for an existing bridge
   (`team, adapter_type, external_id`)
6. **No bridge yet?** Engine creates a new KG node + properties + writes
   a `linked_object` row pointing it at the source record (so future
   events for the same record find it)
7. **Bridge exists?** KG adapter's `resolveEntity` returns the matched
   node id; engine takes the update branch on the same node

Before this session those steps failed at: (4) `seedRootSourcePosition`
threw on webhook triggers; (5) `loadLinkedObjectCandidates` was
hard-coded to `[]`; (7) `KnowledgeGraphAdapter.resolveEntity` threw
"not yet implemented". All three are now wired (see plans referenced
in the file headers for the original deferred decisions).

## linked_object.adapter_type is canonically lowercase

All read/write sites for `linked_object.adapter_type` (and the joined
`output_run.adapter_type`) funnel through `normalizeAdapterType` from
`services/knowledge_pipeline/output_v3/linked_objects.ts`. The column
is always lowercase. The legacy refresh path used to store the
uppercase enum value (`'ATTIO'`) and the TG dispatch path the lowercase
adapter id (`'attio'`) — Postgres is case-sensitive, so these silently
diverged. The
`20260509_195752_lowercase_linked_object_adapter_type.sql` migration
deduped overlapping rows and lowercased the rest.

## Adding support for a new input type

When you add a new `PipelineInputType` (a new third-party adapter, a new
in-process service), the dev-loop is **not done** until you can drive it
end-to-end without external dependencies. The bar is: a contributor with
no prior context can `dev:loop` + `dev:seed` + your-new-CLIs and
exercise every trigger kind your input supports. Concretely:

1. **Provisioning** — a `pnpm dev:<input>` script that idempotently
   creates the credentials row, the pipeline_input with at least one
   trigger entry per supported trigger kind (webhook / manual / mutation),
   and any provider-specific scaffolding (webhook_subscription,
   platform_owned_token, …). Pattern: `apps/api/src/scripts/dev/valuations.ts`
   (in-process) or the Attio path baked into `dev:seed` (real third-party
   faked through fake-channels). Idempotent: re-running should be a no-op.

2. **Event injection** — a `pnpm dev:inject <input>-webhook` (or the
   equivalent for the input's trigger surface) wrapper in
   `apps/api/src/scripts/dev/inject.ts`. ~30 lines: build the
   provider-shaped body, look up the subscription, delegate to
   `injectRaw`. If the input's signature verification doesn't already
   bypass for the test-harness team, fix that too — see
   `lib/recording.ts:isTestHarnessTeam` and
   `services/webhook_sync/handler.ts` for the pattern.

3. **State inspection** — a domain in `apps/api/src/scripts/dev/inspect.ts`
   that reports steady-state entity counts and recent activity (outbox /
   delivery log / equivalent). For faked providers, read from fake-channels;
   for in-process providers (Valuations), read from Postgres scoped
   to the dev-loop team. Without this, "did my trigger actually fire?"
   takes a manual `psql` session.

4. **Base URL routing** (only for real third parties faked through
   fake-channels): add an entry to `fakeBaseUrlByService` in
   `lib/recording.ts` so credential fetches for the test-harness team
   get rewritten to `${FAKE_CHANNELS_URL}/<service>`. In-process inputs
   (where the local API _is_ the service) skip this step.

5. **DEV_LOOP.md updates** — add the new CLIs to the TL;DR block and the
   "What is real, what is fake" table; if the input's shape needs any
   gotchas (e.g. value normalization, signature behavior), call them out
   in the relevant `dev:inject` / `dev:inspect` section.

The goal isn't perfect coverage — it's that the next person can answer
"does this work?" without spelunking. If your input does something
genuinely novel (a non-webhook trigger surface, an unusual auth shape,
…), invent the CLI it needs rather than forcing it through the existing
shape.

## Known gaps

The list below is what the **dev-loop** doesn't yet cover — distinct from
product features that don't exist. If any of these blocks you on a real
task, extend them; don't work around them.

- **Slack inbound — only the legacy path is blocked.** The default
  `pnpm dev:inject slack-event` now POSTs at
  `/api/public/webhook-sync/slack/<subId>` with the `isTestHarnessTeam`
  signature bypass and works. Only `--legacy` (the old
  `/private/slack/callback` route) still 403s — that handler identifies the
  team by Slack workspace ID, not by webhook subscription, so a
  Slack-team-id → team-id mapping would be needed to bypass it.
- **Input agent for chat-driven config.** `agent_registry.ts` has
  query/ontology/output domains. There's no `input` domain that knows
  how to call `webhookSubscriptions.create`, edit pipeline_input
  translation_graphs JSONB, etc. When that exists, `pnpm dev:chat
  input "wire up Attio companies → Deal updates"` will close the
  agent-configures-it loop.
- **Richer fake Attio value shape.** Real Attio responses include
  `active_from`, `active_until`, `created_by_actor` per typed value
  entry. Fake-channels currently emits the minimum fields needed for
  `buildRecordData` to parse correctly. If something downstream depends
  on the richer fields, fake-channels needs to grow them.

## What's intentionally not built

- CI / repeatable test orchestration — this is a dev-loop tool, not a test runner.
- LLM mocking — agent responses use real Anthropic/OpenAI for fidelity.
- MCP exposure of knowledge agents — the chat CLI is the current path.

If any of those become useful, extend rather than replace. Plan in
`plans/2026-05-09-autonomous-dev-loop/2_architecture.md` lists this as out
of scope so you'll know it was a deliberate omission.
