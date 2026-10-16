# rust-checks — Rust provides the checking for anything run on the Rust engine

Branch `rust-checks`, cut from `cloud-native` at 860d053b. Commits:

- 9530e4a0 checker: the check's answer to the engine (stamps + import link) from the Rust checker
- 2b356d4e engine: the native check answers in full (stamps, link, version warning, parse and pin failures)
- 2b4e5fac engine route: every Rust segment checks natively; run.ts pre-checks with the Rust checker; wasm rebuilt
- a40e8d7b api: validation of a v5+ movement is the Rust checker's, against the run's snapshot
- 276dd242 cli: `lf check` is the Rust checker's

## What switched where

- **Engine runs.** Every segment the host runs on the Rust engine now starts with the engine's own check turned on. This covers v5+ under by-version, any version under `MOVEMENT_ENGINE=rust`, resumes, settles, fired callbacks, and every `lf` run.
  - The engine never asks its host for the TypeScript checker's answer (the host call named `check.program`).
  - Before the segment opens, the host checks the program with the Rust checker, so a refused program still makes no host request.
  - A run the Rust engine hands back to the TypeScript engine is checked by the TypeScript checker.
  - TypeScript-engine runs (v1–4 under by-version) keep the TypeScript checker.
  - The admission dry run still names the host call in its first step, which is never answered.
- **API.** All save and validate paths go through one function, `diagnoseMovementSource`: save, validate, the upgrade/deploy check, the tRPC view, and the agents' validate tools.
  - For v5+ it checks with the Rust checker against the run's snapshot, built from the same catalog assembly.
  - v1–4, and a hand-built catalog with no snapshot (unit tests), keep the TypeScript checker.
  - No other API code calls a checker directly.
- **CLI.** `lf check` uses the Rust checker.

## What the host's check answer provided, and how the native check provides it now

- **Diagnostics.** Provided before this change.
- **Stamps.** These are facts the check settles on program nodes:
  - the fields a write's `...spread` writes;
  - what a graph's `...spread` copies;
  - which graph entries hold a record.
  - The Rust checker records them during its walk and places each at its path in the program's JSON (new module `crates/movement-checker/src/answer.rs`).
- **Import link.** Each imported name's declaration, and each library file's source, imports and exports.
- **Deprecated-pin warning.** Provided now.
- **Pin and parse failures.** A pin this release cannot honour fails with `MOVENG_LANGUAGE_VERSION`. A source that does not parse fails with `MOVENG_PARSE`, without asking the host.
- **Model list.** The native check holds a written model to the snapshot's own model list, as the TypeScript checker does. It does not use the run's list.
- **Proof.** A new parity script (`crates/movement-checker/parity/answers.sh`) compares the Rust stamps and link with the TypeScript's.
  - 28,328 of 28,328 corpus records are equal in both stamps and link, with 0 unplaced.
  - That includes 994 records with stamps, 404 with a link and 18 inside nested calls.
- **Still on the TypeScript checker during a Rust run:**
  - the host call that tests `x IS <Decl>` against a system's record (`check.compatible`);
  - a fallback run on the TypeScript engine.
- **Error detail.** A check failure raised inside the engine carries the message but no diagnostics list. In practice the pre-check, which does carry them, catches every refused program first.

## Tests

- **Rust oracles.** The records, handles and parallel oracle suites now also run every case with the native check on, never asking the host. All outcomes equal the TypeScript's.
- **Engine library.** 194 of 194 pass.
  - The native-check test also covers a parse failure: it fails as `MOVENG_PARSE` and makes no host request.
- **API engine tests.**
  - New `rust_native_check.unit.test.ts`:
    - v5 under by-version and v3 under `MOVEMENT_ENGINE=rust` both check with Rust, make no host check request, and run the TypeScript checker 0 times.
    - v4 under by-version uses the TypeScript checker only.
    - A refused v5 program fails with `MOVENG_CHECK` from the Rust checker and makes no engine request.
  - All `rust_*` suites pass: 21 suites, 500 tests.
  - `rust_dancing_wren` needed a change. Its "checker that missed it" case now also hides the miss from the Rust pre-check, and turns the engine's own check off so the engine asks the host for the TypeScript check.
