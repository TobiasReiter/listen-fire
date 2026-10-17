# close-forms report (2026-10-17)

Branch `close-forms`, base c6171c60. Seven commits. movement.wasm gz 1,266,053 → 1,268,851 (+2,798; rebuilt in the worktree, not committed).

## Done (gaps removed from the reachability list)

- **A walk from a callback in an expression** (d50ddd1d). `Text.join(cb-[k:Called]->.`note`, ", ")` and `count(cb-[k:Called]->)` read the calls recorded so far, exactly as a block over the callback does (same ledger read, same WHERE). Hops past `Called` walk on over the records in hand.
- **`await first(x-[:Edge]->)` on a record the run read, not wrote** (c8d60515). The record can be the event, a walk's landing, or one record a value holds (`c = only(e-[k:Checks]->)`). The await asks the system the record was read from, by the record's own id; the record's inline data goes along as the head's data. From there it is the same check, bind and park as an await on a written record.
- **A kept (`lazy`) walk read as a bare value** (474c7a4f). `count(people)` is the records the walk lands on at that read, after a resume too.
- **The event read as a bare value** (474c7a4f). `coalesce(msg, r)` reads the event as the record that fired the run, as any landed record reads.
- **Endings that depend on what the system answers are now ordinary run failures (`MOVENG_RUNTIME`)** (c8d60515, 71b60704):
  - an await on a system whose adapter cannot be awaited;
  - `DOMAIN_OF()` (or any integration function) written to a field the system does not offer it on. The checker lets such a name through only in a write field's value, and which functions a field offers is the system's run-time answer;
  - a collection op over a value that read as empty. The message no longer says the checker should have caught it. A value of the wrong type (not empty) still says so.
  - An await on a value holding nothing (`c = first(…)` found none) is a `MOVENG_RUNTIME` failure too.

## Behaviour decisions

- An await over a list of records (`x = e-[a:Attachments]-> { return a }`, then `await first(x-[:Answer]->)`) is still refused, now by its own name: "await '…' over a list of records". Why: an await parks on one record's edge under one key, and the host contract takes one key. It is on the gap list under "checker refusals still to add", since the checks corpus reaches it.
- I made no checker changes. Parity is untouched (no checks.json or PARITY.md changes).

## Handed to close-refusals (better refused by the checker)

- **`KG_VALUE` / `KG_EXISTS`** (the "expression kind" gap, in any position, not only inside a list). Both are retired: the old save scan refused them as retired, and the engine has no case for them. The checker still passes them from version 5. Recommendation: refuse them from version 5 by name, pointing at a traversal. The gap line stays.
- **A record written into a field that is also a relationship** (`write graph-[:deals]-> { company: co }`, the "write handle to the host" gap). The checker accepts it, with only an Info nudge (MOV_WRITE_LINK_FIELD_NUDGE) to link the two records instead. But the field is typed text, and a record has no meaning on the wire. Recommendation: from version 5, make the nudge a refusal. The gap line stays.
- **An await over a list of records** (above).

## Tests

- cargo test, movement-engine: all green (lib 149). Clippy clean.
- Reachability: green, 1 of 1. Ten gaps reached, all listed.
- Scoped jest: callback_run, rust_concurrency (2 new snapshots), patterns_inventory, reachability: 51 of 51.
- The whole `services/movement_engine/__test__` set (reachability excluded): 3,939 tests. Two run.unit tests expected the old `MOVENG_UNSUPPORTED` for DOMAIN_OF; I updated them (f05c6430), and run.unit is now 136 of 136.
- apps/api `code:type-check` (main and oracle configs): clean.
- New tests:
  - callback_run: an expression walk from a callback reads two calls.
  - rust_concurrency: an await on a walked record parks under that record's key, and binds once it has landed.
  - patterns: new pattern `rvalue:event`; `rvalue:lazy`, `lazy_park` and `function:domain_of` now end whole.

## patterns.json regeneration: a problem outside this slice

- `generate.ts` fails on base c6171c60, in the TypeScript checker.
  - The program: the `extract_proto_field` pattern.
  - The failure: `spelledFor` throws "Cannot read properties of undefined (reading 'filter')" in `mixedTupleMessage`.
  - The cause: since 09a5d7be, an extracted record's field named `__proto__` is held on a prototype-less object, but some lookup still reads `__proto__` off an ordinary object and gets `Object.prototype` as a type.
- How I regenerated anyway:
  - I reverted 09a5d7be's three lines locally, without committing, for the one regeneration run.
  - Only patterns.json changed, and only in the expected cases.
- Someone needs to fix this before the next regeneration. It is checker work (close-strings or the controller), not mine.

## Shared files touched

- crates/movement-engine/src/{awaits.rs, reading.rs, run.rs (the bare-read hook only), eval.rs (the field-function branch), collection.rs}
- crates/movement-engine/tests/oracle/{patterns_table.ts, patterns.json}
- apps/api/src/services/movement_engine/__test__/{reachability_gaps.ts, callback_run, rust_concurrency (+ snapshot), run.unit}
- CHANGELOG: `### close-forms`
