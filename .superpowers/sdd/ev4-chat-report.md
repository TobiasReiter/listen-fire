# ev4-chat report — Telegram and Slack as modules

Branch `ev4-chat` from 9cfa02d3. Not pushed. Commits, in order:
8d7d9fc8 Telegram recording · e9af900b Telegram module · e5633857 Slack recording ·
f4a9a030 Slack module · then the Slack client cache, the boundary baseline and this report.

## Done

- **`@lf/telegram`** (`modules/telegram`), its `BUILTIN_MODULES` line flipped to `module`.
  - Moved: adapter, Bot API client, inbound parse, manifest, handbook section.
  - The platform host supplies three things beyond the common context:
    - the shared bot's token (`TELEGRAM_BOT_TOKEN`), filling a team's empty credential or standing in for none;
    - the `/start` handshake's record of who linked (`telegram_identity`), as the module's linked identities;
    - the install's credential id, which an attachment's file names.
  - The doors (callback door, shared bot) keep constructing the legacy class: answering a tap, retiring a keyboard and the handshake reply are the platform speaking as its bot.
- **`@lf/slack`** (`modules/slack`), its line flipped to `module`.
  - Moved: adapter, Web API client, read graph, history pushdown, mentions, writes, inbound parse, manifest, handbook section.
  - The platform builds its own definition (`slackModuleWith`): its routed model for `SLACK_MESSAGE`, and its redemption of any owner's file for an upload. Other hosts run `slackModule`.
  - Declares the signed inbound the door always verified: `slack_v0`, `x-slack-signature`, the `url_verification` intercept.
  - Unchanged and still in apps/api: the installer flow (signed state, comma scopes), the shared app's doors (`/api/public/slack`, `/api/public/slack-actions`) and their fan-out by Slack team.
- **Legacy lines.** Each is the module's adapter class over the old credential path. Rolling back is one line.
- **Module kit** (two optional additions):
  - `ctx.identities`: who linked their provider account to a host user (list, find). A host without one refuses by name.
  - `ctx.config.credentialRef`: the host's name for the install's credential.
- **Recorded parity.** Recorded from the legacy adapters against fake-channels before any code moved.
  - Shared harness: `adapters/__test__/parity_http.ts` (keeps content types and bytes) and `parity_fake.ts` (ephemeral port).
  - Telegram, four installs (own bot, connected shared bot, harness, a host with no doors): legacy and module in process replay identically. As a process: identical except the file download.
  - Slack, three installs (workspace, harness, no credential): legacy and module in process replay identically, except one refusal now ends "Connect Slack." As a process: identical except composition and the download. Every recorded request is made; the only extras are repeated reads.
- **Inbound golden corpus:** passes unchanged. No re-record was needed. Telegram declares no signed inbound; Slack's cases all carry real secrets.

## Decisions (why)

- **Telegram declares no `inbound`.**
  - A team's own bot is registered without a secret token (`registerSubscription` returns `''`). The frozen table accepts it on the URL alone.
  - Declaring `telegram_secret_token` would refuse every existing bot under Henry's signed-inbound rule, and existing deployments must not change.
  - The shared bot's door already verifies its secret token, as before.
- **Shared credentials and linked identities are platform supplies on the line** (`PlatformSupplies`), not module concepts.
  - The module sees an ordinary credential and an ordinary identities reader.
- **The Slack model and file redemption come through `slackModuleWith`.** This follows ev4-plugins' `webModuleWith`. The kit has no model capability, and Slack's upload needs the resolved content type, which `ctx.files.read` does not return.
- **Slack keeps `@slack/web-api` (WebClient plus its read cache).** So its Web API calls do not go through `ctx.fetch`; file bytes and uploads do. A rewrite onto fetch would have risked the recorded requests.

## Flags for Henry

