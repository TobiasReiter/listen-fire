# v5f-event — item g: reads off an event the catalog does not describe

Branch `v5f-event`, from `v5-surface` 27dbc292. Two commits:

- b5030a59: version 5 refuses (both checkers, with tests).
- 30190916: versions 3–4 warn, plus PARITY.md and PORT.md.
  - Kept separate so it can be dropped on its own (see the fallout below).

## The rule as built

- **Trigger:** a movement's (or v5 function's) parameter is typed as an event address (`<runs-[:Invocation]->>`).
  - The instance it names was built from an adapter the catalog knows.
  - The catalog has no description of that instance.
- **Fires:** at each read off the parameter, each walk off it and each write off it.
  - Read: `go.x`, reported at the expression slot.
  - Walk or write: `go-[r:record]-> {…}` or `write go-[:x]-> {…}`, reported at the path head.
  - Narrowing (`rec is <…>`) does not silence it, because nothing can narrow an untyped value.
- **Does not fire:**
  - when the parameter is only passed along whole;
  - when the adapter itself is unknown (that error is already reported);
  - on closure or library-function parameters (not in scope).
- **Message:** `'runs-[:Invocation]->' has no description in the catalog, so a read or write off 'go' can't be checked — it would be null at run time. The catalog describes it from the system behind 'runs': check that its connection resolves and the system answers, then check again.`
- **Severity by version:**
  - v5: error.
  - v3–4: warning.
  - v1–2: nothing.
- **Parity:** 255 of 255 codes; the new code matches on all 394 of its diagnostics, with 0 extra and v1–4 records exact.

## Measurement (done first, as asked)

- **Real catalogs:** not the gap.
  - Every real adapter in the hits (email, manual, attio) describes its events through its `describe`.
  - The host's real catalog leaves an instance undescribed only when its connection does not resolve or introspection throws.
  - In both cases the host already records a catalog gap ("unverified").
  - So under v5 a provider outage at check time now also gives these refusals, which is consistent with that gap.
- **Corpus records that get the code:**
  - checks.json: 120 of 19,918 v5 records, 66 of 6,647 v4, 62 of 3,575 v3.
  - These come from about 139 distinct programs, all on test catalogs that leave the instance undescribed:
    - email: 125 (`check.unit.test.ts`'s mock catalog gives email no schema);
    - attio: 8 (same catalog);
    - loose: 4 (`delete_declared`, and an apps/api test);
    - manual: 2 (apps/api engine tests).
  - checks.json includes the v1–v4 old-release suites and the apps/api engine tests.

## Fallout left for the controller (not fixed here)

- **Current TS checker tests:** about 50 now fail on the new code.
  - Most are in check.unit.test.ts, plus delete_declared and the checks regression pin.
  - I tried describing email in that mock catalog (subject, text, sender, files). Real diagnostics then surfaced that the schemaless tests had been hiding:
    - MOV_TRAVERSE_UNKNOWN_EDGE `mentions`;
    - MOV_FOLD_NEEDS_ORDER and MOV_ABSENT_REQUIRED on `first(msg-[s:sender]->…)`.
  - Attio's `IS` unions need a full event schema as well.
  - That rewrite changes what the tests mean, so I reverted it. The decision is: describe the events in the shared mock catalog and rewrite those tests, or re-pin them.
- **checks.json pin:** not re-harvested.
  - The base already drifts on about 1,700 v5 records because of the old spelling.
  - 248 records change because of this rule.
- **Old-release v3/v4 suites (run verbatim):** 3 more tests fail per version, all because of the 3–4 warning.
  - The MOV_LISTEN_MISSING trio in `__conformance__/v{3,4}/checker/__test__/check.unit.test.ts` (each asserts exactly one diagnostic).
  - Triage only covers internal refactors, and this warning is visible to authors.
  - So the warning is a v3/v4 behaviour change. Dropping 30190916 restores the old behaviour.
  - An option instead: an upgrade-only warning (`upgradingFrom` 3 or 4 to 5), which leaves v3/v4 records exact.
- **apps/api engine tests:** not run. Programs on the `manual` and `loose` catalogs that read off the event will now be refused at v5.
- **Pre-existing, unrelated:** the Rust test `tests/extraction.rs` (`stages_calls_and_annotations…`) expects MOV_PLUGIN_ROW_UNDECLARED. It does not touch this code.

## Files

- TypeScript:
  - `packages/movement-lang/checker/typing.ts`: code, `UndescribedEvent`, severity and message, the read hook;
  - `check.ts`: the parameter flag and the path-head hook;
  - `scopes.ts`;
  - test `checker/__test__/event_undescribed.unit.test.ts`.
- Rust:
  - `crates/movement-checker/src/families/walks.rs`: struct, diagnostic, note and head report;
  - `types/infer.rs`, `types/scope_env.rs`, `scope.rs`, `checker.rs`, `codes.rs`;
  - test `tests/event_undescribed.rs`.
- The wasm was not rebuilt.
