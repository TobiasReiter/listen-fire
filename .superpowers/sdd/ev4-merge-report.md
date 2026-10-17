# ev4-merge report — everywhere wave 4, merged

Branch `ev4-merge` from `cloud-native` d787ea35. Not pushed. One merge commit per branch, in the
brief's order: ev4-cleanup, ev4-small, ev4-dropbox, ev4-google, ev4-plugins, ev4-crm, ev4-chat,
ev4-conncreds. Then the fixes, one commit each.

## Read

- **Done.** All eight merged; all three fixes landed; every verification leg green (numbers below).
- **One shape each, where streams overlapped** (the merge commits name each choice):
  - Served files: Drive's one-use URL (`served_files.ts`) is the only mechanism. Dropbox's copy is
    deleted. The URL is under `MODULE_PUBLIC_URL`, else serve-module's own bound address; it is
    never taken from a request's Host header (absent a public URL, the handler serves no file).
  - A handed-in file is read by `readHandedFile` (its URL, else `ctx.files`) in every module;
    serve-module's Dropbox-only URL reader is gone.
  - The module line host: one shape, `storedAs`, `hostApp`, `credential`, `kv`, `files`,
    `sharedCredential`, `identities`, `harnessService`.
    - Dropbox's `payloadShape`/`refresher` became `storedAs`/`hostApp`. A host app may name its
      own token URL (Dropbox's dev-loop fake OAuth provider).
    - The CRM stored-field renames became `storedAs` (`renamedPayloadShape`); their OAuth apps
      became `hostApp` (`oauthAppFromEnv`).
    - Chat's `PlatformSupplies` became the last two hooks.
    - One refresh path serves the expiry window (5 min, Google's) and the kit's on-demand
      `credential.refresh` (CRM). A failed refresh says "<Name> token refresh failed" (Dropbox's).
  - Platform `ctx.files`: one `platformModuleFiles` (read, CRM's `expose`; `put` refuses; nothing
    uses put). Dropbox's `platformFiles` and CRM's `hostedModuleFiles` are gone.
  - A module's files naming their install: one `ownedFilesAdapter` (Drive's, shared with the remote
    adapter), now carrying construction args. Dropbox's `nameFileOwner` and CRM's
    `stampingFileOwners` are gone. The Attio parity suite still replays identically through it.
  - The parity exchange helper lives at `adapters/__test__/parity`, with Evertrace's tracked
    headers; every adapter's parity imports it. Dropbox keeps its own byte-level exchange (its
    recording is in that format); chat keeps `parity_http`/`parity_fake`.
- **lf-host credentials** (fix in the conncreds merge): lfr-secrets' sending and refreshing is
  kept; conncreds' refusal is deleted. Bindings agree with the TypeScript lf: `credential_for`
  never picks the install; `signer_of` signs a user credential's call with the install's secret;
  the legacy `/hooks` door names the install (`install_of`, as `hookTarget`); the catalog skips
  install entries and lists declared credentials from the declarations lf-host already parses.
- **Fix 1, schema:** `schema:apply` against the test DB (9432, `listenfire_test`) regenerated
  Prisma (unchanged) and Kysely (insert type is nullable, not optional). `schema:generate` on the
  same server reports no difference between the migration set and schema.sql.
- **Fix 2, `@lf/web` off the platform:** a LinkedIn address or any address the platform reads
  through its document sources (DocSend, Google Docs/Drive, pitch.com, Brieflink, Canva, Figma,
  Notion, Papermark, PDF/PPTX/XLSX) fails with `@lf/web: … needs the platform's LinkedIn profile
  reader | gated-document browser and document store, which is not available off the platform`.
  The research plugins' best-effort reads log that failure and read on (as for any failed page).
- **Fix 3, Alice/Bob:** passes on the platform (integration, 9432) and in lf under TS lf and
  `LF_BIN=lf-host` (lf-host now sends the declared credential).
- **Process transport gained file bytes.** With the kit's served files, Telegram's and Slack's
  served-module parity now hold for downloads too; their tests, which documented the refusal, now
  compare the whole recording.

## Fixes made while merging (beyond the three)

- Module fakes that build a `ModuleContext` or `ModuleFiles` by hand gained `models`, `identities`,
  `expose` and `kv.list` (kit additions from CRM and chat); `@lf/slack` gained one narrowing.
- Tests that mock `secrets_postgres` now spread the actual module (lines build shapes at load).
- The lockfile was rebuilt by importer blocks from d787ea35 plus each branch; `pnpm install
  --frozen-lockfile --offline` accepts it (a `--lockfile-only` regeneration was rejected: it
  re-resolved 4,000+ lines of non-workspace packages).

## Verify

- `NODE_OPTIONS=--max-old-space-size=8192 pnpm -r code:type-check`: exit 0, both boundary guards
  (engine boundary 603 = baseline; module boundary clean in all 14 modules).
- Engine boundary baseline regenerated with `--update`: **603** (was 761 on the branches' best).
- `cargo test --workspace`: 657 passed, 0 failed, 3 ignored. `cargo clippy --workspace
  --all-targets -- -D warnings`: clean.
- Module packages: affinity 203, airtable 48, attio 111, dealroom 43, dropbox 28, evertrace 113,
  gmail 71, google-drive 26, google-sheets 77, granola 33, slack 20, telegram 10, web 45 — all pass.
  module-kit 67/67, engine-contracts 58/58.
- apps/cli full: TS lf 299 pass / 0 fail / 25 skipped of 324; `LF_BIN=lf-host` 300 / 0 / 24.
- apps/api scoped legs (translation_graph adapters incl. registry and parity, services/inbound
  golden + contract, credentials, remote, plugins, catalog, transform_invoker, movement_engine),
  `--maxWorkers=4`: 215 suites, 5058 passed, 14 skipped, 0 failed. A wider run after the chat merge
  (adds webhook_sync, startup, output_v3, interfaces/rest, lib/knowledge, work): 268 suites, 4170
  tests, 0 failed once the two chat parity tests were updated.
- `pnpm checks:corpus`: exit 0, no FAIL line.
- Integration on 9432, one at a time (no other integration run in `ps`): alice_bob 1/1,
  secrets_postgres 15/15, inbound_work 17/17, callback_body_order 4/4, callback_fire_race 9/9,
  callback_revocation 3/3, callback_store 25/25, run_host_contract (Postgres) 42/42.
  The run used `.env.example`'s encryption test keys (no `.env` exists here).

## Flags for Henry

- Protocol 2 still drops a polled event's `idempotencyKey` and a file's `size` (Gmail, Slack), and
  carries no construction arguments (Airtable `base:`) or model capability (Affinity, Slack
  composition). protocol.ts was conncreds' this wave; nobody added them.
- Performance gate for granola and evertrace is still unmeasured (ev4-small: host too busy).
- `@lf/web` off the platform now refuses PDF/PPTX/XLSX links too (the platform reads them through
  its document store, which lf lacks). Narrow to the browser-gated hosts if plain file links
  should be fetched off the platform.
- Kit `module_server.ts` still sends only the first declared credential (conncreds' gap).
