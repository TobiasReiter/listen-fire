# v5i3-floors — report (branch `v5i3-floors`, cut from `v5-surface` e46730ca)

## Read

- **The evaluator rise is the extraction ruling's consequence, not a regression.**
  - Counted test by test, the tests whose runs Rust did not refuse ask the Rust evaluator to skip exactly the old ceilings: v1 47, v2 47, v3 67, v4 79.
  - The whole rise sits inside the runs refused as `legacy_extraction`: v1 378, v2 530, v3 538, v4 581.
  - Those runs now run on the TypeScript engine, which offers each expression to the Rust evaluator. In v1, 347 of the 378 are traversals, which the evaluator takes on no run (it does no host reads by design).
  - Before v5-extract those runs ran whole in Rust and never asked the evaluator, so nothing in the evaluator changed.
- **`write_field_record` is only ever a second reason inside the keyword runs.** Every run that names it is also refused as `legacy_extraction` (v1 3, v2 5, v3 5, v4 10). It gets its own ceiling at that first measurement.
- **The floors fell by exactly the runs that moved to the TypeScript engine.**
  - Each corpus lost its `legacy_extraction` count from ran whole plus mirrored together: v1 106 + 1, v2 146 + 1, v3 151 + 1, v4 156 + 1.
  - One keyword run per corpus had ended in the TypeScript's own MOVENG_UNSUPPORTED, so mirroredFailure also falls by one.
- **The Rust-only deprecated-pin failure (v2–v4) is left failing, per the controller.** It is fixed on `cloud-native` (a479858a: the host sends its deprecation as `versionWarning`), which merges later.
  - Cause: the Rust engine's own check (since 2b4e5fac) reads the release it was built with, so the test's redirected release never reaches it.
  - The live copy of the test was patched in bdedf373; the frozen v2–v4 copies predate that patch.
  - I made no commit for it.

## Numbers set (apps/api/src/test/rust_eval_stats.teardown.cjs)

| corpus | floor | refused | everyReason | evaluatorNotAdmitted | mirroredFailure |
|---|---|---|---|---|---|
| v1 | 1033 − 106 = 927 | 107 | legacy_extraction 107, write_field_record 3 | 425 | 6 |
| v2 | 1270 − 146 = 1124 | 147 | legacy_extraction 147, write_field_record 5 | 577 | 6 |
| v3 | 2239 − 151 = 2088 | 152 | legacy_extraction 152, write_field_record 5 | 605 | 4 |
| v4 | 2272 − 156 = 2116 | 157 | legacy_extraction 157, write_field_record 10 | 660 | 6 |

There are dated paragraphs for both the floors and the ceilings in the long comment.

## Evidence

- Method: a temporary probe, not committed. It recorded per test the evaluator count, a reason for each skipped expression, and the refusal reasons. Totals reconcile exactly with the teardown's (for example v2: 577 in the probe, 577 in the stats).
- v1 breakdown of the skipped expressions inside keyword runs: traverse 347, concat 10, isnull 6, coalesce 4, a name that is not a value 5, chunks 2, a value holding a record 2, aggregate 1, llm 1.
- Final runs (wasm rebuilt): all four corpora under Rust pass their teardown (floors met exactly, every ceiling held). v1 is fully green. v2, v3 and v4 each fail only the deprecated-pin test, which is left failing as the controller asked. All four on the default engine are green. The teardown unit test passes 24 of 24.