- **Protocol gap:** `WireDiscriminableEvent` has no `idempotencyKey`. Slack's `event_id` therefore does not cross the wire, and a process-served Slack (lf) cannot deduplicate Slack's retries. `protocol.ts` belongs to ev4-conncreds this wave, so I did not add the field. The parity test documents the gap.
- **Over the process transport, a module's own file bytes are refused** (Telegram attachments, Slack files). The kit serves bytes only by URL. This is the same for every module.
- **Over the process transport, Slack's `SLACK_MESSAGE` composition refuses:** lf gives a module no model. A host model capability is needed.
- **Slack's door is stricter under the declared rule:** a missing, blank or placeholder signing secret is refused. Every subscription the platform's Slack setup creates holds a generated secret.
- **Benchmark (+5% gate):** see below. The machine was shared with sibling agents, so the figures are noisy.

## Performance (`pnpm bench` in each module; interleaved, median of 5)

Hosted production runs the module unvalidated, so that row is the gate. The `validated` row (development) is for reference.

| | p50 | p99 | RSS | boot |
|---|---|---|---|---|
| Telegram legacy | 0.237 ms | 1.189 ms | 198.7 MB | 150.3 ms |
| Telegram module | +4.2% | −1.8% | −0.1% | +0.2% |
| Telegram validated | +28.3% | −4.2% | −0.2% | +1.8% |
| Slack legacy | 0.277 ms | 1.146 ms | 162.2 MB | 310.6 ms |
| Slack module | +1.8% | −11.6% | +1.0% | −1.4% |
| Slack validated | +24.5% | −15.9% | +1.0% | −8.2% |

- Both modules are within +5% on every figure.
- Slack first measured p50 +13.7%. The cause was the module re-parsing the credential on every Slack call. It now builds the client once per credential read, as Dealroom does.
- Earlier runs while sibling agents were busy swung by ±30%. The figures above come from quiet runs.
- The legacy column excludes the database. In hosted production the legacy line decrypts the row on every call, so the real comparison favours the module.

## Tests (done tier)

- `@lf/telegram`: 10/10. `@lf/slack`: 20/20 (6 module tests, plus the 14 history-window tests that moved with the code).
- module-kit: 43/43. `@lf/dealroom`: 43/43 (re-run after the kit change).
- Telegram parity: 10/10 (recording skipped). Slack parity: 9/9 (recording skipped).
- apps/api, scoped run (webhook_sync, inbound including the golden corpus, translation_graph adapters, the Slack adapter tests, interfaces/rest, the v3 output, lib/knowledge, movement, work): 200 suites, 3481 passed, 3 skipped, 0 failed.
- Type-check clean:
  - apps/api, including the oracle config and the engine-boundary guard: 754 imports, baseline lowered from 779.
  - module-kit, `@lf/dealroom`, `@lf/telegram` and `@lf/slack`, each with the module-boundary guard.
- Integration tests were not run: neither module has an integration suite.
- End-to-end in the dev loop was not run: only ev4-cleanup boots the dev loop this wave.

## Files outside the stream (minimal)

- `packages/module-kit/define.ts` and `in_process.ts` (ev4-plugins owns them): `identities` and `credentialRef`, both optional, additive.
- `adapters/builtin_modules.ts`: the two lines, `PlatformSupplies`, the shared-credential fill, `credentialRef`.
- `adapters/registry.ts`: Telegram and Slack factories behind their lines; manifests from the modules.
- `webhook_sync/providers/slack.ts`: the parse now delegates to the module.
- `adapters/slack/webApi/apiClient.ts`: re-exports the module's client (installer, v3 output agent).
- `webhook_sync/providers/telegram.ts`: a comment.
- `webhook_sync/__test__/capture_then_ack.unit.test.ts`: also stubs a module line's verifier ("every provider verifies").
- Slack helper tests in `translation_graph/__test__`: import paths, and `host` in place of `teamId`.
- `apps/api/package.json` (deps, build line), `deploy/Dockerfile`, `pnpm-lock.yaml`.
- `scripts/engine-boundary-baseline.json`: lowered.
