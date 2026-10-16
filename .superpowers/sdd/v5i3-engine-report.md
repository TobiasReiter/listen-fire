# v5i3-engine — report (branch `v5i3-engine`, from `v5-surface` at e46730ca)

## Read

- **g. `pick("Beta").name` was an admission gap. Fixed on Rust.**
  - Both checkers accept a field read off a nested call that hands back a record. The TypeScript engine runs it. Only Rust admission refused it (`nested_movement_call`), on v4 and v5.
  - Fix (admit.rs): a nested call of a function handing back one record whose fields are data is admitted when the only use of it in the expression is a field read. The Rust engine already binds the staged call's value as a statement binds it, so nothing in the engine changed.
  - Still refused: the record itself read as a value (`UPPER(made("a"))`). The same call used once for a field and once whole is refused too.
  - Tests: apps/api `nested_calls` "a field read off a nested call that hands back a record", both engines, v4 and v5. The cases are a write field, a call argument, and a bound call. Rust runs with no fallback and writes what TypeScript writes. Also admit.rs unit tests (the old assertion that this was refused is flipped; two refusals are kept).
- **h. The two v5 `write_field_record` refusals are correct. Only a test was added.**
  - The program writes the event into a json field, through a closure a library hands back. By the language rules this should not check clean: a record is a place, not a value (MOV_WRITE_FIELD_TYPE).
  - It checks clean in that test only because the test catalog leaves the manual event undescribed. The checker cannot name what `go` is, so it says nothing. Even the direct `payload: { r: go }` checks clean there. The TypeScript engine then writes its own internal `{kind: "event"}` description.
  - Rust admission refusing that unchecked record is the right outcome.
  - New test (body_closure_scope): with the event described, as a team catalog describes it, both checkers refuse the same programs (MOV_WRITE_FIELD_TYPE) on v3 and v5. I checked the TypeScript checker separately with a described event: the direct form, a local closure, and a closure a function hands back are all refused.
- **l. Not an engine bug. The test was wrong. Fixed the test.**
  - `ONLY([])` hands back null on every version, so no member ever failed.
  - Under v1–4, `COUNT` skipped the nulls and gave 0. Under v5, `count` counts them and gives 3 (Henry's ruling, 2026-10-16). The same 3 appears with no park at all.
  - With a member that really fails (`ONLY` of two items), both engines leave it out after the resume, exactly as without a park, on v4 and v5. I checked this with a probe.
  - The test now fails only the parked member and asserts `{ n: 2, out: [10, 20] }`, with and without the park. It passes on both engines (82/82 in each run). The v3/v4 conformance copies are unchanged.
- **Memwhere verify: nothing needed restoring.**
  - `v5_memory_where_run`'s extracted cases still used the retired extraction keyword, so they failed checking (MOV_EXTRACT_KEYWORD_RETIRED).
  - I rewrote them to `extractOne(…, node Deals: … { node company … })`, with the model fake in the extraction call's answer form.
  - All 11 tests pass. Each asserts that Rust routed the run and ran it whole (routed 1, ranWhole 1). So the dropped `extract_head` admission is not needed for `extractOne` results.

## Left / for the controller
- The patterns oracle was not regenerated. The README says the two v3 corpus runs still refused are nested movement calls; they may run whole now.
- The wasm was rebuilt locally and not committed. PARITY.md was not touched.
- The checker is silent on the event when the catalog does not describe it. That is true on every version, and it is how the TypeScript engine comes to write `{kind: "event"}`. If that should be refused, it is a checker rule for the checker slice.

## Commits
- 43028e96 test(resume_inside) — item l
- 4d092b32 test(body_closure_scope) — item h
- 6ea7a18b feat(rust admission) — item g
- b723eccd test(v5_memory_where_run) — memwhere check

## Checks run
- cargo test for movement-engine: green. clippy: no warnings on the changed lines.
- apps/api type-check: green.
- Scoped jest over rust_*, nested_calls, body_closure_scope, resume_inside and v5_memory_where_run: 784 passed, 27 failed.
  - All 27 failures are in four suites: rust_run, rust_extract, rust_wire_round_trip and rust_parked_code.
  - Every one fails checking or parsing. Their programs are still in the v1–4 spelling under v5 (for example MOV_EXPR_PARSE "Unexpected 'email'", MOV_FUNCTION_UNKNOWN 'fail', MOV_PLUGIN_ARGS_NAMED).
  - None is an admission refusal. My changes touch no checker or parser code.
  - I did not rerun them on the base build, so "they failed before my changes too" is inferred from the errors, not proved.
