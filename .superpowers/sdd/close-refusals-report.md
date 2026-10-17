# close-refusals report (2026-10-17)

Branch `close-refusals`, base c6171c60. The wasm is rebuilt in the worktree but not committed.

## What is done

From version 5, both checkers refuse these at save. Each message names the spelling that runs. Versions 1–4 are unchanged.

| Form | Code | What to write instead |
|---|---|---|
| A linked write or match whose target walks more than one edge | MOV_WRITE_MULTI_HOP | walk to the parent in a block, then write off its alias |
| A walk with no root, as a block head or in an expression | MOV_WALK_ROOTLESS | name the record the walk starts at |
| `unique by` on a write to a declared node | MOV_WRITE_SHAPE_UNIQUE | drop the clause, or build the record with `node { … }` |
| `KG_VALUE(…)` / `KG_EXISTS(…)` (from close-forms) | MOV_KG_QUERY_RETIRED | walk the graph |
| `await` on a name holding a list of records (from close-forms) | MOV_AWAIT_ON_LIST | await on one record |
| A record written as the value of a relationship field (from close-forms) | MOV_WRITE_LINK_FIELD | write off the record, or link them after. This was an info nudge, which still applies before version 5. |
| A walk off a json value (from close-walks) | MOV_JSON_HAS_NO_EDGES | read a key with a dot |

Other fixes:

- **`_resources` off an extraction call's result.** The checker accepts it, on nested records too.
  - The engine now gives each record a call finds the content that call read: a FILE resource per file, a TEXT resource per text.
  - The resources survive a pause. The park state's `nodePosition` gains an optional `resources` field, and the host's park walk turns the files in it back into files.
- **Bare built-in call.** In version 5, `Text.upper(x)` on a line by itself now parses (a parser fix). The checker then reports MOV_BUILTIN_UNUSED.

## Behaviour decisions, and why

- **Rootless EXISTS: reported, not refused, inside a hop's WHERE.** The language does give a rootless walk a record there: the record that hop lands on.
  - So `exists(-[…]->)` inside a hop's WHERE or ORDER BY stays allowed.
  - The engine already ran it over stored and extracted records. It now also runs it over a record the run built (it used to refuse that).
  - Anywhere else, a rootless walk is refused.
- **Rootless block heads: refused.** The TypeScript checker's comment says "relative to the enclosing position", but no engine ever ran one. A named root says the same thing explicitly.
- **Item 5 (a function taking a value, fired as the entry): I chose neither offered option.**
  - Refusing at save would refuse every helper function, since any function taking a value is a legal callee. The checker cannot know which function a host will name. A function that a listen names was already refused (MOV_LISTEN_PARAM_MISMATCH).
  - Making it run is impossible: the triggering event is not the value the function takes.
  - So the run still fails, but the message now says the function is a callee and no longer claims "the checker should have caught this".
- **Await on a list: refused only for a list.** The reachability gap for await (`await needs a w…`) also covers awaiting the event, or a record held in a value (`c = only(…)`). Those are engine ports, not refusals, so that gap line stays.
- **Extraction call resources get no `ids.mint`.** An id is not a field an author can read, and minting one would add a host request to every extraction call.
  - A call-form record's resources are also not attached to writes. Only the retired keyword did that.

## Tests

- **cargo** (movement-checker, movement-engine, movement-parser): 549 passed, 0 failed. Clippy is clean.
  - New: `crates/movement-checker/tests/v5_refusals.rs`, 9 tests.
- **movement-lang**: 5,241 tests, all green. The upgrade-corpus floor was lowered to the measured 84.0% (4,962 of 5,905): a few version 4 programs now meet the new refusals.
  - New: `checker/__test__/v5_refusals.unit.test.ts`, the TypeScript twin of the Rust tests, with the same programs and messages.
- **apps/api movement_engine set**: 3,960 of 3,962 pass. What still fails:
  - `patterns_inventory` (2 tests): `patterns.json` needs regenerating, see below.
  - `reachability`: green once the await gap line was restored and the gap the KG_VALUE refusal closed was removed.
  - Updated: calls, host_data_is_data, rust_run, rust_extract (one park snapshot, which now carries resources), extraction_call (new tests), files_by_envelope (a new test where a parked call's resources come back).
- **Parity**: 263 of 263 codes; 47,985 of 47,985 records exact; 0 extra in Rust.
  - `checks.json` was re-harvested by running each corpus by hand. The script aborts on the `patterns_inventory` failure.
- **Type-check**: clean for engine-contracts, movement-engine, apps/api and movement-lang.

## For the controller to reconcile at merge

- **`patterns.json` is not regenerated.** On this branch `generate.ts` crashes on `extract_proto_field`; close-strings fixed that in 43d38822. I updated `patterns_table.ts` for my patterns. Regenerate after merge, and `patterns_inventory` goes green.
- **json walk tests.** `host_data_is_data` and `rust_run` (the walk off `msg.meta`) now expect MOV_JSON_HAS_NO_EDGES at the check. close-walks expects a count of 0 there. Mine wins only if the refusal lands.
- **extract_proto_field.** I made no change there; I reverted my typing.ts edits.
- **reachability_gaps.ts.** Removed: multi-hop writes, rootless EXISTS, rootless heads, unique by on a shape write, the KG expression kind, the write handle handed to the host, and EXISTS over a mixed list (that one was only reached through KG_VALUE). Kept: the await gap.

## Shared files touched

- **Checkers:** check.ts, codes.rs, checker.rs, families/{calls,extraction,flow,walks}.rs, families/writes/mod.rs.
- **Engine:** bindings.rs, extract/call.rs, local.rs, park.rs, plugin.rs, resume.rs, run.rs, traverse.rs.
- **Parser:** stmt.rs.
- **Park contract and host walk:** engine-contracts/park_state.ts, rust_wire.ts.
- **Fixtures:** checks.json, checks.snapshots.json, PARITY.md (all regenerated).
- **Oracle and docs:** patterns_table.ts, CHANGELOG (`### close-refusals`).
