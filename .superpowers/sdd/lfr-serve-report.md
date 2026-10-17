# lfr-serve report — G5: serve, inbound doors, callbacks, cancel in the Rust lf-host

Branch `lfr-serve`, cut from 9cfa02d3. Status: **done**.

## Read

- `lf-host serve` now does what `lf serve` does.
  - A provider's webhook delivery is verified, read by its external and queued (`/api/public/webhook-sync/<provider>/<install>`).
  - The older `/hooks/<external>/<install>` address runs the events inside the request and answers 202 with the runs.
  - An external's emit and wake pushes are authenticated and queued.
  - A callback's call at `POST /api/cb/<id>` runs its body and answers as the hosted door does.
  - Due work is drained every second, and at once when a door queues some.
- The inbound core is ported whole: the seven signature schemes, the signed-inbound rule, the delivery pipeline, the push doors, and the 100 KB and 1 MB limits.
- Runs mint callbacks. A call's body runs once, under the run's lease, then wakes the awaits on it.
- New commands: `lf-host call`, `lf-host cancel`, `lf-host run --webhook`.
- The 11 target tests now pass under `LF_BIN=lf-host` (callbacks and cancel 5, serve and webhook 6).
- The inbound contract suite passes against lf-host: 28 of 28, plus the one case lf skips (the hosted product's synthetic team).
- The callback and cancel contract cases pass against lf-host's store: 12 more, so 42 of 42 over the bridge.

## Decisions and why

- **The inbound contract runs over a second bridge**, `lf-host --contract-doors`.
  - It serves lf's real doors over HTTP on a loopback port.
  - The suite's world is arranged over stdio JSON-RPC, the same way the store bridge works. The TypeScript side reuses `RpcStoreBackend`'s `call`, so there is no new client.
  - It mirrors the TypeScript lf's contract backend: the world becomes externals and credentials, the suite's adapter reads each delivery, and faults and observations wrap lf's own stores. So the suite exercises the production door code, not a copy.
- **The doors are generic over their stores** (Rust traits), as the TypeScript core is over `InboundStore` and `PushStore`. lf's stores are one implementation; the contract bridge wraps them.
- **One HTTP server for every listener**, on hyper's server feature.
  - The exposed-file listener's hand-written HTTP responder is gone.
  - While `serve` runs, exposed files are fetched from serve's own port (`GET /files/<id>`), so there is one listener, not two.
  - This needed `hyper` "server", which adds `httpdate` to Cargo.lock.
- **`hmac` and `base64` are new dependencies.** I chose the standard crates over hand-written crypto. The lockfile also gains `cmov` and `ctutils` (pulled in by `digest`'s features under `hmac`).
- **The whole binary now runs inside a tokio LocalSet** (one line in `main.rs`). Connections are tasks on the one thread, sharing the session without locks. This keeps the crate's single-threaded design.
- **Where lf serves is process-wide state** (`serve::host_url`). Externals started after `serve` listens get it as `LF_HOST_URL`, and a callback's link falls back to it. I chose this over adding a fifth argument to `start_externals`, which is shared code that other streams change.
- **`lf-host cancel` opens no session.** Settling a run starts no segment, so it needs only the state file. The TypeScript lf opens a session without externals; the result is the same.
- **`GET /oauth/callback` is a stub that lfr-secrets will replace.** It is one function, `serve::public_oauth_redirect`. Until then it does exactly what the TypeScript lf does: it writes the redirect's query to `.lf/oauth/<sha256(state)>.json` for the waiting command. So a waiting TypeScript `lf credential` picks it up today.
- **Deviations from the TypeScript lf:**
  - A callback date value without a timezone is read as UTC. JavaScript's `new Date` reads it as local time. A full instant or a `YYYY-MM-DD` date reads the same in both.
  - `serve` opens the session before it accepts connections. A request that arrives during startup waits instead of getting the TypeScript 503 "starting".
  - Log lines for internal failures go to stderr. The TypeScript lf logs them through the engine's logger.

## Tests

- **cargo test -p lf-host:** 50 of 50. **clippy `-D warnings`:** clean.
- **apps/cli on the TypeScript lf:** 251 pass, 0 fail, 13 skipped. The skips are the SOPS and age suites (not installed here) and the synthetic case in each of the two inbound contract files.
- **apps/cli with `LF_BIN=lf-host`:** 236 pass, 15 fail (26 failed at 9cfa02d3). None of the 15 is this stream's:
  - lf connect: 3
  - models: 2
  - module externals: 3
  - credential refresh: 5
  - upgrade: 2
- **Type-check:** apps/cli and packages/movement-engine are clean.
- **WASM rebuild** (`scripts/build-movement-wasm.sh`): both artifacts are byte-identical; git shows no change.
- **Not run:** integration tests (none named) and the dev loop.

## Files outside this stream's new files

These are the minimal shared-file edits:

- `crates/lf-host/Cargo.toml`: tokio `signal`, hyper `server`, `hmac`, `base64`.
- `Cargo.lock`: the new packages above.
- `crates/lf-host/src/main.rs`:
  - six new module lines;
  - the new flags (`--body`, `--install`, `--header`, `--port`, `--reason`, `--contract-doors`);
  - the `serve`, `call`, `cancel` and `run --webhook` arms;
  - the usage text;
  - the LocalSet.
- `store.rs`: `db`, `transaction` and `holds` are now `pub(crate)`.
- `contract_store.rs`: unknown methods fall through to `callbacks::rpc`.
- `externals.rs`:
  - the `webhook:` block and the manifest's `inbound` declaration;
  - `LF_HOST_URL` for started externals.
- `project.rs`: `publicUrl`.
- `segment.rs`: serves `park.callbacks.mint` and `park.callbacks.calls`, plus the callback-body entry.
- `runs.rs`:
  - the segment builder is factored out;
  - await wakes also step callback-backed awaits;
  - new: `fire_callback` work, `call_callback`, `cancel_run`, and session accessors.
- `documents.rs`: moved onto the shared HTTP server; added `serve_at` and `exposed`.
- TypeScript:
  - `rpc_store.ts` now forwards the callback family and the run records;
  - `run_host_contract_rust.test.ts` adds the callback and cancel cases;
  - `inbound_contract_rust.test.ts` is new.
- `CHANGELOG.md`: `### lfr-serve`.

## Overlap with sibling branches, for the merge

I have not merged either branch.

- **lfr-secrets** (HEAD 7e7ccd6c):
  - It removed `protocol::post_rpc`. My one caller is `doors.rs` `SessionReader::call`; switch it to `post_rpc_carrying(call, None).await.0`.
  - It provides `oauth_redirect::deliver_public_redirect`. Replace the body of `serve::public_oauth_redirect` with a call to it.
  - It may change the `Credential` shape. `doors.rs` and `contract_doors.rs` build and read credentials by `name`, `external` and `fields`.
- **lfr-store** also added callback, records and runs methods to the RPC bridge (`rpc_store.ts`, `contract_store.rs`), and made callbacks and cancel store-trait methods. Both branches touch the same ground:
  - my `callbacks::rpc` fallthrough in `contract_store.rs`;
  - `RpcStoreBackend`'s `callbacks`, `runs`, `requestCancel`, `runStatus` and `completeRun`;
  - the `impl Store` callback family in `callbacks.rs`.
  - At the merge, keep one copy (theirs if it is the trait). Point `runs.rs`, `segment.rs` and the contract test at it.
