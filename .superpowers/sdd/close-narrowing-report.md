# close-narrowing report (2026-10-17)

Branch `close-narrowing`, base c6171c60.

## Finding: the narrowing was already there, in both checkers
- Both checkers already narrow after a branch that always leaves, on every version, as `ISNULL` + `ERROR` did on 1–4.
  - `fail(…)` parses to the same statement `ERROR(…)` does, so it already counts as leaving.
  - A `return` counts from version 3.
  - An `if` counts only when every arm and its `else` leave.
- Every presence check already accepts that narrowing: a write off the record, a required write field, a block's walk, a walk inside an expression (aggregate, exists with a hop).
- `x != null && …` and `x == null || …` already see `x` present on the right side.
- Narrowing never comes from preferring one arm of an `if`. It comes only from branches that always leave (Henry's rule holds).
- Checked against the corpus as well:
  - Every v5 corpus program still refused with MOV_ABSENT_REQUIRED after a null test is a correct refusal: the test's branch can fall through.
  - The 36 upgraded v4 programs left holding MOV_ABSENT_REQUIRED have no guard at all. Only a person can choose where the guard goes.

## What changed
- No checker code changed. No diagnostics changed, so checks.json and PARITY.md are not regenerated. The new programs reach the corpus at the next harvest.
- New twin tests, same programs in both:
  - crates/movement-checker/tests/guard_clause.rs (4 tests)
  - packages/movement-lang/checker/__test__/guard_clause.unit.test.ts (78 cases; each runs the TypeScript checker and the Rust checker through the wasm, and asserts that they agree)
- What the tests cover:
  - 5 positions, unguarded: refused under 5. Under 4, only the two write positions are refused.
  - 7 branches that always leave: each one accepted under 4 and 5.
  - 7 branches that can fall through: each one still refused.
  - The right sides of `&&` and `||`, plus the two opposite forms, which are still refused.
- CHANGELOG: one entry under `### close-narrowing`.

## Verified
- cargo test guard_clause: 4 of 4. Clippy with `-D warnings` on movement-checker, tests included: clean.
- jest guard_clause: 78 of 78.
- movement-lang tsc: clean (the new test file type-checked too).
- reachability: 1 of 1 green (gap list untouched: no gap was a narrowing gap).
- parity: 256 of 256 codes, 172,181 of 172,181 diagnostics matched, 0 extra (only the timing line moved; not committed).

## Shared files touched
- CHANGELOG.md only. Both test files are new.
