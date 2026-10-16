# v5g-tests report

Base: `v5-surface` at 1b11389a. Branch `v5g-tests`. 13 commits, tests only, no code changes. I rebuilt the wasm locally first and it came out byte-identical to the committed one, so nothing was left to commit.

## Read

- Everything is green except two items:
  - movement-lang: the pinned checker corpus `checks.json`, which needs re-harvesting;
  - apps/api: 23 tests on each engine (the same 23), all left unfixed when I reached the context budget.
- I found no code bug that a failure exposed. Every fixed failure was a stale test: the retired extraction keyword run under 5, the old v4 spelling under 5, a through-stage expectation, or a floor that moved because of a version 5 rule.
- **Gap found (decision for Henry):** a null test on an extracted `<text>` field is refused only for the keyword's result. It is not refused for `extract(…)` or `extractOne(…)`, on any version since the call form arrived (3). So under 5 the refusal never fires.
  - The rule reads the keyword's root type. The call's `<text>` field still reads as present text.
  - Fixing it means a new refusal gated to 5 in both checkers.
  - I pinned it as a KNOWN GAP in presence_inference.
- **checks.json drift is a stale harvest, not checker drift.** All 1,798 drifted records fall into explained groups:
  - the keyword retired (1,079 records);
  - the in-memory hop order rule (231) and the undescribed-event rule (63+);
  - positional plugin calls, in respelled fix texts (288);
  - plugins with no row or output: from 5 an ordinary call;
  - under v1–4, 11 records: upgrade *warnings*, plus the union rule's write checks, which hold on every version by design (record_unions' header).
  - One group needed a closer look. The discriminated narrowing (`le.listName == "Deal Pipeline"`) is now lost in 22 replayed records, because their snapshots' narrow keys predate 221a30c0. The live discriminated_read test passes.
  - The fix is `pnpm harvest:checks`, run by the controller once the remaining suites are rewritten. Regenerating the pins from today's checker would pin those 22 records wrong.

## Suites

| suite | before (pass / fail) | after (pass / fail) |
|---|---|---|
| `pnpm -r code:type-check` | apps/admin failed: Prisma client not generated in the worktree (environment, not code) | all 7 packages clean, after `prisma generate` |
| movement-lang `pnpm test` | 5,080 / 70 (11 suites) | 5,149 / 1 (checks_regression: re-harvest) |
| movement-lang conformance v1 | 2,066 / 0 | 2,066 / 0 |
| movement-lang conformance v2 | 2,589 / 32 | 2,589 / 0 (38 skipped) |
| movement-lang conformance v3 | 3,235 / 32 | 3,235 / 0 (41 skipped) |
| movement-lang conformance v4 | 3,872 / 32 | 3,872 / 0 (125 skipped) |
| apps/api unit (4 areas), TypeScript engine | 8,010 / 151 | 8,138 / 23 |
| apps/api unit (4 areas), `MOVEMENT_ENGINE=rust` | 8,011 / 150 | 8,138 / 23 |
| apps/api conformance v1–v4, TypeScript engine | not run before my changes (my changes do not touch them) | 1,419 / 1,817 / 2,965 / 3,062, 0 fail |
| apps/api conformance v1–v4, Rust | same | same, 0 fail |
| apps/cli tests | 69 / 0 | 69 / 0 |
| `cargo test --workspace` | 561 / 0 (2 ignored) | unchanged |

## What changed (one commit each)

- **Conformance v2–v4 triage.** The frozen absent_equality suite runs a table over 1–5. Its version 5 row extracts with the retired keyword, so the triage lists rule out that row only. The corpus files themselves are not edited.
- **check.unit.** The keyword's cases (descriptions, through args, field duplicates, the log_dealflow example) are pinned to 4, in 4's spelling.
- **presence_inference.** Under 5 it extracts through declared shapes and `extractOne`. The keyword's unannotated field and its null-test refusal are pinned to 4. The gap above is pinned too.
- **unification.** The through-stage rules (undeclared row, undeclared output, fed by the extraction) are pinned to 4.
- **record_unions.** It runs on every version, so its programs now go through `spelledFor` under 5.
- **block_returns.** The cases over the keyword's result are pinned to 4.
- **declared_type and order_discipline.** They extract with `extractOne` and a declared shape, or a shape written in place.
- **object_literal.** The catalog now describes the inbox event: from 5, a read off an undescribed event is refused.
- **upgrade.unit.** The through-stage case now pins what the upgrade does: it respells the arguments and leaves the retired keyword for a hand rewrite, in both checkers.
- **upgrade_corpus.** The floor moves from 0.865 to 0.86. The new v5 rule MOV_EVENT_UNDESCRIBED leaves 27 programs for a person to describe; the rate is now 4,890 of 5,673.
- **apps/api extraction.unit, declared_shape_reuse and extract_keyword_prompt.** All three are the keyword's own suites.
  - Each is restored to its text from before the respell, and every run in it is pinned to 4, as rust_extract was.
  - Results: 122/122, 26/26 and 1/1, on both engines.
  - What this costs: declared_shape_reuse's spread writes (`...e`) now run only under 4.

## Remaining failures (23 per engine, the same tests on both)

Owner for all of these: the next test-rewrite pass (unassigned). None belongs to the two items other agents own: the misspelled bare name in a v5 WHERE, and the rule for a plugin with no output.

- **The keyword under 5, in otherwise v5 suites.** Each needs rewriting to `extract(…)` or `extractOne(…)`, or pinning to 4 test by test:
  - kg (3);
  - value_binding_head (3);
  - text_pairs_record_arg (1) and text_serialise (1);
  - run.unit (3): the no-writes trace, "file-level extract", and a value-binding read;
  - files_by_envelope (3): the `extract from [it]` cases;
  - graph_query (1);
  - adapter-whatsapp (1);
  - save.unit (4): a through-staged save expected live, two upgrade-through-save cases whose first save fails, and a library import;
  - story_view (1): its fixture is no longer valid.
- **Not triaged:** seam_guard (2): "reached every method on the manifest" and "an extraction stamping its sources". Probably the same cause, since its fixture extracts, but I did not confirm it.
- **movement-lang checks_regression:** re-harvest, owned by the controller (above).
