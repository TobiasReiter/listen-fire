# v5b-admit — report (branch `v5b-admit`, from `v5-surface` at 0be6bf0a)

## Read
- **Cause: positional calls, not a v5 lowering difference.**
  - A positional call (`n = make(l)`) carries a second copy of itself as one expression. Version 5 writes every function call positionally.
  - Admission's scan for calls nested in a statement read that copy. It found the statement's own call there and treated it as a call nested in an expression, whose value must be plain data.
  - A function handing back a node or a record therefore marked its own call "unknown", and the call was refused as `movement_call`.
  - The same program written positionally under v3/v4 was refused too. The v4 programs in the brief ran only because they used named arguments.
- **Fix (admit.rs, f0b71184, d077e383).**
  - The copy belongs to a call that runs as a call: a function's, a plugin's, a closure's, or one through a value. For that copy, admission still records what the call hands back, but no longer refuses it as a nested value.
  - A built-in's copy is unchanged, because the engine really evaluates that copy as an expression.
  - Calls genuinely nested in an expression (`Text.upper(make("a"))`) are still refused as before.
  - My first version skipped the copy entirely. That lost the call's return holder and refused closures that return a function's call (`k = (v) => stamp(v)`). The second commit fixes this. The unit test covers both cases.
- **Sweep result: zero admission refusals for v5 programs that check clean.** The two exempt `resume_state_kind:blockMeta` states are the only exceptions.
  - v5 probe (473 programs, respelled for v5 by the upgrade tool): every program that checks clean runs whole on Rust.
    - Refusals left: `match_root_not_held` (2) and `expression_closure` (1). Both programs fail checking on both engines with an identical error, so they are not admission gaps.
  - apps/api `services/movement_engine` unit set under `MOVEMENT_ENGINE=rust`, with every admission refusal logged and its source kept:
    - Two refusals are fixed: `rust_park_identity` (a library closure calling a function, across a sleep) and `nested_calls`.
    - Two `write_field_record` refusals at v5 remain in `body_closure_scope`. They are not listed as fixed (see "Left").
- **Both engines byte-identical.**
  - Probe: the TypeScript and Rust endings differ on only 2 of 473 programs. Both are Rust-checker parity gaps, not admission:
    - a fix text that holds `#call@7:11`;
    - `block_head_root`: the Rust checker passes `Lead-[c:companies]->`, which the TypeScript checker refuses.
  - The new probe programs (a node returned, a record returned, a library's lazy node across a sleep) run whole and identically under both v4 and v5.
- **Against a base build (engine wasm built from 0be6bf0a), on the 41 failing suites:**
  - No new failures.
  - One test now passes: rust_engine "binds a call's value: a value, a node, a record…".
  - Differences that look like new failures are timeouts or flakes under load from tests that use the HTTP host double or concurrency. They pass on a rerun.

## Left / for the controller
- **`body_closure_scope` at v5 is still refused** (`write_field_record`): `h = mk(2); r = h(go); write …{ payload: { r: r } }` (library `mk` hands back a closure called with the event).
  - Not confirmed: whether this program checks clean, and whether the test expects the refusal. I did not find its source here.
  - Next step: check what the test asserts.
- **Gap not specific to v5:** a field read off a nested call that returns a record (`say(pick("Beta").name)`) is refused as `nested_movement_call` on v4 and v5 alike. It is not in any test.
- **patterns.json is stale for its v5 programs.** It was last generated before the v5 spelling.
  - The patterns oracle now respells programs for version 5 (main file and library files, through `spelledFor`), so regenerating patterns.json after the wasm rebuild will change its v5 rows.
  - I did not regenerate it.
- **Overlap with v5b-tsengine:** its report's R2 tests describe the same cause, and it verified a narrower fix (the statement's own call only) and reverted it. My fix covers that case plus call arguments and a plugin call's own copy (`summarise(pick("Acme"))`). Its R2 tests should pass on this branch.
- wasm was rebuilt locally for the TS-side runs and not committed.
