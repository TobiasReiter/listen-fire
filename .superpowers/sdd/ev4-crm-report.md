# ev4-crm report — Affinity, Airtable, Attio as modules

Branch `ev4-crm` from 9cfa02d3. Not pushed. Commits, in order:
d67cae07, 7084aca7, 26150298 parity recordings (all three, before any code moved) ·
3decba48 Affinity · 4766cb58 Airtable · 46f93c5a Attio (+ contract test, CHANGELOG) ·
832f4ca4 boundary baseline 779 → 711 · 60d7535d owner-stamp perf + bench.

## Done

- `@lf/affinity`, `@lf/airtable`, `@lf/attio` in `modules/<name>`; each `BUILTIN_MODULES` line is
  `module`. Each legacy line is the module's adapter over the old decrypt-the-row path (rollback
  is one edit).
- Each declares its signed inbound with today's provider key, scheme and header chain
  (`affinity_hex_or_b64`, `airtable_mac`, `attio`); a contract test pins them to the frozen table.
- Henry's rule applies: an install with a missing, blank or `pending` secret is refused.
  - The API logs at boot, per module, how many live subscriptions this refuses (a count only).
  - CHANGELOG `### ev4-crm` names it as a behaviour change. Affinity needs the account's Webhook
    Signature Key, then the listen re-registered.
  - Golden corpus: one case re-recorded (`affinity-unset-key-accepts-unsigned` became
    `affinity-unset-key-refused`, 200 → 401). The diff was read; nothing else changed. Airtable
    and Attio have no empty-secret golden case.
- The Attio and Airtable OAuth connect flows are unchanged. Their declarations moved into the
  modules (`oauth.ts`), and the apps/api auth clients import them.

## Decisions (why)

- **Model calls.** Affinity's writes ask a model (the fuzzy person and organisation match, the
  location formatter). The kit now lends `ctx.models` (`chat`, `chatStructured`).
  - The platform lends its hosted client, so routing and billing are unchanged.
  - The `serve-module` command line lends none and refuses by name. An embedder serving the module
    may lend its own.
- **Files.**
  - `ctx.files` on the platform now reads (redeem) and exposes (`files.expose`, new; for Airtable
    attachments). `put` still refuses.
  - A module falls back to the wire `url` when the host cannot read the file (process transport).
  - Attio's files name only its own type and the file id. The platform stamps the owning install
    onto field values, as the remote adapter does over the wire.
- **OAuth credentials (Airtable, Attio).**
  - The modules declare `oauth2` in the protocol's token fields, so lf's `credential add` can run
    the declared flow.
  - The platform's rows are kept as they are. `module_credentials.ts` renames the stored fields
    on read and write-back (`accessToken` ↔ `access_token`, and so on).
  - The kit's credential gained an optional `refresh()`. The platform refreshes with its own app
    (generic grant, same token URL and Basic auth as before).
  - The platform's own pipelines keep the old row refresh: Airtable's client takes a token source.
- **Slack ops alerts** (an Affinity note or field-value write refused; an Attio field rejected).
  These are now a reporter hook in each module. The platform installs the same Slack text.
- **Airtable webhook refresh.** It stays a host work kind: it reads the platform's subscription
  rows, which a `periodic` module task cannot see. It now reaches Airtable through the registry,
  so it follows the line.

## Tests (done tier)

- Module unit tests:
  - affinity 203/203
  - airtable 48/48
  - attio 111/111
  - module-kit 43/43
  - dealroom 43/43
- Type-check clean, boundary guard 0: the three modules, module-kit, dealroom, movement-engine,
  and apps/api (engine boundary 711, lowered).
- Recorded parity, per CRM:
  - Legacy line: identical.
  - Module in process, through the registry: identical.
  - Module over protocol 2 (in-test `serveModule` + `RemoteAdapter`):
    - Affinity identical, lent the same canned models.
    - Airtable identical except the `base:`-scoped steps, which are skipped. Protocol 2 carries
      no construction arguments.
    - Attio gives identical answers and writes. It re-reads its catalogue, because the module is
      rebuilt per request.
- Scoped apps/api run (adapters, translation_graph tests, webhook_sync, output_v3,
  credentials, inbound and golden, startup, knowledge_pipeline): 169 suites, 3292 passed,
  4 skipped, 0 failed after the fixes. Integration tests were not run (none needed).
- Bench (`apps/api/src/scripts/bench_crm_modules.ts`), module vs legacy, unvalidated (production):

  | | p50 | p99 | RSS | boot |
  |---|---|---|---|---|
  | affinity | +0.9% | −1.7% | +0.9% | +2.8% |
  | airtable | +2.3% | +1.2% | +0.5% | +0.8% |
  | attio | +0.1% | −0.1% | −0.9% | +0.3% |

## Flags for Henry

- Protocol 2 carries no construction arguments, so a remote Airtable cannot take `base:`. Google
  Sheets' `spreadsheet:` will hit the same gap. protocol.ts is ev4-conncreds' file.
- Protocol 2 has no way for a module to say "the provider refused my token". A process module is
  refreshed only by expiry. A model capability over the wire is also missing: Affinity writes
  that need a model fail by name under `serve-module`.
- The refresh-token expiry (`refreshTokenExpiresAt`) is no longer updated on an Airtable refresh.
  The generic grant ignores `refresh_expires_in`, and the old value is kept.
- A pre-existing quirk: Affinity publishes a list's `Owners` field as an edge, but `getRelated`
  refuses it.

## Files outside the stream (minimal)

- packages/module-kit:
  - `define.ts`: `ModuleModels`, `ModuleChat`, `files.expose`, `credential.refresh?`.
  - `in_process.ts`: `models` default, `refusingModels`.
  - `module_server.ts`, `serve.ts`: lend `models`.
  - New file `adapter/not_found.ts`.
- New engine entry `packages/movement-engine/public/adapter-support.ts`.
- apps/api:
  - `builtin_modules.ts`: three lines, platform files and models, stored-credential shape and
    refresh, owner stamping, `adapterModuleDefinitions` exported.
  - `registry.ts`: three factories.
  - `startup/automations.ts`: the boot count.
  - `adapters/not_found.ts` (re-export).
  - `webhook_sync/__test__/capture_then_ack` (mocks the module verifier).
  - The acting-user test (uses the legacy line).
  - apps/api `package.json` and its build script; `deploy/Dockerfile`; `pnpm-lock.yaml`.
- fake-channels: Airtable read-one and delete routes; Attio record delete, member read and webhook
  update routes.
- `scripts/engine-boundary-baseline.json` (lowered).
