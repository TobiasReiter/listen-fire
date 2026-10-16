# v5 integration, round 2 — report (branch `v5-surface`, from 7a36f66e)

## Read

- **All four branches merged:** fieldref, never-sort, plugins, fixups. Both WASM files are rebuilt and committed (d1367b11).
- **Overlaps, each now one copy:**
  - The sort reading: never-sort's version. Every function key goes to the function form, so fieldref's field-marked SORT key path went with it.
  - Reading a text under the program's version: fieldref and fixups both added the version argument to the TypeScript expression reader. Same code; the comments are merged into one.
  - Narrowing (never-sort's else arm, fixups' type address read under the program's version) and the plugin docs (plugins' positional calls, fixups' exact case) merged without conflict.
- **The six leftovers, one commit each, both checkers at parity:**
  - a. `callback(() => f(x))` that leaves `f` a parameter open is `MOV_CALL_ARITY` under 5. `callback(f)`, a function named bare, still leaves every parameter to the platform. (c51997ad)
  - b. Advice text under 5 writes an event address through the hop's alias: `<crm-[e:`Webhook Event` WHERE e.action == "…"]->>`. One writer per checker takes the program's version; the listen mismatch, its traversal example and the narrowing example use it. (bc9db9ff)
  - c. A package imported without `as` is refused by the parser, read by both checkers: new code `MOV_V5_IMPORT_NEEDS_ALIAS`. The fix adds ` as web` (the tag's last word). It is not marked safe, because the name may be taken. (e60984db)
  - d. A bare `web.f(u)` statement in a closure of a nested call now parses. A nested call read on its own reads any dotted head that no standard namespace owns as a package member. (9a41fb7b)
  - e. A record value (`{ … }`) that is, or may be, passed to a plugin's text input is `MOV_CALL_ARG_MAYBE_RECORD` from 5. Under 3 and 4 it is an upgrade warning that blocks the move up. (92a16ebf)
  - f. Plugin examples in the handbook, the plugin handbook sections and the migration guide are positional calls. CHANGELOG and the migration guide name the three new breaks (a, c, e). (2668645d)
- **A bug found and fixed while doing d:** the TypeScript plugin binding re-read a settings record as versions 1–4 read it. Under 5, `research(n, { context: Text.join(…) })` therefore failed in TypeScript only. It now reads the program's own tree, as Rust does (9a41fb7b).
- **Decision for Henry:** an upgrade from 4 rewrites `callback(f(x))` to `callback(() => f(x))`. When `f` has a parameter left open, the result is now refused (leftover a). The fix would need `f`'s signature to write `(d: <date>) => f(x, d)`. So these programs now need a person to upgrade them.

## Checks

- Parity: 244/244 codes, 0 extra in Rust, 28,328/28,328 records exact (139,826 diagnostics). answers.sh: equal (11,155 would run, 17,173 blocked, 0 skipped).
- Type-check clean: movement-lang, shared, apps/api, apps/cli, movement-engine, apps/web.
- cargo test (parser, checker, engine): the parser and engine pass. The checker has the same 22 old-spelling failures as at the base: calls 2, extraction 1, hang 7, nodes 1, rules 6, write_target 5.
- clippy: no new warnings.
- Handbook suites: 536/536 (handbook, engine claims, plugin sections, adapter sections, front page, language search, adapter handbook).
- Every v5 suite passes: movement-lang `v5_*` (11 files) and apps/api `v5_*_run` / `v5_plugin_call`.
- **Expected failures from the old spelling, by suite.** Each was checked: the program is written in the v1–4 spelling but checked under 5, or the test expects v4 wording.
  - movement-lang:
    - typed_listen_events 6
    - event_address 19
    - shadowing 1
    - collection_member_fit 18
    - value_collections 35
    - event_record_edge 6
  - apps/api:
    - rust_traverse 40 (its second run is under 5 and is refused, so nothing is routed to Rust)
    - rust_dancing_wren 2
    - plugin_call 13
  - Rust checker: 22 (above).
- One test was touched for leftover b: event_record_edge's record-signature tests run under 5, so they now expect the alias form.