- **API validation.**
  - New `authoring_rust_check.unit.test.ts`. Four programs (one clean, three refused) give equal diagnostics from the Rust and TypeScript checkers on v5, and the Rust checker is the one used.
    - The refusals are an unknown field, an unresolved name and an unknown credential.
  - v4 keeps the TypeScript checker.
  - `validateMovementForTeam` checks against the run snapshot.
  - The save, upgrade, file-import, catalog and validate-before-save suites pass: 7 suites, 132 tests.
- **CLI.**
  - New `lf check` test: a broken example reports `MOV_NAME_UNRESOLVED` by file, line and code.
  - CLI 67 of 67 pass.
- **Type checks.** movement-engine, movement-lang, apps/api and apps/cli all pass.
- **Full engine test folder** (`apps/api` `services/movement_engine/__test__`): 124 of 125 suites pass (4,089 of 4,092 tests).
  - **The 3 failures are open.** They are in `files_by_envelope.unit.test.ts`: the cases where a descriptor-shaped dict reaches `READ`.
  - Both checkers report the same two diagnostics, `MOV_JSON_OPAQUE` and `MOV_READ_NOT_FILE`, but the Rust checker reports them in the opposite order.
  - The test compares the whole error message across the two engines, so the order difference fails it.
  - This order difference was already there. It is one of the 21 corpus records that `PARITY.md` counts as "same diagnostics, not the same order". It shows now because Rust runs are checked by Rust.
  - The fix belongs in the Rust checker's type core. One diagnostic is reported from the typing pass (`families/values.rs:238`, `typing.report`) and the other directly (`families/extraction.rs:816`).
  - I left it alone: that is the code the other agent (`hang-rust`) is working on. The fix is to order the deferred diagnostics as the TypeScript does, then re-run `parity/run.sh` and expect 28,328 exact.
  - I also did not relax the test, which would hide a real difference.

## Wasm

Both artifacts were rebuilt with `scripts/build-movement-wasm.sh`:

| Artifact | Before (raw) | After (raw) | After (gzipped) | Change |
|---|---|---|---|---|
| `movement.wasm` | 5,092,112 bytes | 5,132,477 bytes | 1,476,013 bytes | +40 KB raw |
| `movement_parser.wasm` | — | 1,203,138 bytes | 328,295 bytes | none, byte-identical |

The loader now binds the checker's existing `check_program` export. The new TypeScript entry point is `checkSourceInRust` in `packages/movement-lang/checker/rust_checker.ts`.

## Editor and language service (they stay on TypeScript): what moving them would take

- **Live diagnostics.** The browser loads only `movement_parser.wasm` (about 330 KB gzipped). The checker is linked into the engine artifact (about 1.48 MB gzipped).
  - Moving would take a third artifact containing the parser and checker but no engine.
  - That artifact would need a zone-lookup import, which the browser's `Intl` can answer.
  - The editor would also need an async load. The checker's own size is unmeasured; the engine is most of `movement.wasm`.
  - Once loaded, `checkSourceInRust` would serve the editor unchanged.
- **Completions and hover.** These read the TypeScript checker's internals: scopes, the type at a cursor, and the recording `checkProgramWithLink` returns.
  - The Rust checker exposes none of this.
  - It would need a query interface (scope and type at a position), and the language service's queries would need porting onto it.
  - This is a much larger piece of work than moving the diagnostics.

## Notes

- **Which checker validation uses.** The API chooses by the pinned version (5 and up means Rust), not by `MOVEMENT_ENGINE`. Under `MOVEMENT_ENGINE_V5_ON_TS=true` a v5 run would use the TypeScript checker while validation used Rust. That is harmless at full parity.
- **Run snapshot.** The team catalog now carries `runSnapshot()`, built lazily from the same assembly as the catalog.
- **Shared crate.** I edited the checker crate's families (writes, nodes, calls, imports), its checker struct and `lib.rs`. These are small, additive hooks. I did not touch `src/types`, where the type core lives.
