# close-walks report (2026-10-17)

Branch `close-walks`, base c6171c60. Two commits. movement.wasm gz 1,274,490 → 1,274,224 (rebuilt in the worktree, not committed).

## Items 1–3: a walk off a value (a8076284)
- Rule (version 5; the Rust engine runs only 5+): a walk off a name holding a value starts from the records the value holds.
  - One record is itself.
  - A list is each of its record members.
  - Anything else adds nothing to walk from: nothing, a map, a text, a list's other members.
  - So the walk reaches nothing: a count is 0, an EXISTS is false, a read is null.
- Item 3 decision: the preferred rule, applied to all three items alike. A lone value is treated as a one-member list, so a mixed list and a lone non-record follow one rule.
- What the 69 + 32 + 1 programs actually were: walks off a value holding nothing or an empty list (`rows = crm-[c:companies]->` that found nothing), and walks off a `json` field (`v = msg.meta`). A value holding a real record already walked before this change. The new test's first case guards that.
- One place where this behaves differently from before (please rule):
  - A walk off a `json` map now reaches nothing. Before, it failed the run.
  - host_data_is_data and rust_run each asserted the old refusal. Their security point still holds: one field read, no hop, nothing parsed. They now assert the count is 0.
  - Suggestion: the checker should refuse a hop off a `json` value at save (as MOV_HEAD_NOT_A_POSITION does for other non-record types). That is checker work, so I did not do it here.
- Block heads (`v-[x:e]-> { … }`) are unchanged: a non-record member still fails the run there.
- Code: `walk_starts` and `held_records` in the record module, used by the expression read, the meta walk, and EXISTS's cursor step. The dead refusals are removed.

## Item 4: a field the record lacks reads nothing (c5988d23)
- Cause: the eval wire turns `undefined` into null, so a missing field reached the engine as null, a value.
- Fix in the shim (rust_host.ts), not the engine: an `adapters.call` answer of nothing now crosses as `{}` (no `result`). The engine already reads that as nothing.
- Why not in the engine: once a value is on the wire, the engine cannot tell a missing field from one the record holds as null. I first tried treating every null field read as nothing. That changed `typed_event_run`'s empty hydrated field (it stopped writing `text: null`) and rust_traverse snapshots. The shim fix changes only the missing-field case, which matches 1–4.
- Doc: host-families.md says an answer of nothing is `{}`.
- node_synthesis's absent-entry IS case is back on version 5 (its version 4 stand-in is removed).
- rust_write snapshots re-recorded after reading the diffs:
  - the create's resolveEntity record no longer carries `body: null`;
  - the spread's `stage` provenance is now empty.
  - The spread still writes `stage: null`. Reason: reading a node field that is not there reads null (`?? null`, as the TypeScript does). Not changed.

## Verified
- cargo test movement-engine: green (new unit test `a_walk_off_a_value_starts_from_the_records_it_holds`). Clippy: clean.
- The apps/api movement_engine unit set, reachability included: 127 suites, 3,941 tests, 294 snapshots, all green.
- New rust_traverse tests (3), each checked against expected values:
  - a picked record and a kept walk;
  - a kept walk that found nothing;
  - a mixed list.
  - The last two fail on the old engine with the gap refusals.
- Type-check: packages/movement-engine and apps/api clean.
- Checker parity: no checker change, so not re-run.
- Flake seen once: rust_traverse failed at module load with "no filter parsed out of …". It passed on rerun.

## Shared files touched
- crates/movement-engine/src/{eval.rs, reading.rs, record.rs}
- packages/movement-engine/services/movement_engine/rust_host.ts (adapters.call answer)
- docs/contracts/host-families.md
- apps/api tests: reachability_gaps.ts (three entries removed), rust_traverse (+ snapshot), rust_write snapshot, node_synthesis, host_data_is_data, rust_run
- CHANGELOG: `### close-walks`
