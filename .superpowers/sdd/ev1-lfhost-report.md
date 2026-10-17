# ev1-lfhost report — stream G0–G1 (the Rust lf-host binary, first slices)

Branch `ev1-lfhost`, cut from 4ba5f821. Status: **done**, both slices.

## What landed

- **G0.** A new crate, `crates/lf-host`, builds the binary `lf-host`. It runs on single-threaded tokio.
  - It reads the project as the TypeScript lf does: `lf.yaml`, secrets (file, SOPS, environment), and externals (`lf-external.yaml`).
  - It refuses a language pin below version 5, the way the TypeScript lf does.
  - `lf-host check` starts the externals and asks each one, over protocol 2 HTTP, for its manifest, its entry points and a describe of each.
  - It then builds the catalog snapshot and runs the Rust checker natively. This is the same check the engine artifact's `check_program` export runs.
  - Its output and exit code are exactly those of `lf check`.
  - `lf-host catalog` prints the catalog as JSON.
- **G1.** A SQLite run-host store in Rust.
  - It uses the TypeScript lf's schema verbatim. A cargo test reads `SCHEMA` off `apps/cli/src/state.ts` and asserts the two are equal.
  - It runs the same SQL statements, and writes instants in `toISOString` form so they compare as text.
  - `lf-host --contract-store <state.db>` serves the store over stdin/stdout, one JSON-RPC 2.0 message per line.
  - A new TypeScript class, `RpcStoreBackend` (`packages/movement-engine/services/run_host/rpc_store.ts`), drives the store from the contract suite. It rethrows the server's lease-lost error as the core's `RunLeaseLost`.
- **LF_BIN.** Setting `LF_BIN=<binary>` makes the cli tests spawn that binary instead of the TypeScript entry point. Five spawn sites now go through one helper, `lfCommand`.

## Decisions and why

- **The catalog is written in the TypeScript key order.** The Rust catalog loader reads several maps in text order (its `JsMap`). serde_json sorts keys, and its `preserve_order` feature must stay off workspace-wide for the parser's sake. So lf-host has its own small ordered-JSON type (`src/json.rs`). That type is also used to read what externals answer and to store state blobs.
- **The schema projection was ported whole**, not just the parts the example uses. Porting only the subset would degrade silently on any other external. Parity is tested over three wide fixtures through a probe, `lf-host --project-schema`. The fixtures cover unions, discriminated writes, write unions, uniqueness, fuzzy resolution, root capabilities, reached types and lazily walked instances.
- **A TypeScript quirk is reproduced on purpose.** The TypeScript remote adapter always reports in-place update support, because `updateRecord` is never pruned. The port keeps that, with a comment.
- **Fixed in the TypeScript lf.** `lf check` reported every parse error at column 1. Its regex looked for `column` but the message says `col`. It now reads the error's own position. I fixed it rather than copy the bug into Rust. It is a one-hunk change in `apps/cli/src/sources.ts`, which is not my stream's file.
- **Thin on purpose (later slices):**
  - Externals are reached over plain HTTP only. An `https` url is refused loudly.
  - Protocol calls are not retried.
  - Wire validation covers only the envelopes check reads (the same passthrough envelopes the zod schemas declare).
  - An OAuth credential that would need a refresh before its call is refused, not sent stale (G4).
  - Error wording for a malformed `lf.yaml` or `lf-external.yaml` is close to the TypeScript lf's but not identical.
  - `run`, `resume`, `serve`, `init`, `upgrade` and `runs` print "not in lf-host yet" and exit 2.
- **The parity tests build lf-host when needed.** If `LF_HOST_BIN` is not set, the tests run `cargo build -p lf-host` rather than skip, so they never pass vacuously.

## Tests

- **cargo:** `cargo test -p lf-host` passes 10 of 10. `cargo clippy -p lf-host --all-targets -D warnings` is clean.
- **WASM artifacts:** `scripts/build-movement-wasm.sh` rebuilds both byte-identical (git status of `packages/movement-lang/wasm` is clean). The `Cargo.lock` change only adds packages; no existing version moved.
- **Run-host contract suite against lf-host:** 30 of 30. The suite has 30 cases at this base; the brief said 29. The TypeScript SQLite suite still passes 30 of 30.
- **Parity (`lf_host_parity.test.ts`):** 10 of 10.
  - The catalog snapshot is byte-identical to the TypeScript lf's.
  - `check` stdout and exit code match on 6 cases: clean, a name nothing binds, a bad config key, an event the external does not declare, a parse error, a missing credential.
  - The schema projection is byte-identical, notes included, on 3 fixtures.
- **Whole apps/cli test set on the TypeScript lf:** 113 of 113.
- **Check tests with `LF_BIN=target/debug/lf-host`:** 5 of 5, from `catalog.test.ts` and `example_project.test.ts`.
- **Type-check:** apps/cli and packages/movement-engine both pass.
- **Not run:** integration tests, jest and rustfmt. This change needs no integration tests. The pinned toolchain has no rustfmt component.

## Files outside this stream

- `apps/cli/src/sources.ts`: the parse-error column fix, one hunk.
- `apps/cli/src/__test__/{example,example_project,externals,models,secrets_identity_files}.test.ts` and `example.ts`: the spawn sites now go through `lfCommand`, and imports changed to match.
- `Cargo.toml`: the workspace members line.
- New files only, nothing else changed:
  - `packages/movement-engine/services/run_host/rpc_store.ts`
  - `apps/cli/src/__test__/lf_host.ts`
  - `apps/cli/src/__test__/run_host_contract_rust.test.ts`
  - `apps/cli/src/__test__/lf_host_parity.test.ts`
