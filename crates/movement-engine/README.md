# movement-engine

The movement engine in Rust. A segment of a run executes inside one WASM
instance and asks for everything outside the program in the host contract's
own shapes (docs/engine-host.md); `apps/api/src/services/movement_engine/
rust_engine.ts` drives it, and `rust_host.ts` forwards each request to the
run's `EngineHost`.

Under `MOVEMENT_ENGINE=rust` the engine runs two things:

- **an expression** over value bindings, which the TypeScript evaluator hands
  to `eval_expression` (slice 1, "The evaluator" below);
- **a whole run** of a program it admits on its own parse ("Admission"
  below): bindings, `if`
  and `return` over reads of the event and of values (slice 2a), writes with
  identity (`unique by`) and the nodes a run builds (slice 2b), `sleep`,
  parked and resumed in the TypeScript engine's own state (slice 2b), and
  traversal blocks over adapter edges (chunk 5B) — "The run" below. apps/api's `rust_run.unit.test.ts` and `rust_write.unit.test.ts`
  hold these runs to the TypeScript engine; the conformance corpora route
  their admitted cases whole.

## Modules

| module | what |
|---|---|
| `executor` | a single-threaded async runtime: the segment is one future; a `HostCall` future registers its request and yields; `join_all` keeps several in flight |
| `host` | one request builder per host call, each family spelled as host.ts's `HOST_FAMILIES` spells it (`adapters`, `llm`, `park.sink`, `control.cancel`, `locks`, `trace`), plus the engine's own (`check`, `builtins`); every host request names the segment |
| `ledger` | the run's spend account for one segment: the budget a priced call is sent, the cost each answers charged, the cap met (`exceeded`) once a budget refusal is charged, the charges handed back with `done` |
| `admit` | admission: the allow-list walk over this engine's own parse, before the check; a refusal's stable reason (below) |
| `abi` | the C ABI: `engine_start`, `engine_answer`, `engine_finish`, `eval_expression` |
| `eval` | `evalMovementExpr` over the host-free kinds, with its provenance rules and errors |
| `stdlib` | the 17 flat built-ins and all 15 namespaced members |
| `run` | the `segment` entry: `runMovement` / `resumeMovement` for the programs the shim admits (below) |
| `write` | the `write` statement: targets (a WHERE on one included), fields, identity, update or create, the firing record |
| `verbs` | `match`, `link`, `unlink`, `delete`: the identity half of a write on its own, edges between two handles, a record removed |
| `traverse` | traversal blocks over adapter edges: the head's graph, the hop's fetch, the member gate, the WHERE per landed record, ORDER BY / LIMIT, the body per landing |
| `order_limit` | packages/shared/expression/order_limit.ts: a hop's pushdown (closed over its scope) and its ORDER BY / LIMIT over what came back, sorted as V8 sorts |
| `address` | address.ts's lexical addresses: `s`, `b` and fan-out `i` steps |
| `unique` | `unique by`: the clauses split into keys and narrowings, the search record, the rules that decide without a judge, the identity lock |
| `node` | node and graph literals: value entries, nested nodes, reference entries and record copies (the checker's stamps) |
| `park` | `ParkedScopeState` v1 written and read as serialize.ts writes and reads it |
| `bindings` | what a name in a run is bound to, the lexical scopes (in declaration order), the source `Position` |
| `trace` | the `MovementTraceEntry` kinds a run appends (`warning`, `gate`, `field_miss`, `block`), and the per-flow buffer they wait in until their statement ends |
| `program` | the pinned source parsed, joined with the `check.program` host call's answer: diagnostics, the import link, the checker's stamps by AST path |
| `env_services` | `EnvServices`: zones, WHATWG URLs, locale numbers, Unicode normalisation and the wall clock, from the JavaScript runtime (WASM) or natively (below) |
| `filter` | packages/shared/expression/filter.ts: `compareValues`, `compareToNull`, `evaluatePredicate` |
| `env` | value bindings in scopes with a parent chain; the wire values and trails cross on |
| `js`, `js_date`, `js_regex` | the JavaScript semantics the TypeScript leans on, written out (below) |

## Two artifacts

This crate's `.wasm` (`packages/movement-lang/wasm/movement.wasm`) is the
API's artifact: it links in crates/movement-parser, whose `#[no_mangle]`
exports (the parses, the lowering, the catalog query, `alloc`, `dealloc`,
`last_panic`) come through unchanged. The browser never runs a movement, so it
loads crates/movement-parser's own artifact (`movement_parser.wasm`) and never
downloads the engine. Both are built by `scripts/build-movement-wasm.sh`,
compared byte for byte in CI, and budgeted separately (crates/movement-parser's
README has the budgets). One loader (`packages/movement-lang/wasm/loader.ts`)
serves both: it compiles an artifact once, the parser keeps one long-lived
instance of it, and each engine segment gets a fresh one; on the parser's
artifact `eval_expression` and the engine segments are absent, and refused by
name.

Measured 2026-10-07 (gzip -9):

| artifact | raw | gzipped |
|---|---|---|
| the parser crate alone | 1,182,582 | 321,745 |
| this crate (the parser included), the protocol only | 1,222,941 | 336,866 |
| this crate with the evaluator (slice 1) | 1,581,987 | 426,071 |
| slice 1, fix round 1 (`ryu-js`, bounded regex parsing) | 1,593,666 | 438,383 |
| slice 2a (environment services, the check, the run) | 1,751,210 | 488,922 |
| slice 2a, fix round 1 | 1,751,076 | 488,997 |
| slice 2b, the writes (writes, nodes) | 1,945,584 | 542,520 |
| slice 2b, the parks | 1,991,568 | 557,094 |
| slice 2b, fix round 1 | 1,978,540 | 555,330 |
| the chunk 4A host contract (segments, the ledger, the clock) | 1,994,270 | 559,928 |
| the probe entries test-only, the dead value model removed | 1,987,389 | 557,438 |
| admission on the engine's own parse (chunk 5B) | 2,018,914 | 565,647 |
| chunk 5B task 1, fix round 1 (the cap rule in admission) | 2,018,987 | 565,747 |
| the trace batched per statement | 2,018,749 | 565,685 |
| the evaluator awaits host reads in place | 2,029,485 | 569,630 |
| the closing trace hand-over marked | 2,029,738 | 569,885 |
| limit pause (the cap, suspensions, `limitPaused`, `suspendAt`) | 2,038,536 | 573,184 |
| a half-answering sink fails on its cap | 2,038,402 | 573,114 |
| traversal blocks over adapter edges (heads, hops, filters, order and limit; positions by handle) | 2,096,297 | 593,352 |
| **`movement_parser.wasm`**, the browser's, split out | 1,182,906 | 321,899 |

The evaluator added about 89 KB gzipped (reading the lowered `Expression`
back, the standard library, the regex matcher, Unicode case tables); slice
2b about 68 KB more (the writes 54 KB, the parks 15 KB). With the split the
browser downloads 322 KB instead of 557 KB, and the engine's growth no longer
reaches it.

## The protocol

```
engine_start(input)    → Step
engine_answer(id, ans) → Step
engine_finish()
Step = {"pending": [{id, family, method, args}]} | {"done": result}
```

- `pending` lists the requests issued since the previous step. Earlier ones are
  still awaited, so `{"pending": []}` means "waiting on requests in flight".
- Requests may be answered in any order. An answer is `{"value": …}`, `{}` for
  `undefined`, or `{"error": {message, …}}`; an error resolves that request's
  future with an `Err` the segment may handle.
- A dropped request (a race's loser) still accepts its answer, and discards it.
- Status 1 is a protocol misuse, `{"error": {message}}`: input that is not
  JSON, an unknown entry, an id never issued or answered twice, an answer
  after `done`, a second `start` in one instance, or a segment waiting on
  nothing (it could never finish).
- One instance runs one segment. `engine_finish` drops it and every future it
  held; the loader then discards the instance.

Entries (`input.entry`):

| entry | what |
|---|---|
| `segment` | a run, executed whole (`run`) |

Two probe entries exist in test builds only (`cfg(test)`), so the shipped
artifact has neither: `echo` issues each of `requests` (`{family, method,
args}`) at once and finishes with `{answers}` in the answer envelope (the
executor's and abi.rs's tests of several requests in flight, answered out of
order), and `panic` panics with `message`.

A panic aborts and traps the instance. The parser's panic hook records the
message first; the loader reads it through `last_panic` and throws it, and the
segment is over.

## The evaluator

```
eval_expression(expr, bindings) → {value, provenance} | {error: {class, code?, message}} | {fallback: reason}
```

- `expr` is the lowered `Expression` JSON, read back into the parser's own
  types (crates/movement-parser/src/lowering/expression.rs).
- `bindings` is `{bindings: {name: {value, provenance?, many?}}, origins,
  languageVersion?, now?}`.
- Synchronous, on the parser's long-lived instance: no segment.
- The switch is one guarded line in `evalMovementExpr`
  (apps/api/src/services/movement_engine/expression.ts). The shim
  (`evalInRust` in rust_engine.ts) sends an expression when `rustCanEval`
  admits it (kinds and function names, the allow-list) and every name it
  reads is a value binding whose value crosses as itself.
- `fallback` means "TypeScript, answer this": the expression is pure, so
  evaluating it again there is safe. It is how a reading this engine does
  not reproduce stays exact (see the list below).
- Errors carry the class the TypeScript throws (`MovementEngineError` with
  its code, `Error`, `RangeError`); the shim rebuilds them.
- `now` is the run's pinned instant (a `toISOString` text): `DATE.TODAY(zone)`
  reads it in the zone through the environment services.

The wire (env.rs has the details) carries what JSON cannot: `undefined`,
`NaN`, `±Infinity`, `-0`, key order, and identity. Identity matters because
`===` compares objects by it: the caller's own objects come back as
themselves (`["i", id]`). Provenance crosses as origin ids: the caller numbers
its origins, the engine mints one id per literal it evaluates, and a name, a
branch or a `COALESCE` passes its binding's trail through as `{binding}`.

### JavaScript semantics, written out

Each row names the test that pins it (`js::tests::…` and so on are in the
module; `oracle::…` is tests/stdlib_oracle.rs).

| what | how it is handled | test |
|---|---|---|
| `Number(text)` | StringToNumber by hand: JS whitespace trimmed, `""` → 0, `"  12 "` → 12, `"1e3"`, `".5"`, `"5."`, `0x`/`0o`/`0b` (unsigned only, rounded once), `Infinity` (case-sensitive), else NaN; Rust's `parse` sees only validated decimal digits | `js::tests::string_to_number_matches_javascript`, `oracle::the_standard_library_answers_as_typescript_does` (`coerce.number`, `flat.tonumber`) |
| `String(number)` | ECMAScript Number::toString from the `ryu-js` crate. Rust's own shortest form breaks 17-digit ties differently (`16086.196899414062`), so it is not used for text | `js::tests::number_to_string_matches_javascript`, `oracle::numbers_print_as_javascript_prints_them` (30,000 seeded doubles) |
| `String(value)` | arrays join with `,` (null and undefined members empty), objects `[object Object]` | `js::tests::string_and_number_coercions_of_composites` |
| `===`, `includes`, `Set` | strict equality (NaN not itself, `-0 === 0`), SameValueZero for membership, objects by identity (`Rc`) | `js::tests::identity_not_shape_decides_equality`, `filter::tests::membership_uses_same_value_zero`, `tests::identity_crosses_the_boundary` |
| truthiness | `0`, `-0`, `NaN`, `""`, null, undefined are false | `tests::absence_reads_as_typescript_reads_it` |
| `Math.round` | half toward +∞ (`-2.5` → `-2`), `-0` for a negative that rounds to zero; not Rust's `round` | `js::tests::math_round_is_half_toward_positive_infinity` |
| `toFixed` (NUMBER.FORMAT, CURRENCY) | the double's exact decimal expansion rounded half up (`0.25` → `0.3`); not Rust's `{:.1}`, which rounds half to even | `js::tests::to_fixed_rounds_the_exact_value_half_up`, `stdlib::tests::number_format_and_currency` |
| `%` | Rust's `%` is fmod, the dividend's sign, as JavaScript's | `filter::tests::remainder_and_division_by_zero`, `tests::arithmetic_keeps_javascript_semantics` |
| object key order | array-index keys ascending first, then insertion order; a repeated key keeps its place | `js::tests::objects_keep_javascript_key_order`, `tests::maps_keep_javascript_key_order` |
| `trim`, `\s` | JavaScript's WhiteSpace + LineTerminator set (with U+FEFF, without U+0085); not `char::is_whitespace` | `js::tests::strings_are_utf16_where_javascript_says_so` |
| `.length`, `<` on text | UTF-16 code units; comparison in code-unit order | `js::tests::strings_are_utf16_where_javascript_says_so`, `stdlib::tests::flat_builtins` |
| `split("")` | per UTF-16 unit: BMP text splits per character, astral text goes back to TypeScript | `stdlib::tests::flat_builtins`, `oracle::…` (`flat.split`) |
| `toLowerCase`/`toUpperCase` | Rust's case mapping, which follows Unicode 17; Node 22's ICU follows Unicode 16. **An accepted divergence**: a character whose properties changed between the two can map differently. Known case: U+0295 (ʕ) counts as cased for the final-sigma rule in Rust and not in Node, so `"ΑΣʕ"` lowers to `αςʕ` here and `ασʕ` in TypeScript | `stdlib::tests::case_mapping_follows_rusts_unicode_tables` |
| `new Date(text)` | the ISO forms V8's spec parser reads (`YYYY-MM-DD`, `…THH:mm[:ss[.f…]]` with `Z`/`±HH:mm`; day 31 rolls over, `24:00`, three fraction digits kept); a text with no digit is Invalid; anything else (V8's legacy parser, a date-time without offset = local time) goes back to TypeScript | `js_date::tests::reads_the_iso_forms_as_v8_does`, `js_date::tests::leaves_what_only_v8_can_read_unknown` |
| `Date.UTC` round trip | `validParts` refuses years 0–99 (Date.UTC reads them as 19xx), months outside 1–12, days past the month | `stdlib::tests::dates_parse_add_and_format` |
| `toISOString` | six-digit signed years outside 0000–9999; an instant past ±8.64e15 ms throws `RangeError: Invalid time value` (DATE.ADD_DAYS) | `js_date::tests::iso_strings_outside_four_digit_years`, `js_date::tests::time_clip_bounds_and_truncates`, `tests::coalesce_short_circuits_from_version_three` |
| regexes (TEXT.REGEX_EXTRACT) | a backtracking matcher over UTF-16 units with Annex B syntax: each iteration of a group clears its captures, an empty iteration ends a loop, `.` stops at line terminators. Invalid patterns are null, as `new RegExp` throws; lookbehind, named groups, octal and `\c` escapes, an escape class at a range end, groups nested past 100, and a match past its step/depth budget go back to TypeScript | `js_regex::tests::*`, `oracle::regexes_match_as_node_matches_them` (3,200 seeded cases) |
| `URL` (URL.HOST) | `new URL` itself, asked of the environment (`url_parse`); only the TypeScript's own pre-reading (trim, the assumed `http://`, opaque uris) is written here | `stdlib::tests::url_host_as_whatwg_reads_it`, `oracle::…` (`url.host`) |
| `normalize("NFKD")` (TEXT.SLUG) | asked of the environment (`normalize`) | `stdlib::tests::text_members`, `oracle::…` (`text.slug`) |
| `Intl.DateTimeFormat` (DATE.TODAY, DATETIME.AT) | the zone's wall reading asked of the environment (`tz_convert`); `instantAtZonedWallTime`'s search over those readings written out, `Date.UTC`'s 19xx years included | `stdlib::tests::datetime_at_names_the_instant_on_the_zones_wall_clock`, `oracle::…` (`date.today`, `datetime.at`) |
| `JSON.stringify` (TEXT.SERIALISE) | its quoting and two-space layout; keys sorted by UTF-16 unit, then laid out in object order (index keys first) as `Object.fromEntries` does | `js::tests::json_stringify_indents_as_javascript_does`, `stdlib::tests::text_members` |
| object-literal prototypes | `MAGNITUDE_SUFFIXES["constructor"]` is `Object`, so `"5 constructor"` is NaN; `MONTH_NAMES["constructor"]` fails `validParts` like no month | `stdlib::tests::figures_read_as_the_regex_reads_them` |
| a dict whose `kind` names a binding kind | the TypeScript reads it as a record (`bindingOf`, whose `kind in describeBinding` walks the prototype chain, so `"toString"` and `"constructor"` count): its `==`, spreads and record arguments go back to TypeScript, and the shim sends no such value | `stdlib::tests::record_detection_walks_the_prototype_chain_as_in_does`, `tests::maps_keep_javascript_key_order` |

`tests/stdlib_oracle.rs` holds every built-in and the comparator to the
TypeScript's own answers (tests/oracle/stdlib.json, 10,455 cases), number
printing to 30,000 seeded doubles (numbers.json) and the regex matcher to
Node over 3,200 seeded pattern/text pairs (regex.json). Each function may
hand back to TypeScript no more than its recorded share. All three files are
written by tests/oracle/generate.ts, deterministically; CI regenerates and
diffs them.

The evaluator switch counts what it did (`rustEvalStats` in rust_engine.ts:
not admitted, admitted, answered, fallback by reason). Under
`MOVEMENT_ENGINE=rust` the conformance runs print the totals and fail when Rust
answered nothing.

## Admission

Whether this engine runs a program whole is decided in three places, in
this order, and the program is parsed once, here:

1. **The shim's input checks** (rust_engine.ts: an event that cannot cross
   the eval wire; `rustResumeRefusal` for a resume), on what the run is
   handed, before a segment opens.
