# close-robust report

Branch `close-robust`, cut from c6171c60. Rust crate movement-engine, plus oracle/docs.

## 1. Resume validates its code up front
- `park::resume_refusal_in(state, Some(&checked))` now runs in `run.rs` once the program and the pinned libraries are read, before the run object exists. Every code reference (closure, arm body, local shape declaration, kept walk head and mapping) must resolve to code of the kind the descriptor needs; a name declared in a library the program does not link is refused too. Reason is `resume_state_code_does_not_read`, wire form unchanged (MOVENG_UNSUPPORTED "this run's parked state does not read (…)").
- Not checked: a code ref by name (`shape`/`movement`/`fileClosure`/`opaque`) whose name does not resolve in its file; that still fails mid-resume with MOVENG_RUNTIME ("cannot re-resolve code ref"). Needs a scope, which does not exist before the run starts.
- Patterns oracle: `resume_state_code_does_not_read` now ends `state_refused`.

## 2. Host answers validated where read
Decision: validate in the engine (single place; the shim only forwards). `Failure::host_answer(call, wanted, got)` -> MOVENG_RUNTIME "the host's <call> answered something malformed: expected <x>, got <y>".
- `lookup.resolveActingUser` ({principal:{id, display?}, email?} or nothing) — the oracle's `meta:user_email` case.
- `llm.transforms.invoke` (text/data/records/outcome, every record an object) — the oracle's `plugin_call:records` cases. The old spread of string/number records is gone.
- Also the other TypeError mirrors: `park.callbacks.calls` (list), `resolveAwait` (object/status/landings), `readRecord` (object or null), `files.resolveFileText` `unreadable` (was an `unreproduced` refusal).
- Tests: `a_malformed_host_answer_ends_the_run_coded_and_names_the_call`, `a_malformed_acting_user_ends_the_run_coded` (every case + the valid ones still run). The callbacks/resolveAwait/readRecord/unreadable checks have no dedicated test.
- Not done: `adapters.call` results in general (arbitrary adapter data; read defensively already). Other families were not audited beyond the sites that threw JS TypeErrors.

## 3. `unreproduced: true` marker: dropped
Nothing read it (the shim never did; Rust is now the reference so there is no TS ending to tell it apart from). The error class `Unreproduced` stays: it is what keeps an engine refusal out of a collection op's `onError`. Removed `marked`, `is_unreproduced`, its test, the README text.

## 4. Cleanup
- Stale comments fixed: run.rs header (refused/declined), `suspend_at`, `native_check`, encode, the `localZone` test input, "admission refused" in file_statement; eval.rs `Fallback` and `Unreproduced` docs (Fallback kept: the standalone evaluator entry returns it; inside a run the reader answers it).
- Unreachable paths turned into `unreachable!`/assert: bound write (MOV_WRITE_BIND_RETIRED), write rooted in an expression (parser refuses), nested call in a file-level value (MOV_FILE_VALUE_RUNS; the guard is deleted). README rows removed.
- Root package.json `engine:refusals` removed (no script behind it). CHANGELOG v5 line no longer mentions `MOVEMENT_ENGINE=rust`. README `test:conformance:v5` was already gone.
- Left: `Failure::unreproduced` at `this statement`, the two run.rs right-hand-side forms, traverse's name read, park's record-as-data, and the encode backstop (a known reachability gap). Not provably unreachable.

## Found, not mine
- The parser wasm traps (Rust panic) on the first program of oracle pattern `extract_proto_field` (`node D { __proto__: <text> … }` inside `extractOne`), on the base too. It blocks `generate.ts`. I regenerated patterns.json with that program excluded and spliced its committed line back; only my three patterns' lines changed.
