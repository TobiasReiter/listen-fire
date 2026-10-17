# lfr-merge report

Branch `lfr-merge`, cut from `cloud-native` at 9cfa02d3. Not pushed. Status: **done**; every check named in the brief is green.

## Read

- The five lf-host streams are merged into one binary, one merge commit each: upgrade, then model calls, then the Postgres store, then secrets, then serve.
- Under `LF_BIN=lf-host`, the whole apps/cli suite passes: 295 pass, 0 fail, 24 skipped.
  - Every target failure at the base (24) is gone, including `connect --public` and the three module tests.
  - No failures remain, so none are left for the per-connection credential work.
- The four fixes the controller decided landed, one commit each.
  1. lf-host finds `serve-module` by itself. External start timeout: lf.yaml `startTimeout` or `--start-timeout`, default 30 s.
  2. The Postgres store uses TLS and verifies the server by default. lf.yaml `store:` can read the URL from an env var or a secrets entry. A password written in lf.yaml is refused.
  3. A Postgres run's trace is stored where the hosted product stores it.
  4. A run cost cap: lf.yaml `maxRunCostUsd`.
- **Decisions for Henry:**
  - **The cost cap's name and behaviour.**
    - I named the key `maxRunCostUsd`, in dollars, after the platform's `MOVEMENT_MAX_RUN_COST_USD`. The brief said "`costCap`", and also "match the platform's setting name and unit".
    - A run that hits the cap **pauses**, as on the platform; it is not failed. `lf resume <run>` carries on and resets the usage count.
    - A callback body cannot pause, so it fails at the cap.
  - **Two new SQLite columns.** The cap needs to know what a run has spent so far. lf-host adds `spent_microdollars` and `cost_cap_baseline_microdollars` to the state file's `run` table.
    - The TypeScript lf never reads them, since it reads rows by column name.
    - They are outside the parity lists that a cargo test keeps equal to state.ts.
    - On Postgres the hosted columns are reused: `diagnostics.costMicrodollars` and `cost_cap_baseline_microdollars`.
  - **Pull cursors on Postgres.** A "notify then pull" source saves a pull cursor. The Postgres store refuses to save it, loudly. The hosted product keeps it on `webhook_subscription`, and lf's installs have no row like that. Today such a source needs the SQLite store.
  - **sslmode=require does not verify the server**, which is what it means in libpq. With no sslmode, or with prefer, verify-ca or verify-full, lf-host does verify.

## Merge resolutions (by intent)

- **main.rs, Cargo.toml, Cargo.lock.**
  - Every stream's commands, flags and modules are kept. `NOT_YET` is now only `init`.
  - The TLS lines that two streams both added appear once. `getrandom` comes from lfr-store.
  - Cargo.lock only adds packages. A script compared it to each parent's lock: nothing is missing and nothing is extra.
- **Callbacks and cancel have ONE copy: the store trait** (lfr-store).
  - lfr-serve's SQLite code now fills the trait's methods. lfr-store's "does not serve callbacks yet" refusals are gone.
  - lfr-serve's own record type, its bridge fallthrough (`callbacks::rpc`) and its `rpc_store.ts` copy are deleted.
  - The callback rules (judging a call, the ledger, refusal) now work on the trait's record and on any store.
  - So `serve`, `call`, `cancel` and `run --webhook` take `--store`, and they work over Postgres too.
- **Inbound doors.** The doors now run over the store trait, not only the SQLite store. The pull cursor became a trait method (SQLite serves it, Postgres refuses it).
- **The callback id generator** exists once (`callbacks::new_callback_id`). It uses getrandom, and the Postgres store uses the same one.
- **`doors.rs SessionReader::call`** goes through `credential_calls::send`, signed by the install and carrying no user credential. That is the brief's `post_rpc_carrying(call, None)` plus the install's bearer.
- **`GET /oauth/callback`** calls `oauth_redirect::deliver_public_redirect`. lfr-serve's stub is deleted.
- **A wake row with no team** now defaults to the store's own tenant, not "local". On Postgres that is the store's team uuid.
- **CHANGELOG.** lfr-store's section had landed under v0.11.0. I moved it under Unreleased and added a `### lfr-merge` section.

## Verification

- Rust: `cargo test --workspace`: 654 pass, 0 fail, 3 ignored. `cargo clippy --workspace --all-targets -D warnings`: clean.
- WASM: `scripts/build-movement-wasm.sh` rebuilt both artifacts byte-identical; git shows no change.
- apps/cli on the TypeScript lf: 294 pass, 0 fail, 25 skipped. The new cost cap test is skipped there, because it is Rust only.
- apps/cli on lf-host (`LF_BIN`): 295 pass, 0 fail, 24 skipped. `LF_SERVE_MODULE` was unset.
- Store contract: 42 of 42 on SQLite, and 42 of 42 on Postgres (test database on port 9432; no other integration run was active).
- Drain test: 3 of 3. It now also checks that a drained run's trace count equals the same run's count on SQLite.
- Inbound contract (`--contract-doors`): 28 pass, 1 skipped (the hosted product's synthetic team).
- Secrets contract (`--contract-secrets`): 33 pass, 11 skipped (sops and age are not installed).
- `NODE_OPTIONS=--max-old-space-size=8192 pnpm -r code:type-check`: clean.
  - The first attempt failed only in apps/admin, because the fresh worktree had no generated Prisma client.
  - After `prisma generate` it passed. No source change was needed.
- TLS was checked by hand against a throwaway TLS Postgres (since removed), using a CA I generated:
  - require: connects.
  - Default: refused, with "UnknownIssuer".
  - verify-full with the CA as `sslrootcert`: connects. The same against 127.0.0.1: refused ("not valid for name").
  - verify-ca against 127.0.0.1: connects.
  - require against the test database on 9432, which has no TLS: refused ("server does not support TLS").
- `store:` in lf.yaml was checked in a temp project:
  - A password written inline: refused.
  - `{ env: … }` with the variable unset: refused.
  - `{ env: … }` with the variable set, and `{ credential: db }`: both resolve.
  - `--store` overrides lf.yaml.
- Cost cap end to end, against a fake Anthropic server (new test in models.test.ts, Rust only): the first model call is made, the run parks before the second, and `lf resume` makes the second call and writes the answer.

## Gaps

- `limitPaused` is not passed to the engine. Other branches of a run paused at its cap carry on until they reach their own priced call.
- The pause's warning text comes from the engine and names `MOVEMENT_MAX_RUN_COST_USD`, the platform's setting, not lf.yaml's key.
