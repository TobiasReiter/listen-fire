# v5 surface — final integration report (PARTIAL: stopped at the context budget)

Head when stopped: 221a30c0 on `v5-surface`. Steps 1 and 2 are done. Step 3 is half done. Steps 4 to 6 are not started.

## Read

- All five slice branches and `cloud-native` are merged. Rust tests pass for the parser, checker and engine crates.
- Parity was complete after the five slice merges: 254 of 254 codes, 0 extra in Rust, 46,749 of 46,749 records exact. It was not rerun after the cloud-native merge.
- The Rust-only deprecated-pin test now passes on Rust under v2, v3 and v4 (8, 9 and 9 tests).
- Item a is not a checker bug. The checks corpus's snapshots are stale, and the planned re-harvest fixes them (evidence below). No checker code was changed for it.
- Items b, c and f are done, each with tests in both checkers. Items d, e and g are not started.
- The committed wasm (in merge 0def869d) predates commits 22c3e889 and 221a30c0, so it is stale. Step 6 must rebuild it.

## Step 1: slice merges
- engine and plugins merged cleanly.
- checker: one conflict in run.ts. Kept both sides: the plugins slice's view of the spec under the run's version, bound with the checker slice's version option.
- parity and floors merged cleanly.
- After the merges, a fix-up commit (a1613ef4). The checker slice expected `out = linkedin_enrichment(…)` in the v5 `#transform` message. With the plugins slice's `record` parameter, the message now says `out = linkedin_enrichment(record)`. Versions 3 and 4 keep `(…)`.
- Checks run: Rust tests for the three crates, parity (after the engine and plugins merges, then again after all five), and the slices' TS checker suites (53 of 53 pass).

## Step 2: cloud-native merge (0def869d)
- The check runs once under the pin. When the union rule was withheld, it runs again joining records (cloud-native's design). Both runs sit inside the pinned version's parse scope, and the v5 spelling diagnostics and message respelling apply to both (v5-surface's design). Files: lib.rs and check.ts.
- calls.rs: an unknown package member is reported first (v5). Then comes cloud-native's built-in exemption, which applies from version 3.
- walks.rs, scope_env.rs, identity.rs: both sides had fixed the same two divergences. I kept cloud-native's form.
- The IF's ELSE arm narrowing: kept cloud-native's version, which applies on every version (its corpus re-pin covers versions 3 and 4). v5-surface had it under 5 only.
- coalesce, in both checkers: an argument that never arrives cuts the search (v5), inside the union rule's join (cloud-native). The Rust version is split into two functions, because the generic join recursed during compilation.
- The new upgrade warning for ORDER BY or LIMIT on a hop over records the run holds now covers a value that may be one of several records: it fires if any of them is held. Both checkers.
- A call to the declared-parameter fit check on one of several records now passes the language version. Both checkers.
- record_unions.fixtures.json: the 44 version 5 cases are respelled through `spelledFor` and re-answered by the TS checker. Four answers changed, all because of spelling (`COALESCE` became `coalesce`, and the MULTI span moved).
- write_target.rs stays deleted, because cloud-native replaced it with those fixtures.
- checks.json and PARITY.md: kept ours. Step 4 and 6 regenerate them.
- Docs: kept both sides' CHANGELOG entries. In the migration guide, the union-rule section is now §17 and the code index §18. The `MOV_UNKNOWN_PROPERTY` row links to §17.

## Step 3: leftovers
- **a. The `&&` narrowing. Cause found; no code change.**
  - The corpus snapshots were harvested when refinement keys still carried `fieldOnly: true`.
  - Today's key drops that mark (`fieldReadsUnmarked`). So a v5 record, whose field reads carry the mark, no longer finds its refinement in the old snapshot.
  - Versions 1 to 4 parse without the mark, so their records still match. That is why only v5 records showed it, and `&&` was incidental.
  - The live checker narrows `&&` heads under 5: discriminated_read passes 27 of 27.
  - Proof: corpus record at line 33094 of checks.json replays wrong today. Its snapshot keys contain `fieldOnly`, and the checker's freshly computed key does not.
  - After the re-harvest, check that this record narrows again.
- **b and f. Done (22c3e889), both checkers.**
  - From version 5 there is no stage to send a plugin to.
  - A plugin that has not declared its effects or its output is an ordinary call there: its effects are partial and its value is unknown.
  - The "missing input" message under 5 says to pass the input by position. It no longer says an extraction supplies it.
  - Versions 1 to 4 are unchanged.
  - Tests: v5_fed_by_extraction in TS and Rust. A v5 call to either kind of undeclared plugin checks clean. Under 4 both are still refused, with the `through` advice.
  - Not checked: whether the Rust engine admits a plugin call with no declared output. Its admission works from the declared output, so such a run may be refused at admission. No bundled plugin is undeclared.
- **c. Done (221a30c0).**
  - describe's `narrow.where` is parsed under a version: the program's pin when one is given, otherwise the current version.
  - Before, an `&&` narrowing was refused as unparseable.
  - Test: catalog_streaming (31 of 31 pass), on both the current version and a pin to 4.
- **d. Not started. The 27 Rust-engine failures, measured on the current head:**
  - Almost all are in rust_extract, and that suite is pinned to version 4 (`LANGUAGE_VERSION = 4`). So these are not only v5 spelling failures:
  - 11 expect a refusal reason other than `legacy_extraction`. The Rust engine now refuses the extraction keyword on every version, so these tests need their expected stats updated.
  - About 9 run v5-spelled programs under 4 (for example `fetchUrl`, `fail`, `File`, `Json` reported unknown), or v4-spelled programs under 5 (`Unexpected 'email'`).
  - The rest: one `MOVENG_PARSE` on `echo(… {`, and one `MOV_INTERNAL_UNTYPED_BINDING` in a library.
  - The proof "on the base, only spelling" is not done.
- **e. Not started.** The four `v5_plugin_call` tests still use the extraction keyword under 5.
- **g. Not started.** The new diagnostic for reading off an event the catalog does not describe (MOV_EVENT_UNDESCRIBED). An example is body_closure_scope, where `manual` is missing from the catalog's instanceSchemas: the checker cannot type the event and says nothing.

## Also seen
- In discriminated_read.unit.test.ts (line 149), an earlier respell left `WHERE org.org.org.org.org.\`Name\``.
  - Writing it as `org.\`Name\`` makes "a MISSPELLED binding…" report an extra `MOV_V5_SPELLING` on `cutof`. The odd prefix is hiding that.
  - I reverted my change, because it is out of scope. It needs an owner.

## Left (in order)
1. Items d, e and g.
2. Step 4: re-harvest the checks corpus once, regenerate the engine oracle once (the patterns oracle included), and set the upgrade-corpus floor to the measured rate.
3. Step 5: full verification. Nothing beyond the scoped runs above has been run on this tree.
4. Step 6: rebuild and commit both wasm files, regenerate PARITY.md, and update the CHANGELOG size line.
