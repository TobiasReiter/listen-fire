# lfr-secrets report — G4: the secrets family and the credential commands in Rust

Branch `lfr-secrets`, cut from 9cfa02d3, with `ev4-lfcreds` merged in (a fast-forward). Status: **done tier**, with one test that needs `lf serve` from lfr-serve.

## Read

- The Rust `lf-host` now refreshes credentials and writes them back, as the TypeScript `lf` does.
  - The same files, the same lock file (`<secrets file>.lock`) and the same entry format, so either binary can refresh or edit the other's secrets.
  - Before this, lf-host refused any call whose token was about to expire.
- lf-host sends a module the credential its manifest declares, on every call.
  - Only the declared fields go, and only over HTTPS or to a loopback address.
  - It refreshes the credential from the declaration, or through the module's own `refreshCredential`.
  - It stores a `credentialUpdate` the module answers, also when the call failed.
- New commands, matching the TypeScript `lf` in output and file format:
  - `lf-host connect [<module>]`
  - `lf-host credential add|update|delete|list`
  - `lf-host completion <bash|zsh|fish>`
- Results under `LF_BIN=lf-host`:
  - Secrets tests: all 6 that failed at the base now pass (5 refresh tests, plus the declared-credential test).
  - `connect.test.ts`: 11 of 12 pass.
  - The 12th, `--public`, needs `lf-host serve`, which lfr-serve owns. Checked by hand: the Rust `credential add --public` finished through the TypeScript `lf serve`.
- Not in my stream, found while running the whole suite: 3 `modules.test.ts` cases fail under `LF_BIN` only because lf-host cannot find `serve-module`.
  - They pass with `LF_SERVE_MODULE=packages/module-kit/bin/serve-module.cjs`.
  - That includes the `@lf/dealroom` walk with its declared credential, which goes through this stream's code.
  - The fix is lf-host finding module-kit's runner the way the TypeScript `lf` does (it calls `require.resolve`). It is one change, in where lf-host starts an external. Nobody owns it yet.

## Decisions and why

- **Only lf-host's stores are tested over RPC, not its family.** The contract cases drive the store through the TypeScript family, and their token endpoint is a fake `fetch` inside the test. So `lf-host --contract-secrets <file|env>` serves one store: read, write-back, lock and unlock, check writable.
  - The family's own rules are tested in cargo: write-back conflicts, one refresh for two callers, redaction, warning once.
  - It is also tested end to end by the `LF_BIN` runs.
  - In the "two handles" case the sibling is a second lf-host process. That proves the lock file across processes.
- **YAML is edited by lines.** No Rust YAML library keeps comments, and the tests require them kept.
  - A changed field keeps its line. A new field goes after the entry's last one. Whole entries are replaced or removed in place.
  - A value that would read back as another type (`"8765"`, `"true"`, `""`) is quoted.
  - A file that is a flow mapping (`{}`) is written out again in full.
- **One secrets family per loaded credential,** kept in a process-wide table (by name and file). The TypeScript `lf` does the same, keyed by the credential object. One table means every call path shares one single flight: describe, run, plugin and door calls.
- **A credential with no refresher never touches the family.** The bearer secret comes from the fields as loaded or last written. This matches the TypeScript `withCredential`. It keeps `connect`'s temporary install (held in memory only) from being read as empty.
- **`send` takes a separate signer.** That is the entry whose secret the external checks. Today callers pass the credential itself. ev4-conncreds plans an install that signs, with the user's credential travelling in the body; that merge then only changes what callers pass.
- **Reused ev4-conncreds' `Binding` enum and entry parsing,** word for word, so those lines merge cleanly. I did not take its runtime change (`credential_for` skipping installs, `signer_of`): the TypeScript `lf` on this branch still uses the first entry.
- **HTTPS out for token endpoints** uses rustls with the bundled root certificates (`src/http_out.rs`), the same three crate lines lfr-llm adds. The protocol client to externals stays plain HTTP. An `https` external is still refused, as before.
- **Removed `protocol::post_rpc`.** It is replaced by `post_rpc_carrying(call, credential)`, which returns the answer and the `credentialUpdate`. Its only callers were `externals.rs` and `remote.rs`, and both now go through `credential_calls::send`. A sibling that calls `post_rpc` gets a compile error at merge. The fix is `post_rpc_carrying(call, None).await.0`.
- **The completion scripts ask the binary for names.** Module and credential names come from `completion --list modules|credentials`, run in the current folder. The scripts use the binary's own name (argv[0]), so they keep working when it becomes `lf`.