2. **This engine's admission** (`admit.rs`, and `park::resume_refusal` for a
   resume), on its own parse, before the catalog loads, before
   `check.program`, before any request: a refused run costs one parse and
   one walk, and no host call (`rustRunStats.hostCalls` stays `{}`).
3. **The stamp declines** (`Run::stamp_decline`), after the check and
   before anything the host can see (the version warning's trace entry
   included): what only the checker's stamps say.

Either way the shim runs the program on the TypeScript engine.

### The reasons

Each is a stable snake_case string: the one log line per run names it, and
`rustRunStats` counts it (`notAdmitted` for the first two places,
`declined` for the third).

**The shim's input checks** (`notAdmitted`):

| reason | the input |
|---|---|
| `event_does_not_cross` | an event, source or parked state the eval wire cannot carry as itself (a `Date`, a class instance, a lone surrogate) |
| `resume_answer` | a resume that answers into its leaf (an ask) |
| `resume_defers_race_settlement` | a resume that defers a race's settlement |

**Admission: the file** (`notAdmitted`):

| reason | the construct |
|---|---|
| `source_does_not_parse` | the source does not parse here (the TypeScript engine throws the parse error) |
| `import_from_file`, `import_from_<namespace>` | an import from a library file, or from a namespace other than `adapters` and `credentials` (`import_from_plugins`) |
| `file_assignment` | a file-level binding that is not an instance construction |
| `file_call` | a file-level construction spelled with a movement's name (a call) |
| `file_statement:<kind>` | any other file-level statement, by the AST's `kind` (`shape` for `node <Name> { … }`, `type`, `write`, …) |
| `movement_value_param` | a movement taking a value (`n: <number[]>`) |

