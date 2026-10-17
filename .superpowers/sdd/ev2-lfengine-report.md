# ev2-lfengine report — decision #7, slices G2–G3

Branch `ev2-lfengine`, cut from da4342f9. Status: **done**, both slices.

## Read

- `lf-host` now runs movements.
  - `run --event <file> [--dry-run]` routes an event to the listens it matches and runs each one.
  - `resume [<run>]` steps parked runs, and drains due work first when no run is named.
  - `runs` lists the runs.
- The Rust engine is linked into the binary and driven natively, not through WASM.
- A sleep or an await parks into the same SQLite state file the TypeScript `lf` writes.
  - Either binary can resume a run the other parked.
  - Parked state uses version 2, with code by reference and the library source store.
- Externals are processes reached over adapter protocol 2 (plain HTTP).
  - Every answer is checked against the protocol's schemas.
  - Files cross as URLs.
  - The per-run call ceiling and dry-run capture work as they do in `lf`.
- Parity holds on the run path. Both binaries print the same lines, exit alike, and leave the same state file and the same writes in the external. Only ids and instants differ. Cases covered:
  - the example
  - the join and await fixtures
  - FILE() writes
  - a file kept across a park
  - a dry run
  - the call ceiling
  - a check failure
  - the example against the reference fake CRM (from apps/api), started as an external process
- Not in lf-host yet (other slices). The TypeScript `lf` is unchanged and still has all of these:
  - `serve` and the inbound doors, callbacks and `cancel` (G5)
  - model calls (G6)
  - credential refresh (G4)
  - `run --webhook`
  - Record bindings: a movement that binds records fails, naming the family.

## Decisions and why

- **The engine is driven over the WASM boundary's own JSON texts.**
  - Each answer goes in through the engine's `read_answer`. Each step comes out as `to_sorted_json`, with its text converted out of the engine's internal form.
  - Natively, the engine sees exactly the bytes the artifact sees. Text-form handling and number formatting cannot drift between the two hosts.
- **Routing lives in lf-host (`src/routing.rs`), not in a new `crates/movement-routing`.**
  - It reads listens from the typed AST of the parser crate, so a separate crate would hold three small functions.
  - It can move out when a second Rust host needs it.
- **The protocol result schemas are ported as a small zod-like checker (`src/wire_results.rs`).**
  - It follows zod's output rules: declared keys first, absent optional keys left out, other keys stripped unless the object passes them through.
  - This was needed because what the engine receives must match TypeScript, and zod drops unknown keys (for example from `listEventTypes` and `getRelated`).
  - Thin: four methods are not checked yet: `translateFilter`, `getDedupRules`, and the `ensure`/`remove` inputs.
- **Lease renewal runs alongside the work**, racing it in one task rather than spawning a timer. This keeps everything on one thread with no `'static` state.
- **Exposed files are served by a minimal hand-written GET responder on loopback.**
  - hyper's server feature would add a crate (`httpdate`) to Cargo.lock.
  - The doors slice (G5) can switch it to hyper when it brings in the server.
- **`apps/api/src/scripts/dev/fake_crm_external.ts` is new.** It wraps the fake CRM as an lf external (it prints `listening <port>`).
  - The cli package still imports nothing from apps/api.
  - The test fixture only names that script as the external's command.
- **The chat model list sent with each run is a fixed constant**: the TypeScript lf's current list. G6 replaces it when lf-host calls models.

## Tests

- **cargo test -p lf-host:** 36 of 36.
- **cargo clippy -p lf-host --all-targets -D warnings:** clean.
- **WASM rebuild** (`scripts/build-movement-wasm.sh`): both artifacts are byte-identical. Cargo.lock only adds `movement-engine` and `sha2` to lf-host's dependency list.
- **apps/cli on the TypeScript lf:** 138 of 138, including the 7 new run parity tests.
- **Contract suite plus both parity files against lf-host:** 47 of 47 (30 contract, 10 check parity, 7 run parity).
- **apps/cli spawn tests with `LF_BIN=target/debug/lf-host`:** 19 of 36. Before this slice it was 11.
  - Every run, park, resume, FILE, dry-run, ceiling, secrets-file, environment-secrets and missing-credential test passes.
  - The 17 that fail need slices G4, G5 and G6:
    - serve and webhooks: 6
    - callbacks and cancel: 5
    - credential refresh: 4
    - models: 2
- **Type-check:** apps/cli and apps/api both pass. The engine-boundary guard is unchanged (813 imports, at its baseline).
- **Not run:** integration tests and jest; this change needs neither.

## Files outside this stream

- `apps/api/src/scripts/dev/fake_crm_external.ts`: new file, only used by the parity test.
- `Cargo.lock`: two dependency lines for lf-host.
- `CHANGELOG.md`: the `### ev2-lfengine` section.