## Tests

- **cargo test -p lf-host:** 55 of 55. **clippy `--all-targets -D warnings`:** clean.
- **apps/cli on the TypeScript lf** (whole set): 253 pass, 0 fail, 23 skipped.
- **apps/cli with `LF_BIN=target/debug/lf-host`** (whole set): 234 pass, 19 fail, 23 skipped.
  - At 9cfa02d3 plus ev4-lfcreds, 36 failed: the 24 known failures and the 12 `connect.test.ts` cases.
  - The 19 left:
    - callbacks and cancel: 5
    - serve and webhooks: 6
    - `--public` (needs serve): 1
    - models: 2
    - upgrade: 2
    - modules: 3, which need `serve-module` (see above)
- **New, run on both binaries:** a `credentialUpdate` test in `secrets_declared.test.ts`.
  - listEntryPoints rotates the refresh token.
  - The first describe fails `unauthorized` and rotates the webhook secret.
  - The host stores both, refreshes once with the module's token, and retries.
- **Secrets contract against lf-host** (`secrets_contract_rust.test.ts`): 33 of 33.
  - Plain file, SOPS through a stand-in `sops`, and the environment.
  - The real sops + age suite is skipped: neither tool is installed here, as for the TypeScript suite.
- **`tsc --noEmit` apps/cli:** clean.
- **WASM artifacts:** `scripts/build-movement-wasm.sh` rebuilds both byte-identical (`packages/movement-lang/wasm` is clean).
- **Not run:** integration tests. None are named for this stream.

## Files outside this stream (shared, minimal)

- `crates/lf-host/src/main.rs`:
  - module lines;
  - `credential_cmd::dispatch` ahead of the argument parser (connect, credential, completion);
  - `--contract-secrets`;
  - usage text.
- `crates/lf-host/Cargo.toml`: `rustls`, `tokio-rustls` and `webpki-roots` (the same lines as lfr-llm), plus `url` and `getrandom`. Both were already in Cargo.lock. Cargo.lock only adds packages.
- `crates/lf-host/src/secrets.rs`:
  - `Credential` gains `binding` (as ev4-conncreds has it) and `origin` (the file, and the fields the environment supplied);
  - `install_of`;
  - `refuse_stale` removed.
- `crates/lf-host/src/externals.rs`:
  - calls go through `credential_calls::send`;
  - `RunningExternal` gains `credential_declarations` and `manifest_answer`;
  - `call_secret` removed (replaced in `credential_calls`).
- `crates/lf-host/src/remote.rs`: an instance's call goes through `credential_calls::send`.
- `crates/lf-host/src/protocol.rs`: `post_rpc_carrying` (above).
- New files:
  - in `crates/lf-host/src`: `secrets_family.rs`, `secret_stores.rs`, `credential_calls.rs`, `oauth2.rs`, `http_out.rs`, `prompt.rs`, `oauth_redirect.rs`, `connect.rs`, `credential_cmd.rs`, `completion.rs`, `contract_secrets.rs`;
  - in `apps/cli/src/__test__`: `rpc_secrets.ts`, `secrets_contract_rust.test.ts`.

## For lfr-serve

- Mount `oauth_redirect::deliver_public_redirect(lf_dir, query) -> (status, text)` at `GET /oauth/callback`. Answer with `text/plain; charset=utf-8`, the text plus a newline.
- It writes `.lf/oauth/<sha256(state)>.json` only where a `.waiting` marker exists. These are the same files the TypeScript `lf` uses.
- The function carries `#[allow(dead_code)]` until it is mounted.