**Admission: a body** (`notAdmitted`; every movement in the file is walked):

| reason | the construct |
|---|---|
| `name_shadowed` | a body binds a name the movement's parameters or the file bind |
| `name_rebound` | a body binds one name as two kinds (a value and a handle, …), or twice where one binding can see the other (in one scope, or in a scope and one inside it); names are scoped lexically, so two blocks may reuse a hop alias, and two arms or two block bodies a name |
| `statement:<kind>` | a statement other than a binding, `write`, `match`, `link`, `unlink`, `delete`, `if`, a traversal block, `await sleep(…)` and `return` (`call`, `combinator`, `collection`, `error`, `refresh`) |
| `block_head_rootless`, `block_head_expression_root` | a block head with no root, or rooted at an expression (`AT(rows, 0)-[c:company]->`) |
| `block_head_value_root`, `block_head_node_root`, `block_head_root` | a head rooted at a value (a list of records), at a node or graph the run built (its own graph's plane), or at anything but an instance, a write's handle, the event or an enclosing block's hop alias |
| `block_multi_hop` | a head that walks more than one hop (`crm-[c:companies]->-[d:deals]->`) |
| `block_head_resources`, `block_head_step`, `block_head_does_not_lower` | a `_resources` head, a hop that is not an edge, a head the probe cannot read |
| `block_park` | an `await sleep(…)` in a block's body: an iteration that parks is joined by the fan-out's frame, which this engine does not keep |
| `rvalue:<kind>` | a right-hand side other than an expression, a built-in's call, a write, a match, a link, a node or graph literal, a construction and `await sleep(…)` (`extract`, `extractCall`, `callback`, `lazy`, `closure`, `collection`, `members`, `inlineBlock`, `combinator`); for `return`, also `node`, `write`, `match` and `link` |
| `await_not_sleep` | an `await` of anything but `sleep(…)` |
| `movement_call` | a construction in a body spelled with a movement's name |
| `function_call` | a call whose callee the program declares (a movement, any letter case from version 3), or any call before version 3 |
| `builtin_call_form` | a built-in's call with a named argument, an argument that is not a value (a closure, a write, a node), or no expression to read |
| `write_bind` | a write with `bind` |
| `write_tuple` | a tuple write |
| `write_position_not_record` | `write x { … }` where `x` is not a write's handle or a block's hop alias |
| `write_root_expression`, `match_root_expression` | a linked write or match rooted at an expression |
| `write_root_not_held`, `match_root_not_held` | a linked write or match rooted at a name that is not an instance, a handle, the event or a block's hop alias |
| `write_node_root`, `match_node_root` | a write or a match into an edge of a node this run built (the in-process stand-in adapter is the TypeScript engine's) |
| `write_multi_hop`, `match_multi_hop` | a linked write or match that walks more (or less) than one edge |
| `match_tuple`, `match_position` | a match over a tuple of paths, or of a bare alias |
| `link_node` | `link n -[:e]-> …` where `n` is a node this run built (an appended landing) |
| `link_endpoint_not_handle` | a `link` or `unlink` endpoint that is not a write's (or a match's) handle |
| `delete_not_record` | `delete x` where `x` is not a handle or a block's hop alias |
| `unique_by_without_key` | a `unique by` clause with no key (no bare field, parent or `field == value`) |
| `unique_by_reads_beyond_candidate` | a `unique by` conjunct that is not a pure predicate over the candidate |
| `write_spread_source` | a write spread of a name that is not a value, a handle, a node or the event |
| `graph_shape` | `graph<Shape> { … }` |
| `node_spread` | a spread in a `node { … }` literal |
| `node_spread_source` | a graph spread of a name that is not a value, a handle or a node |
| `node_event_entry` | a node entry holding the event itself |
| `node_declared_entry` | a declared edge entry (`kids: <T>`) |
| `node_traversal_entry` | a traversal entry |
| `is_test` | an `IS` condition |
| `condition_does_not_lower`, `expression_does_not_lower` | a slot that does not lower (the checker's miss) |
| `name_not_value` | a name read that is not a value the body binds (the event, a handle, an instance) |
| `traversal_root` | a field read rooted at a name that is not the event, a value, a handle, a node or a block's hop alias |
| `traversal_steps` | a field read that walks an edge (`msg-[:replies]->.x`), in a body, a hop's WHERE or its ORDER BY key: traversal inside an expression |
| `traversal_terminal` | a walk ending in anything but a field |
| `static_number` | a numeric literal JSON cannot carry (`Infinity`, `-0`) |
| `proto_key` | a `__proto__` key written in an object literal |
| `within_compare` | `WITHIN` |
| `function:<id>` | a function the evaluator does not run, by its lowered id (`chunks`, `domain_of`, …) |
| `expression:<type>` | an expression kind that needs the host, by its lowered `type` (`llm`, `aggregate`, `meta`, `exists`, `resource_traverse`, `kg_value`, `edge_property` outside a hop's WHERE, …); `EXISTS(…)` anywhere, a hop's WHERE included, is `expression:exists` |

A hop's WHERE and ORDER BY key, and a write's or a match's target WHERE, are
walked as expressions scoped at the landed record (the candidate, for a
target): a bare name (`property`, `edge_property`) is the record's
field (or a value the body binds of that name), and the rest is the
expression walk above.

**Admission: the input** (`notAdmitted`; `admit::input_refusal`, on the
parse, before anything is asked):

| reason | what the input would make the run do |
|---|---|
| `cost_cap_inside_block` | a capped run with a write, a match or a link that matches in a block's body: the cap can be met at any judged write or match, and a flow suspended in an iteration is joined by the fan-out's frame, which this engine does not keep |
| `suspend_at_inside_block` | a `suspendAt` address with an `i` step: likewise |

**Admission: a parked state** (`notAdmitted`; `park::resume_refusal`):

| reason | the state |
|---|---|
| `resume_state_does_not_read` | it does not read off the wire |
| `resume_state_version` | a version other than 1 |
| `resume_state_frames`, `resume_state_until` | frames, an `until` |
| `resume_state_journal` | a journal with a call in it (a suspension's journal is empty when this engine wrote it) |
| `resume_state_suspended` | a `suspended` other than `true` |
| `resume_state_address` | an address stepping into anything but `if` arms (`^s\d+(\.b\d+\.s\d+)*$`) |
| `resume_state_kind:<kind>` | a binding of a kind this engine does not bind (`extraction`, `shape`, …) |
| `resume_state_returned_records` | a bound block's returned records (this engine binds none but the empty set) |
| `resume_state_extraction_origin` | an extraction among a binding's origins |
| `resume_state_value_holds_record` | a value binding holding a record (a binding-shaped dict) |
| `resume_state_deferred_edge` | a node's edge that is not landed, or names a landing |

**After the check** (`declined`):

| reason | what the stamps say |
|---|---|
| `event_field_dated` | the program reads an event field (by name, or as a `...msg` spread's stamp names it) that the source's schema types as a date: an adapter may answer it as a `Date` |
| `graph_copy_walks_edges` | a graph's record spread whose copy plan walks the record's edges (the checker stamps one only on a shaped graph, which admission refuses: a guard) |
| `catalog_does_not_load`, `event_does_not_read`, `instant_does_not_read`, `check_answer_malformed` | the run's input or the check's answer does not read (a shim fault in all but name) |

### What admission cannot decide

These depend on what a value holds, not on what the program says, and stay
mid-run failures ("Errors a run can meet mid-run" below): a `__proto__` key
spread in from a value, a record compared by identity, a binding-shaped
dict read or spread, a field that is `Object.prototype`'s. Two mid-run
MOVENG_UNSUPPORTED errors are the TypeScript engine's own, mirrored, and
are not refusals: a movement parameter typed against something that is not
an instance, and a trigger type other than webhook, poll, snapshot and
mutation — the TypeScript engine throws the same.

### The evidence

- **One log line per run**, at the decision point:
  `movement engine: engine=rust|ts run=<id> reason=<reason|admitted>`
  (`admitted` for a run this engine ran, to its end or its own failure;
  `shim_fault` for one the shim faulted; `movement_engine_ts` when
  `MOVEMENT_ENGINE` did not choose this engine). At info under
  `MOVEMENT_ENGINE=rust`; at debug under `ts`.
- **`rustRunStats`** (rust_stats.ts): `notAdmitted` and `declined` by reason;
  `routed`, the segments this engine started, its admission's refusals
  among them; `admitted`, those its admission let by (`routed` less the
  refusals); `ranWhole`; `shimFaults`; `hostCalls` by `family.method`.
- **`GET /api/v1/system/engine-stats`** (system scope, like `/tg-runs`):
  `{engine, uptimeSeconds, since, runs, evaluator}`, this process's counters
  since it started.

## The run

`run::segment` takes run.ts's steps in run.ts's order, and every step the
TypeScript takes through its host is a host request here:

| request | when | answered by the shim from |
|---|---|---|
| `check.program` | first, once admitted ("Admission" above) | program_check.ts (below) |
| `adapters.resolve` | the source instance (`prepareMovement`); each write's target, once per instance (`targetAdapterFor`) | `host.adapters.resolve`: the instance as data (its opaque id, its `adapterType`, the `methods` it implements); a rehearsed target is resolved `dryRun`, and the host captures its writes. The credential id is the run's input (`credentialIds`), by the import's credential name |
| `adapters.call` `listEntryPoints` | a discriminated event (`naturalRootTypeName`) | `host.adapters.call` |
| `trace.append` | after each statement that traced anything, at any depth, its entries in one request; once more as the segment ends, for what a park or a failure left (run.ts publishes the same way, `interpretBody`) | the segment's trace (the result's), handed on to `host.trace` |
| `control.cancel.cancelled` | before each statement | `host.control.cancel.cancelled` |
| `adapters.call` `getFieldValue` | each read of an event field or a landed record's, in evaluation order; the position by handle (below) | `host.adapters.call`, through the surface-read wrapper's restamp (done here) |
| `adapters.resolve` (`role: "source"`) | a block head rooted at an instance or a write's handle, once per instance (`instanceSourceRead`) | `host.adapters.resolve` |
| `adapters.call` `getRelated` / `iterateRelatedPage` | a block head's hop: `getRelated` through the read wrapper, or, for an instance whose `methods` list `iterateRelated`, `iterateRelatedPage` a page at a time | `host.adapters.call` |
| `adapters.call` `describe`, `resolveEntity`, `readRecord`, `createRecord`, `updateRecord` | a write, in run.ts's order (below); `readRecord` only when the instance's `methods` list it | `host.adapters.call` |
| `llm.arbitrateEntities` | a search the rules cannot decide | `host.llm.arbitrateEntities`, with the run's budget (`ledger`); its cost is charged |
| `locks.acquire`, `locks.release` | around an identity search and an update by id | `host.locks`: a token per acquire, released by token |
| `builtins.function`, `builtins.compare` | a built-in reading this engine hands back (V8's date parser, local time, a regex feature, `WITHIN`) | the TypeScript member itself |
| `park.sink.commitTimerPark` | a `sleep` in a run that is not a rehearsal | `host.park.sink`; `wakeAt` is this engine's wall clock plus the sleep |
| `park.sink.commitLimitPause` | the first time the run meets its cost cap (a budget refusal, charged, that the ledger says is the cap) | `host.park.sink.commitLimitPause`, skipped when the sink has none; `{noSink: true}` when the sink cannot suspend, and the run fails on its cap |
| `park.sink.commitSuspension` | the flow suspends: at the statement that met the cap, before each statement of a paused run (`limitPaused`), at a `suspendAt` address | `host.park.sink.commitSuspension`; `{noSink: true}` when the sink has none |
| `control.cancel.cancelledNow` | the last check (not after a park) | `host.control.cancel.cancelledNow` |

**A lost run lease** is the run host's (docs/engine-host.md "Failure"): the
cancel gate, or a park the lease fence refuses, throws `RunLeaseLost`; that
host error fails the run with the very object, and the run host's settle
recognises it. The engine never asks whether the lease is lost.

### Writes

`write.rs` is run.ts's `executeWrite`, for a collection of an instance
(`write crm-[:companies]->`), one edge off a handle, the event or a block's
hop alias (`write co-[:notes]->`, `write msg-[:replies]->`, `write c-[:notes]->`:
the traversed record parents the write when its position is stable and
typed, in the graph its read names), and a held handle or a traversed record
updated in place (`write co { … }`, `write c { … }`, through the record's
graph's target adapter under its position's type):

1. the target adapter resolved, once per instance identity;
2. `describe`, then each field line in the author's order — a spread is the
   lines the checker's `spreadFields` stamp names — each value coerced for its
   field's cardinality;
3. the discriminated handle type, `unique by` ∪ the descriptor's native
   constraints, the search record (blank keys null, parents folded in by edge
   name), and the identity lock (the record type's, when the write can search;
   the per-key locks gate concurrent flows of one run, which this engine's runs
   do not have);
4. `resolveEntity` — once with every key, or once per key when a clause has
   conjuncts that narrow (each narrowed by `evaluatePredicate` over the
   candidate, its record read when the search's snapshot lacks a field;
   `WITHIN` answered by the TypeScript comparator) — then the target's WHERE
   (`crm-[c:companies WHERE c.\`region\` == "EU"]->`,
   `narrowCandidatesByTargetWhere`: each candidate read whole, `readRecord`
   over its snapshot, as a stable position of the handle's type read through
   the target graph as a source, the alias naming it; the shortlist's order
   kept), then the rules (`arbitrateWithoutJudge`), then the judge;
5. an update of what was found (its record lock, `readRecord`, the `?:` / `+:`
   / `+?:` merges, no-op suppression, `noop` / `attach` / `update`, an
   unsupported association failing the write) or a create (the required-field
   gate first; a judge that was unavailable leaves the TypeScript's note);
6. the firing record: each written field's trail summarised, the binding's
   name, the write's origin interned, the handle bound.

The firing record is held as the JavaScript object the TypeScript builds,
keys in its order, so the result, a handle read (`co.externalId`, a field of
what was written, of the adapter's result data) and a park all see one value.

**Provenance origin ids** are internal: origins live in the run's table and
trails hold their ids, but nothing a caller sees carries an id — the result's
provenance is the origins themselves, summarised in trail order, and a park
writes the origins themselves. The order of a trail is the order of
evaluation in both engines (a literal minted once per evaluation, an event
or handle read once per ask), and deduplication is by origin, which a fresh
id per mint reproduces exactly (identity, in the TypeScript).

### Record verbs

`verbs.rs` is run.ts's `executeMatch`, `executeLink` (with version 1's
`executeCriteriaLink`), `executeUnlinkStatement` and
`executeDeleteStatement`, for records in a system:

- **`match`** is a write's first half — the target (its WHERE included), the
  field lines, `unique by` ∪ the native rules, the shortlist, the target's
  WHERE, the rules, the judge — with no identity lock and no write. What it
  finds is bound as a handle: a `kind: "match"` row (`created` and
  `committed` false) whose `resultData` is the candidate's `{url, ...data}`
  under `readRecord`'s answer. A miss ends the enclosing scope quietly
  (`ScopeEndedQuietly`): a block's iteration skips, the movement's body
  stops, the run completes with what it wrote.
- **`link a -[:e]-> b`** and **`unlink`**: both endpoints written (or
  matched) handles in one graph; the edge, where the from side's type is
  declared, must be one of its edges and land on the to side's type; then
  `linkRecords` / `unlinkRecords` `{from: {recordType, externalId}, edgeName,
  to, mutationContext}` under the edge's lock (`edge <system> <from> <edge>
  <to>`), and a `kind: "link"` / `"unlink"` row with both endpoints' write
  origins as provenance (`created` is what the adapter answered: `created`,
  `removed`). An adapter without the method fails the statement by name.
- **`link a -[:e]-> { … }`**: from version 2 the body is a match (its row,
  its quiet end) and the link joins what it found; in version 1 a body with
  no `unique by` of its own is criteria — `describe`, the criteria as one
  AND-group over the native rules, `resolveIdentity` with no narrowing — and
  the link lands as one row (`foundTarget: true`, to-side provenance empty)
  whose bound handle's origin names that row.
- **`delete x`**: the record a handle or a traversed record stands on (the
  same resolution as `write x { … }`), `deleteRecord {recordType, externalId,
  mutationContext}` under the record's lock, and a `kind: "delete"` row (a
  handle's write origin as its provenance).

The adapter calls are ordinary `adapters.call` requests: `resolveEntity`,
`readRecord {recordType, externalId}`, `describe`, `linkRecords`,
`unlinkRecords`, `deleteRecord`, each with the TypeScript's arguments key for
key; whether an instance has a method is the `methods` its resolve answered
(a rehearsal's wrapper has `linkRecords` and `unlinkRecords` only where the
adapter does). A target WHERE's field reads are the source instance's
`getFieldValue` (`adapters.resolve role: "source"`, once per instance).

What stays the TypeScript engine's: a match, link or write into a node this
run built (the in-process stand-in adapter), tuple targets, EXISTS and
aggregates in a target WHERE (traversal inside an expression).

### Traversal blocks

`traverse.rs` is run.ts `interpretBlock` with its head walk
(`headIterationsFrom` → `walkSourceHeadPaths`) for a block (bound or not) of one
hop off a constructed instance (from its meta position), a write's handle
(from its record), the event (from the seeded position) or an enclosing
block's hop alias (a nested block: from that landing's own position,
through the graph it was landed in):

1. the head's graph: the instance resolved as a source, once per
   instance (`instanceSourceRead`); the event's source for the event;
2. the hop's fetch, `closedHopPushdown` (crate::order_limit): its WHERE when
   pure, with every leaf the scope already holds as a string, number or
   boolean swapped for that `static` (a body binding by name, a field of the
   event or of a record read now, before the fetch; never the hop's own
   alias, a bare name on an edge that carries inline properties, an
   ambient, or a read that fails); its ORDER BY when the key is a bare
   field; its LIMIT when the sort is pushed with it. `getRelated`'s argument
   object is `{position, fieldId, direction, where?, orderBy?, limit?}`, key
   for key the TypeScript's;
3. `getRelated` through the read wrapper (kg.ts `surfaceReadAdapter`): off
   the meta root a collection scan, each landing stamped with the
   collection's target type unless the adapter's own stamp names a
   position; off a record, the origin stamped with its natural type and each
   landing with the declared edge's target. An instance that streams is
   walked `iterateRelatedPage` by page, cursor echoed, through no wrapper (the
   wrapper forwards a stream untouched), each page's records filtered before
   the next page is asked for; a cursor handed back unchanged, or a walk past
   10,000 pages, fails with `iterateRelatedPages`' own errors;
4. per landed record: the member gate of a narrowed polymorphic hop
   (`hopMemberGate`, the schema's `selectedMembers` by `refinementKey`), then
   the WHERE with the hop's alias naming the record (`hopFilterKeeps`): a pure
   WHERE decided a top-level conjunct at a time, each leaf read once when its
   conjunct is reached (`decidePurePredicate`), any other evaluated whole;
5. ORDER BY / LIMIT over what was kept (`applyHopOrderLimit`): every key read
   at once (`Promise.all`), the sort V8's (empty keys last, ties in arrival
   order, a comparator's NaN read as 0, the leading run reversed when
   strictly descending, then binary insertion), the limit `slice(0, n)`;
6. a `block` trace entry (`{root, positions}`, the head as written), then the
   body once per landing, in order, at `…i<j>…` (a nested block's at
   `…i<j>.s<k>.i<m>…`, address.ts's encoding), in a scope of its own holding
   the alias. A body that fails fails the run where it stands, as the
   TypeScript's does: the iterations before it keep their writes, which ride
   out on the failure; the rest never run.

A landed record (`Landed`, `sourcePosition`) is the very position object the
adapter (or the wrapper's restamp) answered; reading its field is
`readSourcePositionField`: `getFieldValue` through the wrapper, a
`field_miss` traced for a raw-payload landing that does not carry it, a
`source_field` origin.

**Bound blocks** (`x = … { return … }`, `blockValue`): what each iteration
returns (a `return` in an `if` arm returns from the body, its value landing
in the body's scope) is collected in order; values bind as one list, their
trails unioned. A block that returned nothing binds no returned records
(`{kind: "positions", landings: []}`): read bare it is an empty list, a
field of it is null, and a park writes it as the TypeScript does. Every
`return` admission lets into a bound block returns a value (a record is
`name_not_value`), so returned records are never more than that.

What stays the TypeScript engine's (refused, "Admission" above): returning a
record from a bound block, heads of more than one hop, heads off a value, a node, an expression or
`_resources`, extraction heads (an extract is refused), a park in a body,
EXISTS and any traversal inside an expression.

**tests/order_limit_pin.rs** holds `order_limit` to the TypeScript's own
answers (tests/oracle/order_limit.json, 601 seeded brackets: the pushdown's
JSON text with seeded leaves substituted, and the items kept in order for
seeded keys of every kind, mixed text and numbers included), written by
tests/oracle/order_limit_oracle.ts through generate.ts; CI regenerates and diffs it
with the rest of the oracle.

### Nodes

`node.rs` builds `{ … }` / `node { … }` and `graph { … }` without a shape:
value entries, nested literals, and in a graph a reference entry — the
checker's `reference` stamp — as an edge landing the record itself, a record
spread copied by the checker's `copy` plan (fields; a plan that walks edges
is refused), and a map spread. A node's field reads carry the trail it was
written with.

### Parks

`park.rs` writes `ParkedScopeState` version 1 for a `sleep` (and `x = await
sleep(…)`, its `presenceBind`): the scope chain root first, each scope's own
bindings in declaration order, as `serializeBinding` writes the kinds this
engine binds (`event`, `instance`, `opaque`, `movement`, `value` as its JSON
round trip with its origins, `handle` as its record, `nodePosition` /
`nodeRef` numbered as one park's table numbers them). States cross on the eval wire both ways
(the park's `state`, the resume's `input.resume.state`), so every object keeps
its key order: a resumed value is the one stored, key for key, as the
TypeScript's is. A resume
(`input.resume = {state, reenter?}`) re-layers the movement's scope, descends
the `if` arms the address names, steps past (or re-enters) the leaf, and
finishes each enclosing body. A state either engine wrote resumes on either;
admission refuses anything else (frames, a journal with calls in it, `until`,
other binding kinds, extraction origins: `resume_state_*` above), and the
TypeScript engine resumes it.

A suspension (run.ts `suspendFlow`) writes `{version: 1, address,
bindingName: null, suspended: true, journal: [], scopeChain}` for the flow at
a statement's boundary; its journal is empty because this engine runs no
calls. The flow suspends:

- **at its cost cap.** The engine never refuses a priced call itself. The
  host refuses one once its budget is spent (the meter refuses when the run
  has spent at or past its cap), and that refusal, once its cost is charged,
  is the cap met if the ledger's own figures say so (`spent >= cap`, counted
  from `capBaselineMicrodollars`); otherwise the statement fails with the
  host's message. So the call that crosses the cap is kept, and the run
  pauses at the next priced call, just before its statement, as run.ts
  `suspendAtLimit` does. The first time, the run is marked paused
  (`commitLimitPause`) and says so on its trace (`RUN_PAUSED_COST_CAP`); a
  sink that cannot suspend is not paused, and the run fails with
  `RunCostCapExceeded`; so does a run whose sink took the pause and then
  answered `noSink` to the suspension (a host whose two answers disagree).
- **before each statement of a paused run** (`limitPaused` in the input: a
  flow woken while its run's pause holds). A sink that cannot suspend lets
  the flow run on.
- **at a `suspendAt` address**, once each. A sink that cannot suspend fails
  the run (`MOVENG_RUNTIME`). An address before a call (`… .c k`) is never
  reached: this engine runs no calls.

An operator's limit resume is an ordinary resume with `reenter`: the
statement runs again, from the run's spend with the cap counted afresh
(`capBaselineMicrodollars`), all of which the host decides.

- An expression is evaluated by the one evaluator, as one async walk (as
  `evalMovementExpr` is). What it cannot answer itself it asks
  (`eval::Reader`): the read is a host request the walk awaits where it is
  made, and the walk resumes there once answered. So the host sees the
  TypeScript's calls in the TypeScript's order, short-circuits included; a
  `CONCAT` of twenty event fields is twenty reads and one walk. Its literals
  are minted in the run's origin table as the walk reaches them. A walk
  waits on one read at a time, but it is an ordinary future: walks joined
  (parallel arms, later) have their reads in flight together. A unique by
  narrowing's predicate (crate::filter) awaits the comparator the same way.
- `adapters.call` with `wire: true` carries its arguments and its answer on
  the eval wire (below): an event payload's key order (a `field_miss` lists
  the keys in it), `undefined` and the numbers JSON cannot say cross as the
  JavaScript has them. The event itself arrives on the wire too.
- Addresses are address.ts's (`s1.b0.s2`; a block's iteration `j` is `…i<j>…`, `s1.i0.s0`).
- `done` is one of five shapes (below). What the engine does not run it
  refuses before any request, or declines after the check and before
  anything the host can see ("Admission" above), and the shim runs the
  program on the TypeScript engine.

### Errors a run can meet mid-run

These end a run partway through, after it has made adapter calls, where the
TypeScript engine would carry on. Each comes back as an error (the run
fails); none produces a different answer.

- An adapter answers a value the eval wire cannot carry as itself (a
  `Date`, a class instance, a function): `RustShimError` from the shim. The
  likely case — an event field the source's schema types as a date or a
  datetime (read by an expression, or written by a `...msg` spread as the
  checker's stamp names its fields) — is declined before the version warning
  is traced and before the source is resolved, read off the catalog snapshot (a `describe` would be an
  adapter call, after which nothing may decline).
- A value held in a binding is shaped like an engine binding (an object
  whose `kind` names one, the TypeScript's `bindingOf`): reading its field,
  comparing it by `==`, or spreading it fails with MOVENG_UNSUPPORTED ("this
  reading (…) is not supported…"). TypeScript reads such a dict as a record.
- A field read off a held object names one of `Object.prototype`'s members
  it does not own (`meta.\`constructor\``): MOVENG_UNSUPPORTED. TypeScript's
  `value[field] ?? null` finds the prototype's member.
- A record compared by identity (`a == b` where either is binding-shaped):
  MOVENG_UNSUPPORTED. TypeScript compares two records by identity.

None of the first four is a built-in's reading, so none can be handed to the
TypeScript member (`builtins.*`); each needs the record model a later slice
brings.

The record verbs, the target WHERE, nested and bound blocks add none: each
of their mid-run failures (an adapter without `linkRecords`,
`unlinkRecords` or `deleteRecord`; link endpoints in two graphs, or an edge
the from side's type does not declare; a traversed record with no stable id
parenting a write, or of no known type updated or deleted; a read that
fails part way through a fan-out) is the TypeScript engine's own, with its
message, after the same calls.

### For an embedder: the segment protocol

Every shape here is what apps/api's rust_engine.ts sends and answers; another
host answers the same requests the same way.

**The eval wire** (src/env.rs). JSON's scalars stand for themselves;
`["u"]` is `undefined`; `["n", "NaN" | "Infinity" | "-Infinity" | "-0"]`; a
list `["l", id, [items…]]`; an object `["o", id, [[key, value]…]]` in the
object's own key order; `["r", id]` the same list or object again within
one value. `["i", id]` (one of the caller's own objects) appears only in
`eval_expression`'s answers, never on a segment's host calls: a segment
writes each value out whole, numbering it afresh.

**The input** (`engine_start`): `{entry: "segment", source, languageVersion,
movementName?, event, segmentId, credentialIds?, spend?, now, catalog, dryRun?,
resume?, limitPaused?, suspendAt?}`. `segmentId` is the segment the run host opened (`segment.open`),
named on every host request; `credentialIds` maps an import's credential name
to its id; `spend` is the run's account as the segment starts
(`{priorMicrodollars, capBaselineMicrodollars, capMicrodollars?}`). `dryRun` is a
rehearsal (writes captured, `sleep` fast-forwarded); `resume` is `{state,
reenter?}`, a `ParkedScopeState` (on the eval wire) to resume rather than a
run to start; `limitPaused` says the run's pause holds, and `suspendAt` lists
the addresses to suspend at (both "Parks" above). `languageVersion` is the pin,
written out (the engine does not know the release's current one); `event`
is the `TriggerEvent` on the eval wire; `now` is the run's pinned instant as
a `toISOString` text (`firedAt`, else when the run began); `catalog` is the
`CatalogSnapshot`. Other members are ignored.

**Requests and answers.** An answer is `{value}`, `{}` for `undefined`, or
`{error: {message, name?, ref?}}`; `ref` numbers the very error object the
host keeps, so a run that fails with it can name it.

Every request but `check`'s and `builtins`' carries `segmentId`, and is the
`EngineHost` method's request of the same path, in docs/engine-host.md's
shape. Where `wire: true`, the values named cross on the eval wire.

| request (family.method, args) | answer |
|---|---|
| `check.program {source, languageVersion, upgradingFrom?}` | `{diagnostics, link?, stamps, versionWarning?}` (below; `versionWarning: {code, message}` is the deprecated pin's warning the run traces, as the host's engine reads its release, not the checker's diagnostic); a program that fails its check gets no answer: the host ends the run with the check's error |
| `adapters.resolve {segmentId, adapterType, credentialsId?, constructionArgs?, role: "source" \| "target", dryRun?: true}` | the instance as data: `{instance, adapterType, methods, capabilities, …}` |
| `adapters.call {segmentId, instance, method, args, wire: true, positionRef?, position?}` | `{result}` (on the eval wire) or `{error: {kind: "call_ceiling" \| "adapter_error", message, name?, detail?, ref}}`; `ref` numbers the very error the engine's TypeScript twin raises for it. With `positionRef` the call's argument object is `{position, ...args}`: the position by handle (below) |
| `llm.arbitrateEntities {segmentId, asserted, candidates, recordType, constraints, languageVersion, budget}` (the first four on the eval wire) | `{index: number \| null, judgeUnavailable?, cost?}`, or a budget refusal `{error: {kind: "budget", message}, cost?}` |
| `locks.acquire {segmentId, names}` / `locks.release {segmentId, token}` | `{token}` once held / `undefined` once let go |
| `park.sink.commitTimerPark {segmentId, address, state, wakeAt, wire: true}` (`state` on the eval wire) | `undefined`, or `{noSink: true}` for a host with no park sink (the run fails as the TypeScript's does) |
| `park.sink.commitSuspension {segmentId, address, state, wire: true}` (`state` on the eval wire) | `undefined`, or `{noSink: true}` for a sink that cannot suspend |
| `park.sink.commitLimitPause {segmentId, limit: "cost", capMicrodollars, spentMicrodollars}` | `undefined`, or `{noSink: true}` for a sink that cannot suspend (nothing is committed) |
| `control.cancel.cancelled {segmentId}` / `control.cancel.cancelledNow {segmentId}` | a boolean: the cancel gate, debounced / not |
| `trace.append {segmentId, entries, closing?: true}` (one per statement that traced; the last, as the segment ends, is marked `closing` and may fail without failing the run, the shim logging it) | `undefined`; an entry is `{kind: "warning", code, message}`, `{kind: "gate", outcome}`, `{kind: "field_miss", binding, field, available: [key…]}` or `{kind: "block", root, positions}` |
| `builtins.function {id, args, now, languageVersion}` | `{value}` or `{threw: {class: "MovementEngineError" \| "Error" \| "RangeError", code?, message}}`: the TypeScript member's value or what it throws; `id` is the lowered function id (`date.format_iso`, `trim`), `args` on the eval wire, the value too |
| `builtins.compare {op, left, right}` | the same two shapes, for `compareValues(left, op, right)`; `op` a `FilterOperator` |

A host answer is `{value}`, `{}` for `undefined`, or `{error: {message,
name?, ref?}}` for a call the host threw on.

**Positions by handle.** A read re-sends a handle, not the record: a
`getFieldValue`, `getRelated` or `iterateRelatedPage` names its position by
`positionRef`, a number the segment gives each position object the first
time it sends it, and that first call carries the position itself
(`position`, on the eval wire), which the host keeps for the segment. Every
later call naming it carries only the number; the host hands its adapter
`{position, ...args}` — the position leads each of those argument objects,
so the key order is the TypeScript engine's — and the very object it
registered. A hop WHERE reading k fields of n records sends each record
once, not k times; the event's payload crosses once per segment. The
shim's dispatch is rust_host.ts `withPosition`, in the one module that
routes host requests. The table lives as long as the segment: empty when
the segment opens, dropped when it closes, never written into a park (a
resumed run's segment numbers its positions from 0 again). The engine
looks a position up by its object's address and holds the object, so an
address is never reused while the table could still find it; a landing's
field-read stamp is made once, so a streamed record crosses once too. (The cheaper of the two shapes the review named:
batching the reads would change when each is asked, and a WHERE reads its
conjuncts' fields in order, a false one ending the reads.)

**How a failure is encoded.** Four places, one rule each:

| what failed | encoding |
|---|---|
| a host call the host **threw** on (a park it could not persist, a lock timeout, a lost lease) | the answer envelope's `{error: {message, name?, ref}}`; the request's future resolves to an `Err`. `ref` numbers the very error the shim holds |
| an adapter call whose **own** result is a failure (`call_ceiling`, `adapter_error`), or a priced call refused as `budget` | data inside `{value}`: `{value: {error: {kind, message, …}}}`, as the host contract answers it; the engine decides what it means |
| a built-in the TypeScript member answered by throwing (`builtins.*`) | `{value: {threw: {class, code?, message}}}`: the engine rethrows it as its own error of that class |
| the run, at its end | `done`'s `error`: `{class, code?, message}` for an engine error, or `{hostError: ref}` for the error a host call failed with (the shim throws that very object) |

**`done`**:

- `{result: {movementName, writes, parked?: true, parkedAddress?, cancelled?: true}}`,
  `writes` the firing records on the eval wire;
- `{failed: {error, result}}`: the body failed, and `result` is what the run
  had when it did (the shim throws `MovementRunFailed`);
- `{thrown: error}`: it failed before the body ran;
- `{refused: reason}`: admission refused the program or its parked state
  on this engine's own parse; nothing was asked of the host;
- `{declined: reason}`: past the check, nothing the host can see has
  happened; run the program another way.

Beside any of the first three, `cost: [{source, microdollars}]` is what the
segment's priced calls spent, by source, for the run's account.

`error` is `{class: "MovementEngineError", code, message}` (`message` without
the `CODE: ` the TypeScript constructor adds), `{class: "Error" |
"RangeError", message}`, `{class: "RunCostCapExceeded", capMicrodollars,
spentMicrodollars}` (the cap met where the run cannot suspend; the shim
builds the TypeScript's error from the figures), or `{hostError: ref}`: the
error a host call failed with, by the `ref` its answer carried. A run that
suspends at its cap ends in a parked `result`.

## Spec the tail, mirror the cheap core

The rule for what this engine reproduces of JavaScript:

- **The cheap core is mirrored exactly.** Numbers (`Number(text)`,
  `String(number)` through `ryu-js`, `Math.round`, `toFixed`, `%`), strict
  equality, truthiness, key order, UTF-16 lengths and comparisons. Each is
  pinned by the test the table above names.
- **The expensive tail is specified, not mirrored.** The regex dialect,
  permissive date parsing (V8's legacy parser, local time), Unicode case
  tables and prototype-key quirks get the language's own semantics. Until
  then this engine answers only what it reproduces and hands the rest back
  (`fallback`, `builtins.*`).
- **One reading differs today: Unicode case mapping.** `toLowerCase` /
  `toUpperCase` follow Rust's tables (Unicode 17); Node 22's ICU follows
  Unicode 16. A character whose properties changed between the two can map
  differently. The known case is U+0295 (ʕ), which counts as cased for the
  final-sigma rule in Rust and not in Node: `"ΑΣʕ"` lowers to `αςʕ` here and
  `ασʕ` in TypeScript. This is an accepted divergence, pinned by
  `stdlib::tests::case_mapping_follows_rusts_unicode_tables`, and is not
  handed back.
- **One more may differ: a hop's ORDER BY over keys of mixed types, past
  64 records.** The sort is V8's (crate::order_limit): binary insertion up
  to 64 items, which reproduces V8 exactly for any comparator; past 64 this
  engine merges the runs stably, which agrees with V8's TimSort for every
  total order. Mixed text and number keys are not one (the comparator has
  cycles), and there the two merges can place records differently. Ruled:
  specified, not mirrored (the order_limit pin holds every set of 64 or
  fewer, mixed included).
- **The specification lands as a language-version change.** A version
  conditional at the point of difference, and a checker diagnostic under the
  new version for any construct whose meaning changes. Saved movements keep
  their pin, and with it JavaScript's behaviour, on the TypeScript engine
  until that version is deprecated. **Deferred** to the next
  language-version bump:
  - the regex dialect (the hand-written matcher, `js_regex`, is a
    transition artefact that the bump retires);
  - date parsing (what a date text may be, and no local time);
  - Unicode case mapping: which Unicode version the language's case tables
    follow, so neither engine's runtime decides it.
  - a hop's ORDER BY over keys of mixed types: one total order over every
    key kind (say: nulls, then numbers, then text), so no sort algorithm's
    merge decides where a record lands.

## The check

The checker is still TypeScript, so a segment asks for it: `check.program
{source, languageVersion, upgradingFrom?}`, checked against the run's own
snapshot (the host holds it; the segment was handed the same), answered
`{diagnostics, link?, stamps}` by apps/api's program_check.ts (the same check
every TypeScript run passes). A program that fails it never gets an answer:
the host ends the run with MOVENG_CHECK (or MOVENG_PARSE,
MOVENG_LANGUAGE_VERSION), exactly as the TypeScript engine throws before it
runs anything.

The checker mutates the AST the engine then reads, so its three facts cross
as **stamps**: `{file?, path, spreadFields | copy | reference}`.

| stamp | the node | what the checker wrote |
|---|---|---|
| `spreadFields: [name…]` | a write's spread (`write … { ...d }`) | `WriteSpread.fields` |
| `copy: CopyPlan` | a graph's spread (`graph { ...r }`) | `MapSpread.copy` (`{fields, edges: {name: CopyPlan}}`) |
| `reference: true` | a graph entry whose value is a record (`graph { owner: r }`) | `NodeEntry.reference`: the entry is an edge holding it |

- `path` is an **AST path**: a JSON Pointer (RFC 6901) from the `Program`
  object through the program's JSON exactly as the parser emits it, e.g.
  `/statements/5/body/0/arms/0/body/1/value/node/entries/0`.
- `file` names the library for a stamp in an imported file (the pointer is
  then from that file's `Program`); absent for the program run.
- `program_check.unit` pins that these three are all: a fresh parse with the
  stamps applied must equal the checked program, the root's and a library's.
- `program::join_check` re-parses, places each stamp and refuses one that
  does not land on a node of its kind.

The **link**: `{imports: [import…], files: [{path, source, imports:
[import…], exports: [{name, kind, declaration}]}]}`, where an import is
`{local, kind: "movement" | "shape", name, file, declaration}` and
`declaration` is an AST path into its file (`/statements/<i>`). Problems are
among the diagnostics.

## Environment services

What the language leans on JavaScript's runtime for — the zone database,
WHATWG URL parsing, locale number formatting, Unicode normalisation — the
engine asks of `EnvServices` (src/env_services.rs), five operations:

| operation | answers | JavaScript |
|---|---|---|
| `tz_convert {instantIso, zone}` | `{year, month, day, hour, minute, second, millisecond, offsetMinutes, weekday}` or null (not a zone) | `Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23', …}).formatToParts` |
| `url_parse {text}` | `{href, protocol, username, password, host, hostname, port, pathname, search, hash}` or null | `new URL(text)` |
| `number_format {value, locale, options}` | text, or null | `Intl.NumberFormat` (decimal; `minimumFractionDigits`, `maximumFractionDigits`, `useGrouping`) |
| `normalize {text, form}` | text | `String.prototype.normalize` |
| `now {}` | milliseconds since the epoch | `Date.now()`: the wall clock, read only for a timer park's `wakeAt` (every clock read a program makes answers from the run's pinned instant) |

Two implementations:

- **WASM** (`HostImports`): the import `movement_env.call`, a request's
  JSON in and `{value}` out, which the loader gives every instance from
  packages/movement-lang/wasm/env_services.ts. Synchronous, so the evaluator
  calls it mid-expression. The TypeScript engine and the Rust one read zones,
  URLs and text from the one runtime.
- **Native** (`native::Native`, the default `native-env` feature, inert on
  wasm32): `jiff` with its bundled zone data, the `url` crate, ICU4X's
  normaliser and decimal formatter.

tests/env_services.rs holds the native one to tests/env/fixture.json (every
operation but `now`, whose answer is the moment it is asked):
8,457 requests answered by Node 22.20 through the very module the loader
imports (generate.ts; seeded; every IANA zone at seven instants including a
European daylight-saving week and one before the common era; every half
hour across the US (2026-03-08, 2026-11-01) and southern-hemisphere
(2026-04-05, 2026-10-04) changes in the zones that keep them; aliases, offsets,
invalid names; IDN, IPv4/IPv6, percent-encoded and opaque hosts; NFC/NFD/
NFKC/NFKD over compatibility, Hangul and combining sequences; 14 locales).
packages/movement-lang/wasm/__test__/env_services.unit.test.ts holds the
JavaScript one to the same file. Where they differed, and what was done:

| difference | handling |
|---|---|
| zone data: Node 22.20's ICU carries tzdata 2025b, current jiff 2026e (Morocco's and Moldova's rules, Tijuana 1974) | `jiff-tzdb` pinned to 0.1.4 (2025b), so `jiff` held at 0.2.16; `both_sides_read_one_zone_database` checks the pin against tests/env/versions.json |
| `Factory` is an IANA file but not an ICU zone | refused natively |
| Intl writes the year of its era (1 BC is 1), and the TypeScript derives the offset and the weekday from that reading through `Date.UTC` | the native fields are derived the same way |
| the `url` crate reads a `\` in a non-special URL's authority into the path; WHATWG fails it | refused natively |
| `de-CH` groups with ’ in ICU4C 77 and with ' in ICU4X 2.3's data | **accepted divergence**, not in the fixture; nothing formats locale numbers yet |
| `-0` | not in the fixture (JSON writes it as `0`) |

## Building and testing

```bash
scripts/build-movement-wasm.sh    # the artifact, its sha256 and size
cargo test -p movement-engine     # the executor, builders, evaluator, run, ABI and environment services, natively
```

The TypeScript side: `apps/api/src/services/movement_engine/__test__/rust_engine.unit.test.ts`
(the shim against a scripted double, and its routes against the host
manifest), `rust_engine_abi.unit.test.ts` and `rust_eval.unit.test.ts` (the
committed artifact), `rust_run.unit.test.ts` and `rust_write.unit.test.ts`
(whole runs on both engines, compared). The oracle for the evaluator and the
runs is the conformance corpora run with `MOVEMENT_ENGINE=rust`.

**Running a corpus case on Rust.** In apps/api, after
`scripts/build-movement-wasm.sh` if a crate changed:

```bash
MOVEMENT_ENGINE=rust pnpm test:conformance:v2                       # the whole corpus: routing floors apply
MOVEMENT_ENGINE=rust pnpm test:conformance:v2 --testPathPattern refs  # one file: no floor, every other check
MOVEMENT_RUST_RUNS_BY_FILE=1 MOVEMENT_ENGINE=rust pnpm test:conformance:v1  # per-file routed counts
```

The teardown prints `Rust evaluator: {…}` (expressions not admitted,
admitted, answered, fallbacks by reason), `Rust runs: {runsRouted,
runsAdmitted, ranWhole, shimFaults, declined, hostCalls}` (routed counts the
segments admission refused too; admitted does not) and `Rust runs not
admitted: {reason: count}` (largest first), and fails a run in which Rust
answered nothing, admitted runs none of which ran whole, any decline or
shim fault, or a whole-corpus run under its routing floor (v1 117, v2 139). Any filter (a path or name pattern, related or
changed files, a shard, positional paths) makes a run partial, and the floor
does not apply to it.
