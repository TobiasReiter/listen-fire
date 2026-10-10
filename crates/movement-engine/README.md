# movement-engine

The movement engine in Rust. A segment of a run executes inside one WASM
instance and asks for everything outside the program in the host contract's
own shapes (docs/contracts/host-families.md); `apps/api/src/services/movement_engine/
rust_engine.ts` drives it, and `rust_host.ts` forwards each request to the
run's `EngineHost`.

Under `MOVEMENT_ENGINE=rust` the engine runs two things:

- **an expression** over value bindings, which the TypeScript evaluator hands
  to `eval_expression` (slice 1, "The evaluator" below);
- **a whole run** of a program it admits on its own parse ("Admission"
  below): bindings, `if`
  and `return` over reads of the event and of values (slice 2a), writes with
  identity (`unique by`) and the nodes a run builds (slice 2b), `sleep`,
  parked and resumed in the TypeScript engine's own state (slice 2b),
  traversal blocks over adapter edges (chunk 5B), and the extraction keyword
  and plugin calls (chunk 6A) — "The run" below. apps/api's `rust_run.unit.test.ts` and `rust_write.unit.test.ts`
  hold these runs to the TypeScript engine; the conformance corpora route
  their admitted cases whole.

## Modules

| module | what |
|---|---|
| `executor` | a single-threaded async runtime: the segment is one future; a `HostCall` future registers its request and yields; `join_all` keeps several in flight; `map_concurrent` runs a fan at most so many at a time (fans.ts `mapConcurrent`) |
| `host` | one request builder per host call, each family spelled as host.ts's `HOST_FAMILIES` spells it (`adapters`, `llm`, `llm.client`, `llm.transforms`, `park.sink`, `control.cancel`, `locks`, `trace`, `clock`, `files`, `ids`), plus the engine's own (`check`, `builtins`, `log`); every host request names the segment |
| `ledger` | the run's spend account for one segment: the budget a priced call is sent, the cost each answers charged, the cap met (`exceeded`) once a budget refusal is charged, a priced plugin refused before the host is asked once the cap is spent (`plugin_refusal`), the charges handed back with `done` |
| `admit` | admission: the allow-list walk over this engine's own parse, before the check; a refusal's stable reason (below) |
| `abi` | the C ABI: `engine_start`, `engine_answer`, `engine_finish`, `eval_expression` |
| `eval` | `evalMovementExpr` over the host-free kinds, with its provenance rules and errors; the folds; what a walk, an `EXISTS` over a record, or a count needs asked of the run |
| `stdlib` | the 17 flat built-ins and all 15 namespaced members |
| `run` | the `segment` entry: `runMovement` / `resumeMovement` for the programs the shim admits (below) |
| `write` | the `write` statement: targets (a WHERE on one included), fields, identity, update or create, the firing record |
| `verbs` | `match`, `link`, `unlink`, `delete`: the identity half of a write on its own, edges between two handles, a record removed |
| `traverse` | traversal blocks over adapter edges: the head's graph, the hop's fetch, the member gate, the WHERE per landed record, ORDER BY / LIMIT, the body per landing; the walks an expression reads, `EXISTS` and a pick |
| `is_test` | a condition's `IS <type>`: the event, a handle, a landing, a node declaration's structure |
| `order_limit` | packages/shared/expression/order_limit.ts: a hop's pushdown (closed over its scope) and its ORDER BY / LIMIT over what came back, sorted as V8 sorts |
| `address` | address.ts's lexical addresses: `s`, `b` and fan-out `i` steps |
| `unique` | `unique by`: the clauses split into keys and narrowings, the search record, the rules that decide without a judge, the identity lock |
| `node` | node and graph literals: value entries, nested nodes, reference entries and record copies (the checker's stamps) |
| `park` | `ParkedScopeState` v1 written and read as serialize.ts writes and reads it |
| `bindings` | what a name in a run is bound to, the lexical scopes (in declaration order), the source `Position` |
| `trace` | the `MovementTraceEntry` kinds a run appends (`warning`, `gate`, `field_miss`, `block`, `extraction`, `plugin`), and the per-flow buffer they wait in until their statement ends |
| `program` | the pinned source parsed, joined with the `check.program` host call's answer: diagnostics, the import link, the checker's stamps by AST path; the declarations (`Declarations`: the root's and each library's shapes and `type`s, each shape with the file that wrote it, and the plugin imports, by local name) |
| `extract` | the extraction keyword (`x = extract from […] { tree }`): the spec resolved per firing and the calls planned over it (`spec`), each call's system, user and retry messages (`prompt`), a reply read as zod reads it (`validate`), the content read and fetched as resources (`resources`), what it yields (`emission`), and the walk — the model loop, `through` stages, fences, the trace (`run`) |
| `plugin` | a plugin called plainly (`page = fetch_url(url: …)`): its arguments, the invocation timed and priced, what it binds by its declared output |
| `env_services` | `EnvServices`: zones, WHATWG URLs, locale numbers and Unicode normalisation, from the JavaScript runtime (WASM) or natively (below); never a clock |
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
| extraction specs, prompts and the validator (chunk 6A, not yet run) | 2,185,406 | 623,115 |
| the extraction keyword and plugin calls run whole (chunk 6A) | 2,423,062 | 694,914 |
| folds, EXISTS, IS and a record named twice (chunk 6A Task 4) | 2,458,709 | 710,999 |
| language version 4's changed constructs refused at admission (main merge 2) | 2,459,419 | 711,283 |
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
  reads it in the zone through the environment services. The engine reads
  no clock of its own.

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

`tests/extraction_pin.rs` holds crate::extract and the priced-plugin cap to
tests/oracle/extraction.json: 160 seeded programs (library files, `extends`,
declared and borrowed types, `through` stages) with the spec, every region's
site ids, system prompt and retry envelope, and about 2,200 seeded replies
read (data, coercions, or zod's issues, the retry message and the failure's
detail); 120 user messages; 17 `from` data; 80 priced-plugin ledgers. It is
written by tests/oracle/generate.ts with the others, and CI diffs it too.

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
   resume), on its own parse and the input (a plugin call's declared output
   is read off the input's catalog snapshot, its `plugins` alone), before
   the catalog loads, before `check.program`, before any request: a refused
   run costs one parse and one walk, and no host call
   (`rustRunStats.hostCalls` stays `{}`).
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
| `import_from_file`, `import_from_<namespace>` | an import from a library file, or from a namespace other than `adapters`, `credentials` and `plugins` |
| `file_assignment` | a file-level binding that is neither an instance construction nor a value (a file-level `extract`, …) |
| `file_call` | a file-level construction spelled with a movement's or a plugin's name (a call) |
| `file_statement:<kind>` | any other file-level statement, by the AST's `kind` (`write`, `call`, …) |
| `movement_value_param` | a movement taking a value (`n: <number[]>`) |

A file-level `node <Name> { … }`, `type`, `import … from plugins` and value
(`rules = "…"`) are admitted: each binds a name and runs nothing, as
`interpretFileStatement` does. A file-level value is walked as a body's
expression is, reading only the file-level values before it; a body reads
it as a value. A declared shape's words are walked in the file's scope (an
extraction reads them there). An extraction reads a shape and a type, and a
plugin call a plugin, and an `IS` test a node declaration; what else reads
one is refused where it stands (`graph_shape`, `node_declared_entry`,
`is_test_declared_record`).

**Admission: a body** (`notAdmitted`; every movement in the file is walked):

| reason | the construct |
|---|---|
| `name_shadowed` | a body binds a name the movement's parameters or the file bind |
| `name_rebound` | a body binds one name as two kinds (a value and a handle, …), or twice where one binding can see the other (in one scope, or in a scope and one inside it); names are scoped lexically, so two blocks may reuse a hop alias, and two arms or two block bodies a name |
| `statement:<kind>` | a statement other than a binding, `write`, `match`, `link`, `unlink`, `delete`, `if`, a traversal block, `await sleep(…)`, `ERROR(…)` and `return` (`call`, `combinator`, `collection`, `refresh`) |
| `block_head_rootless`, `block_head_expression_root` | a block head with no root, or rooted at an expression (`AT(rows, 0)-[c:company]->`) |
| `block_head_value_root`, `block_head_node_root`, `block_head_root` | a head rooted at a value (a list of records), at a node or graph the run built (its own graph's plane), or at anything but an instance, a write's handle, the event, an enclosing block's hop alias or what an extraction yielded |
| `block_head_extract_hop` | a head over what an extraction yielded whose hop carries a WHERE (the TypeScript refuses it), an ORDER BY, a LIMIT or an incoming direction (which the TypeScript does not read) |
| `block_multi_hop` | a head that walks more than one hop (`crm-[c:companies]->-[d:deals]->`) |
| `block_head_resources`, `block_head_step`, `block_head_does_not_lower` | a `_resources` head (off the event or off what an extraction yielded), a hop that is not an edge, a head the probe cannot read |
| `block_park` | an `await sleep(…)` in a block's body: an iteration that parks is joined by the fan-out's frame, which this engine does not keep |
| `rvalue:<kind>` | a right-hand side other than an expression, a built-in's call, a write, a match, a link, a node or graph literal, a construction, an extraction, a plugin's call and `await sleep(…)` (`extractCall`, `callback`, `lazy`, `closure`, `collection`, `members`, `inlineBlock`, `combinator`); for `return`, also `extract`, `node`, `write`, `match` and `link` |
| `extract_tier` | `extract "careful" from […]`: what a tier buys is the deployment's (`EXTRACTION_TIERS`), which this engine does not read |
| `await_not_sleep` | an `await` of anything but `sleep(…)` |
| `movement_call` | a construction in a body spelled with a movement's name |
| `plugin_call` | a plugin's call this engine does not make: inside an expression (`{ page: p(…) }`), spelled in another letter case than imported, or of a plugin the input's snapshot does not describe; a `through` stage naming no imported plugin |
| `plugin_call:records` | a call of a plugin whose declared output is `records` (one record per thing fetched), which this engine does not bind |
| `plugin_call_form` | a plugin's call with a positional argument, or an argument that is not a value (a call, a node, a write) |
| `function_call` | a call whose callee the program declares (a movement, any letter case from version 3), or any call before version 3 |
| `builtin_call_form` | a built-in's call with a named argument, an argument that is not a value (a closure, a write, a node), or no expression to read |
| `write_bind` | a write with `bind` |
| `write_tuple` | a tuple write |
| `write_position_not_record` | `write x { … }` where `x` is not a write's handle or a block's hop alias (a node or graph entry the run built, updated in place, among them) |
| `write_position_member_path` | `write m.k { … }`: a write from the record a map's member holds |
| `v4_match_absent` | under language version 4, any `match` (bound, a statement, a link's body): a miss binds absent and the block carries on, where this engine ends the scope |
| `v4_old_edge` | under language version 4, a hop over an `@` edge (`-[:@old]->`, a block head's, a walk's, an `EXISTS`'s, a write's or a match's target): the record a write handle held before its write |
| `v4_write_in_place` | under language version 4, `write org { … }` on a write's handle: the handle moves on to the updated record in place, and its `@old` is the handle as it stood |
| `v4_handle_read_as_found` | under language version 4, a write with `unique by`, or `write c { … }` on a block's hop alias: an update's handle reads the record as found for the fields the write did not send (`foundData`) and holds it as `@old` |
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
| `write_spread_path`, `node_spread_path` | `...m.k` in a write, or in a graph literal: a spread of what a map's member holds |
| `graph_shape` | `graph<Shape> { … }` |
| `node_spread` | a spread in a `node { … }` literal |
| `node_spread_source` | a graph spread of a name that is not a value, a handle or a node |
| `node_event_entry` | a node entry holding the event itself |
| `node_declared_entry` | a declared edge entry (`kids: <T>`) |
| `node_traversal_entry` | a traversal entry |
| `is_test_declared_record` | `x IS <Decl>` (a node declaration) where `x` is the event, a handle or a landed record: its structure is its system's types, compared by the checker's assignability, which this engine does not carry |
| `is_test_declared_graph` | `x IS <Decl>` where `x` is a `graph { … }` literal, which may hold a system's records |
| `condition_does_not_lower`, `expression_does_not_lower` | a slot that does not lower (the checker's miss) |
| `expression_closure` | a closure inside an expression: a collection op written in place (`{ all: MAP(xs, (x) => …) }`), which the TypeScript engine runs as a call bound first (from version 3) |
| `name_not_value` | a name read that is not a value the body binds (the event, a handle, an instance), other than `x = <name>` of a record (a second name for it), `x == null` / `x != null` of any bound name, and an `EXISTS`, `IS` or walk rooted at it |
| `traversal_root` | a field read rooted at a name that is not the event, a value, a handle, a node or a block's hop alias; a walk (or an `EXISTS` over hops, or a pick) rooted at a name that is not the event, an instance, a handle, a hop alias or what an extraction yielded |
| `traversal_step`, `exists_step` | a walk's hop, or an `EXISTS`'s, that is not an edge |
| `traversal_meta_edge` | a hop (a block head's, a walk's, a pick's, a write's or a match's target) over a `#`-prefixed edge: the engine's own meta references, which the TypeScript read wrapper hands the adapter unrestamped |
| `walk_extract_hop`, `exists_extract_hop` | a hop down what an extraction yielded with a WHERE (the TypeScript refuses it), or, inside `EXISTS`, with an ORDER BY or a LIMIT |
| `exists_over_value` | `EXISTS(v-[…]->)` or `EXISTS(v WHERE …)` of a value (the TypeScript refuses it) |
| `exists_node` | `EXISTS(n-[…]->)` of a node this run built |
| `walk_records` | a bare walk (`crm-[c:companies]->`) read as a value: a list of records, which a value cannot hold here |
| `aggregate_records` | `FIRST`/`LAST`/`ONLY`/`SUM`/… of a bare walk anywhere but as a binding's whole right-hand side (`x = FIRST(…)`); `COUNT` of one is admitted |
| `select_multi_hop` | `x = FIRST(…)` of a walk of more than one hop |
| `aggregate:only` | `ONLY(e)` of anything but a name (its failure spells `e` back, as the formula serializer does) |
| `aggregate:sort_key` | `SORT(xs, key)` whose key is not a field name |
| `aggregate:llm` | the `llm` fold |
| `traversal_steps` | a field read rooted at a held name (`c.\`name\``) that also walks hops before it |
| `traversal_terminal` | a walk ending in anything but a field |
| `static_number` | a numeric literal JSON cannot carry (`Infinity`, `-0`) |
| `proto_key` | a `__proto__` key written in an object literal |
| `within_compare` | `WITHIN` |
| `meta:<key>` | `@user_*` and `@actor_*` (looked up through the host), and any other key the dispatch's `meta.bag` carries: only `@current_date` and `@current_timestamp` are read here |
| `function:<id>` | a function the evaluator does not run, by its lowered id (`chunks`, `domain_of`, …) |
| `expression:<type>` | an expression kind that needs the host, by its lowered `type` (`llm`, `meta`, `resource_traverse`, `kg_value`, `edge_property` outside a hop's WHERE, …); a rootless `EXISTS(-[…]->)` is `expression:exists` |

`parallel` is not run here: it prints `statement:combinator` or
`rvalue:combinator` and the TypeScript engine runs the whole program (it
unlocks four recorded runs, and chunk 6A spent its budget on extraction; the
next slice's first item).

A hop's WHERE and ORDER BY key, and a write's or a match's target WHERE, are
walked as expressions scoped at the landed record (the candidate, for a
target): a bare name (`property`, `edge_property`) is the record's
field (or a value the body binds of that name), and the rest is the
expression walk above.

**Admission: the input** (`notAdmitted`; `admit::input_refusal`, on the
parse, before anything is asked):

| reason | what the input would make the run do |
|---|---|
| `cost_cap_inside_block` | a capped run with a priced step in a block's body — a write, a match or a link that matches, an extraction, a plugin's call: the cap can be met at any of them, and a flow suspended in an iteration is joined by the fan-out's frame, which this engine does not keep |
| `suspend_at_inside_block` | a `suspendAt` address with an `i` step: likewise |
| `suspend_at_call` | a `suspendAt` address with a `c` step (before a statement's k-th call): this engine keeps no call journal to run a statement again by |

**Admission: a parked state** (`notAdmitted`; `park::resume_refusal`):

| reason | the state |
|---|---|
| `resume_state_does_not_read` | it does not read off the wire |
| `resume_state_version` | a version other than 1 |
| `resume_state_frames`, `resume_state_until` | frames, an `until` |
| `resume_state_journal` | a journal with a call in it (a suspension's journal is empty when this engine wrote it) |
| `resume_state_suspended` | a `suspended` other than `true` |
| `resume_state_address` | an address stepping into anything but `if` arms (`^s\d+(\.b\d+\.s\d+)*$`) |
| `resume_state_kind:<kind>` | a binding of a kind this engine does not rebuild (`extractRoot`, `extractPosition`, `localShape`, a `shape` outside the file scope, …); the file scope is rebuilt from the program, so a declared shape there is not the state's. This engine writes an extraction's emission into a park as the TypeScript does, and the TypeScript engine resumes it |
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

### Language version 4: the port list

This engine runs language versions 1 to 3. Version 4 (Luminous Owl, main's
d5bb93f794) changed what four constructs mean, and each is refused by name
under `since(v, 4)` until it is ported (PLAN-07A); a version 1 to 3 program
is admitted exactly as before.

| main's change | sha | refused as |
|---|---|---|
| a named match that finds nothing binds absent and the block carries on; a judge outage on a match leaves a `MOVENG_MATCH_JUDGE_UNAVAILABLE` warning | 26ed0b502f, 30e1acc55b | `v4_match_absent` |
| `-[:@old]->` off a write handle: the record the write found, the handle itself under `dry_run`, the previous handle on a chained write | 1bd0d3aa10, 30e1acc55b | `v4_old_edge` |
| `write org { … }` on a handle updates it in place | 1bd0d3aa10 | `v4_write_in_place` |
| a handle reads the record as found (`foundData`) for a field its write did not set; a parent link carries only what the parent's own write got back | 1bd0d3aa10, ac7ac15ec8 | `v4_handle_read_as_found` |

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
- **The admission dry run** (`rustRunStats.dryRun`, under `runs.dryRun` in
  engine-stats): every run and resume the TypeScript engine runs because
  `MOVEMENT_ENGINE` did not choose this engine is also put to this engine's
  admission, without running it. The shim builds the segment input a real
  run would, calls the start entry, and reads the first step: a `refused`
  done is the verdict, and an admitted run's first step (`check.program`) is
  never answered; the segment is finished there. So the dry run makes no
  host call and changes nothing about the run, and a fault in it is counted
  (`faults`) and logged at warn, never thrown. It counts `firings` (runs it
  could ask about), `sampled` (runs it asked about), `admitted`, `first` (refused
  runs by the reason named first, the one a real run is counted by), `all`
  (refused runs by every reason named, once each, when the engine names them
  all; the first alone until then) and `byVersion` (the same, by the run's
  pinned language version). It misses what admission cannot see: declines
  after the check (`event_field_dated`) and mid-run hand-backs.
  A rehearsal is not asked about. `MOVEMENT_ENGINE_DRY_RUN_EVERY=N` asks
  about one firing in N (default 1, every firing; 0 turns it off; every
  entry that runs movements refuses anything but a whole number at boot).
  What one costs: the event and the catalog serialised onto the wire, a
  fresh WASM instance, this engine's parse of the program and of its
  plugins, and, for an admitted run, the catalog load. So every run the
  TypeScript engine runs now also opens a WASM instance: memory and garbage
  collection under load grow with the firing rate, and sampling is the
  remedy. `pnpm dev:engine-dry-run-latency` measures it over the recorded
  corpora (p50 about 0.9 ms, p95 about 2 ms, p99 about 4 ms on a laptop);
  `dryRun.durationMs` in engine-stats is the same over this process's last
  1,000 dry runs (timed by the host's clock, which the engine never reads).
- **The daily roll-up**: each process holds its verdicts and, at most once a
  minute after a drain pass, writes them into one `ops_event` row per day
  (`detail.kind = "engine_admission_dry_run"`: tallies by version, refused
  runs by reason and automation id, at most 100 automations named per
  reason with the rest counted, at most 200 reasons with the rest as
  `other`). Reasons, versions and opaque ids only. The admin ops views
  leave these rows out. drain:once writes its own before it exits.
  `pnpm engine:refusals --days N [--json]` sums the rows into the burn-down
  in demand order: for each reason, the runs it blocked, how many
  automations, and the five with the most runs; by first reason and by every
  reason. The operator event store keeps 14 days, so N is at most 14.

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
| `clock.now` | a `sleep`'s wake time; a `WITHIN` the comparator measures (once per comparison in an expression, once per conjunct of a hop's WHERE and once per record of a `unique by` narrowing that reaches one, as expression.ts `decideWithClock`) | `host.clock.now`, its answer read as the TypeScript engine reads it |
| `builtins.function`, `builtins.compare` | a built-in reading this engine hands back (V8's date parser, local time, a regex feature, `WITHIN` with the clock's answer) | the TypeScript member itself |
| `park.sink.commitTimerPark` | a `sleep` in a run that is not a rehearsal, on a host that serves it | `host.park.sink`; `wakeAt` is `clock.now`'s answer plus the sleep |
| `park.sink.commitLimitPause` | the first time the run meets its cost cap (a budget refusal, charged, that the ledger says is the cap), on a host that serves it and can suspend | `host.park.sink.commitLimitPause` |
| `park.sink.commitSuspension` | the flow suspends: at the statement that met the cap, before each statement of a paused run (`limitPaused`), at a `suspendAt` address; on a host that serves it | `host.park.sink.commitSuspension` |
| `control.cancel.cancelledNow` | the last check (not after a park) | `host.control.cancel.cancelledNow` |
| `llm.client.call` | each region of an extraction, once, and once more when its reply does not read ("Extraction" below); `{segmentId, system, userMessage, label, model, effort, maxTokens?, budget}` | `host.llm.client.call`, answered on the eval wire (`parsedJson` as `JSON.parse` left it); its cost charged |
| `llm.transforms.invoke` | each `through` plugin per entity, and a plugin's plain call ("Plugin calls" below); `{segmentId, plugin, config, extractedContext, budget}`, the plugin by its registered name | `host.llm.transforms.invoke`, on the eval wire both ways; its cost charged |
| `files.resolveFileText` | each source file an extraction's `from […]` names, once per file | `host.files.resolveFileText`, on the eval wire both ways; its cost charged |
| `ids.mint` | an extraction's resources without ids, once per batch: the `from` text, each source file, the bundle pipeline's files, then every record's fetched files in the tree's order | `host.ids.mint`: `count` distinct texts, or the run fails |
| `log.write` | the log lines the TypeScript engine writes (an extraction's skipped stage, a plugin's empty argument, a continued answer, a truncated file, a refinement kept), kept and sent as the statement's trace is handed over, so a line costs no yield inside a fan | the platform's logger, the run's id added; never the run's failure |

An origin id is an index in the run's own table (below): no host or result
sees one. Every id a host or a result sees comes from `ids.mint`.

**A lost run lease** is the run host's (docs/contracts/host-families.md "Failure"): the
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

A head over what an extraction yielded (`deals-[c:company]-> { … }`) lands
on the extract's own entities under that edge, in hand: no host is asked,
the `block` entry is traced as for any head, and the alias reads each
entity's fields.

What stays the TypeScript engine's (refused, "Admission" above): returning a
record from a bound block, heads of more than one hop, heads off a value, a node, an expression or
`_resources`, a WHERE, ORDER BY or LIMIT on a head over an extraction, a park in a body.

### Expressions that walk, fold, test and name records

The tail of `evalMovementExpr` this engine runs (chunk 6A Task 4), each as
expression.ts and run.ts run it:

- **A walk read in an expression** (`traverseFrom` → `readAdapterTraverse`,
  `walkAdapterPositions`): hops off the event, an instance, a handle (its
  record), a hop alias or a pick, each hop's pushdown closed over the scope
  once (`closedHopPushdown`), then one `getRelated` per origin record —
  never a page stream, even for an instance that streams, as the
  TypeScript's expression walk asks — each origin's records gated, filtered,
  ordered and bounded on their own. Read for a field it is each landing's
  `getFieldValue`, `collapse`d (nothing is null, one its value and trail,
  several a list of them, the trails unioned), and bound it is many-valued
  (`bindsManyValues`). Off what an extraction yielded, the hops walk its
  entities in hand (`walkExtractSteps`; a WHERE there is refused). A hop's
  alias names its record in its WHERE and its ORDER BY key, and a key may be
  a walk of its own (`ORDER BY c-[:owner]->.\`joined\``).
- **`EXISTS`** (`evaluateExists`): the hops walked from every subject, each
  origin's `getRelated` with its own pushdown (`stepExistsCursor` closes it
  over the scope per cursor), then, with a WHERE, each reached record tested
  in turn, scoped at it (`evalScopedFilter`: a pure one a conjunct at a
  time) until one holds it. Over a value it asks whether the value holds one
  (`EXISTS(x)`: not null, not an empty list); over an extraction its
  entities, the WHERE reading their fields. The TypeScript fetches every hop
  of every subject before the WHERE is read; so does this engine. A hop or a
  target WHERE may hold one (`crm-[c:companies WHERE EXISTS(c-[:deals]->)]->`).
- **Folds** (`case 'aggregate'`, `applyAggregation`): `FIRST`, `LAST`,
  `ONLY` (more than one present fails, its expression spelled back — a name,
  the one form admitted), `COUNT` (what is present), `SUM`/`AVG`
  (`Number(v) || 0`), `MIN`/`MAX` (`Math.min`/`Math.max`: NaN if any is),
  `JOIN` (`String(v)`, nothing left out, `", "` by default), `COLLECT` and
  `SORT` (`sortByOrderKey`, keyless over plain values, by a field name over
  maps; past 64 members of mixed key kinds it fails, as a hop's ORDER BY
  does), over a value, a walk read for a field, or (`COUNT` only) the
  records a walk lands on, counted.
- **A pick** (`x = FIRST|LAST|ONLY(<one hop>)`, `selectedPositionBinding`):
  walked as a block head walks (a stream page by page), the record picked
  bound as a landing (its graph kept, its edge's properties not), or null
  when there is none; `ONLY` over two fails with the TypeScript's message.
- **A record named twice** (`x = co`, `aliasedNodeBinding`): the event, a
  handle, a landing, a node, an extraction's record or a bound block's
  records, bound again under the new name, the very binding. `x == null` of
  any name bound to anything but a value is false (`presenceCompare`).
- **`IS`** (`evaluateIsTest`, crate::is_test): decided from what the run
  holds, never a host call. The event: the graph its source instance is,
  and its seeded record type, or, for an address (`<crm-[:\`Webhook Event\`
  WHERE \`action\` == "record.created"]->>`, `eventAddressOfHops`), every pin
  agreeing with the seed's canonical address; an axis the seed does not pin,
  an undiscriminated event or a landing its system returned unstamped fail
  the run with the TypeScript's "can't tell what kind of record" message. A
  handle: its graph and type. A landing: the graph it was walked in and its
  stamp. A node declaration (`d IS <Note>`): structurally, as
  `surfaceMisfit` compares a synthesised subject — a node the run built or
  an extracted entity — every declared field present (its declaration's
  `extends` folded in), each declared node compared at the subject's first
  landing under it. A record whose structure is its system's types is
  refused (`is_test_declared_record`).
- **`ERROR(message)`**: the message evaluated and the run failed with
  MOVENG_ERROR, its text `String(value ?? '')`.
- **`@current_date`, `@current_timestamp`**: the run's pinned instant
  (`pinnedNow`), its ISO text or its date, a `{kind: 'meta', key}` origin;
  the acting user's and the actor's keys are looked up, and stay refused
  (`meta:<key>`).

### Extraction

`extract/run.rs` is extraction.ts's `Materializer` with run.ts's
`runExtraction` around it, for `x = extract from […] { tree }` (no tier):

1. the spec built for this firing (crate::extract::spec): its words
   evaluated where they were written — the extraction's in the body, a
   declaration's in the file — each stage's fields' words together and
   then its children's, as `settledAll` starts them, so a description that
   asks the host asks it where the TypeScript does;
2. the `from […]` slots evaluated, their origins the data sources; each
   datum a prompt segment and a TEXT resource, a source file
   (`files.resolveFileText`, once per file) a FILE resource and, when it
   yields text, a segment of its own, bounded for the prompt at the
   input's `extractionFileChars`; the resources without ids stamped in one
   `ids.mint`;
3. the `from […] through […]` pipeline, its plugins side by side, their
   text and data segments of the bundle;
4. one model call per through-free region (the root, then per entity each
   later stage behind its `through` fence and each fenced child): the
   cancel gate, `clock.now`, `llm.client.call`, `clock.now`; the reply read
   as zod reads it (crate::extract::validate) and, when it does not read,
   asked once more with the issues named; a per-entity call never answered
   keeps its entity, the root's fails the run with the TypeScript's
   message; each record projected (blank is absent), the empty ones
   counted and dropped;
5. per entity: a stage whose pipeline brought nothing is skipped (traced,
   no call); its children go side by side;
6. every record's fetched files given ids in one `ids.mint`, in the tree's
   order; the tree exported (an unfound text `""` from version 2) and bound
   (`extractRoot`); the entities hung off the extract's last call on the
   trace (`recordExtractedEntities`).

What runs side by side runs as `mapConcurrent` runs it, at most
`STAGE_FAN_OUT` (4) at a time: a pipeline's plugins, a node's fenced
children, an entity's children. Each branch writes the trace into a slice
of its own, spliced back in the order written. A call site is numbered
(`x:<node>#<n>`) when its region is planned, as the TypeScript numbers it:
in the order the walk reaches the regions, which is the tree's order
wherever the host answers in the order asked (every frozen case and every
recording; "Spec the tail" below).

A field of an extracted entity reads as `readEmissionField` reads it: its
value (null when absent), cited by the field's origin (`{kind:
'extraction', site, field, description, quote?}`, the site its call's
`ExtractSiteRef` with the call's data sources). A write whose field reads
one cites it as `evidence` (`{quote, type: 'extraction'}`, an
untransformed value with a quote) and carries the source content of every
extracted record its fields name (`resources`, once each by id); the
result's `extractionSites` lists each site the writes cite, once.

### Plugin calls

`plugin.rs` is run.ts `executePluginCall`, for `x = p(…)`, `x = p()` and
`p(…)` as a statement, of a plugin the program imports: its named
arguments evaluated in the order written, `clock.now` either side of
`llm.transforms.invoke` (the plugin by its registered name, the
movement's pin choosing its declared output), the `plugin` entry traced
(`returned: value | absent`), and the name bound as that output — a
`value` output its text, a `record` output a node of the fields it
attached and its text under `text`. A priced plugin is refused before the
host is asked once the run has spent its cap (`Ledger::plugin_refusal`,
by the registered name, so an aliased import is priced too); a `through`
stage's plugin is refused the same way.

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
`nodeRef` numbered as one park's table numbers them, and a picked record as
`sourcePosition`: its position, and `read: {instanceName}` unless it was read
off the event's source). States cross on the eval wire both ways
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
a statement's boundary; its journal is empty: a statement this engine runs
makes at most one call (a plugin's), and a suspension at its cap is taken
before that call answers. The flow suspends:

- **at its cost cap.** The engine refuses a priced plugin itself, before
  `llm.transforms.invoke`, once the run's own figures meet the cap (as
  run_context.ts `pricedCalls` does); no other priced call. The
  host refuses one once its budget is spent (the meter refuses when the run
  has spent at or past its cap), and that refusal, once its cost is charged,
  is the cap met if the ledger's own figures say so (`spent >= cap`, counted
  from `capBaselineMicrodollars`); otherwise the statement fails with the
  host's message. So the call that crosses the cap is kept, and the run
  pauses at the next priced call, just before its statement, as run.ts
  `suspendAtLimit` does. The first time, the run is marked paused
  (`commitLimitPause`, where the host serves it) and says so on its trace
  (`RUN_PAUSED_COST_CAP`); a sink that cannot suspend is not paused, and the
  run fails with `RunCostCapExceeded`.
- **before each statement of a paused run** (`limitPaused` in the input: a
  flow woken while its run's pause holds). A sink that cannot suspend lets
  the flow run on.
- **at a `suspendAt` address**, once each. A sink that cannot suspend fails
  the run (`MOVENG_RUNTIME`). An address before a call (`… .c k`) is
  refused at admission (`suspend_at_call`).

Whether the sink can suspend, or park a timer, is read off the input's
`serves` (the methods the host serves, as the recorder lists them), as
run.ts `canSuspend` reads the host object: a host that cannot is asked
nothing, so its run makes the TypeScript engine's requests and no other.
A `sleep` asks `clock.now` once its state is written and before its
duration is read, and wakes at the answer plus the sleep.

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
  `Date`, a class instance, a function): `RustShimError` from the shim.
  The likely case — an event field the source's schema types as a date or a
  datetime (read by an expression, or written by a `...msg` spread as the
  checker's stamp names its fields) — is declined before the version warning
  is traced and before the source is resolved, read off the catalog
  snapshot (a `describe` would be an adapter call, after which nothing may
  decline).
- A plugin's answer, or a file reader's, holding a `__proto__` key or a
  lone surrogate (the shim carries the rest and names what it left out,
  `uncarried`): the statement fails with MOVENG_UNSUPPORTED naming the
  members. The TypeScript reads on. (A model reply that does is a
  validation failure instead: "Spec the tail" below.)
- A value held in a binding is shaped like an engine binding (an object
  whose `kind` names one, the TypeScript's `bindingOf`): reading its field,
  comparing it by `==`, or spreading it fails with MOVENG_UNSUPPORTED ("this
  reading (…) is not supported…"). TypeScript reads such a dict as a record.
- A field read off a held object names one of `Object.prototype`'s members
  it does not own (`meta.\`constructor\``): MOVENG_UNSUPPORTED. TypeScript's
  `value[field] ?? null` finds the prototype's member.
- A record compared by identity (`a == b` where either is binding-shaped):
  MOVENG_UNSUPPORTED. TypeScript compares two records by identity.
- A hop's ORDER BY over more than 64 records whose keys mix numbers with
  other kinds, or a `SORT` over more than 64 such members:
  MOVENG_UNSUPPORTED ("Spec the tail" below). TypeScript orders them by
  V8's merge.
- `x IS <Decl>` of a node whose landing under a declared edge is a system's
  record (a handle, a landed record): MOVENG_UNSUPPORTED, as that landing's
  structure is its system's types. Admission lets no such node reach an
  `IS` (a `node { … }` literal nests nodes only; a `graph { … }` literal is
  refused, `is_test_declared_graph`).

None of the first five is a built-in's reading, so none can be handed to the
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
resume?, limitPaused?, suspendAt?, serves, extractionFileChars?}`. `segmentId` is the segment the run host opened (`segment.open`),
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
`CatalogSnapshot`; `serves` lists every host method the run's host serves,
by path (`park.sink.commitTimerPark`): the engine asks an optional one only
when it is listed; `extractionFileChars` is how much of one source file's
text an extraction prompt takes (extraction.ts `maxFileChars`, the
deployment's `EXTRACTION_FILE_CHARS`, 50,000 when absent). Other members
are ignored.

**Requests and answers.** An answer is `{value}`, `{}` for `undefined`, or
`{error: {message, name?, ref?}}`; `ref` numbers the very error object the
host keeps, so a run that fails with it can name it.

Every request but `check`'s, `builtins`' and `log.write`'s carries `segmentId`, and is the
`EngineHost` method's request of the same path, in docs/contracts/host-families.md's
shape. Where `wire: true`, the values named cross on the eval wire.

| request (family.method, args) | answer |
|---|---|
| `check.program {source, languageVersion, upgradingFrom?}` | `{diagnostics, link?, stamps, versionWarning?}` (below; `versionWarning: {code, message}` is the deprecated pin's warning the run traces, as the host's engine reads its release, not the checker's diagnostic); a program that fails its check gets no answer: the host ends the run with the check's error |
| `adapters.resolve {segmentId, adapterType, credentialsId?, constructionArgs?, role: "source" \| "target", dryRun?: true}` | the instance as data: `{instance, adapterType, methods, capabilities, …}` |
| `adapters.call {segmentId, instance, method, args, wire: true, positionRef?, position?}` | `{result}` (on the eval wire) or `{error: {kind: "call_ceiling" \| "adapter_error", message, name?, detail?, ref}}`; `ref` numbers the very error the engine's TypeScript twin raises for it. With `positionRef` the call's argument object is `{position, ...args}`: the position by handle (below) |
| `llm.arbitrateEntities {segmentId, asserted, candidates, recordType, constraints, languageVersion, budget}` (the first four on the eval wire) | `{index: number \| null, judgeUnavailable?, cost?}`, or a budget refusal `{error: {kind: "budget", message}, cost?}` |
| `locks.acquire {segmentId, names}` / `locks.release {segmentId, token}` | `{token}` once held / `undefined` once let go |
| `park.sink.commitTimerPark {segmentId, address, state, wakeAt, wire: true}` (`state` on the eval wire) | `undefined`; asked only of a host that serves it |
| `park.sink.commitSuspension {segmentId, address, state, wire: true}` (`state` on the eval wire) | `undefined`; asked only of a host that serves it |
| `park.sink.commitLimitPause {segmentId, limit: "cost", capMicrodollars, spentMicrodollars}` | `undefined`; asked only of a host that serves it and `commitSuspension` |
| `clock.now {segmentId}` | `{nowIso}`, an ISO 8601 instant; any other answer fails the run |
| `control.cancel.cancelled {segmentId}` / `control.cancel.cancelledNow {segmentId}` | a boolean: the cancel gate, debounced / not |
| `trace.append {segmentId, entries, closing?: true, wire: true}` (`entries` on the eval wire, each in expression.ts's key order; one per statement that traced; the last, as the segment ends, is marked `closing` and may fail without failing the run, the shim logging it) | `undefined`; an entry is `{kind: "warning", code, message}`, `{kind: "gate", outcome}`, `{kind: "field_miss", binding, field, available: [key…]}`, `{kind: "block", root, positions}`, an `extraction` entry or a `plugin` entry as expression.ts's `MovementTraceEntry` writes them |
| `llm.client.call {segmentId, system, userMessage, label, model, effort?, maxTokens?, budget, wire: true}` | on the eval wire: `{parsedJson, rawText?, effortSteppedDown?, continuations?, cost?}`, or a budget refusal `{error: {kind: "budget", message}, cost?}` |
| `llm.transforms.invoke {segmentId, plugin, config, extractedContext, budget, wire: true}` (`config` and `extractedContext` on the eval wire) | on the eval wire: `{text?, data?, records?, outcome?, cost?}`, or a budget refusal |
| `files.resolveFileText {segmentId, file, budget, wire: true}` (`file` on the eval wire) | on the eval wire: `{text, rawTextId?}` or `{unreadable, detail?}`, and `cost?`, or a budget refusal |
| `ids.mint {segmentId, count}` | `count` distinct texts |
| `log.write {lines: [{level, message, fields}]}` | `undefined`: the lines on the platform's log, the run's id added (the engine's own, like `check` and `builtins`) |
| `builtins.function {id, args, now, languageVersion}` | `{value}` or `{threw: {class: "MovementEngineError" \| "Error" \| "RangeError", code?, message}}`: the TypeScript member's value or what it throws; `id` is the lowered function id (`date.format_iso`, `trim`), `args` on the eval wire, the value too |
| `builtins.compare {op, left, right, now?}` | the same two shapes, for `compareValues(left, op, right, {now})`; `op` a `FilterOperator`; `now` (the `clock.now` answer the engine asked) on a `within` and only there |

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

- `{result: {movementName, writes, extractionSites?, parked?: true, parkedAddress?, cancelled?: true}}`,
  `writes` the firing records on the eval wire, `extractionSites` (when the
  writes cite any) each cited extraction site's summary by site id;
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
- **One reading fails loudly: a hop's ORDER BY over keys that mix numbers
  with other kinds, past 64 records.** The sort is V8's (crate::order_limit):
  binary insertion up to 64 items, which reproduces V8 exactly for any
  comparator; past 64 V8 merges its runs, which this engine reproduces for
  every total order. Mixed number and text keys are not one (the comparator
  has cycles), so there V8's merge alone decides where records land. Rather
  than order them differently, the run fails with MOVENG_UNSUPPORTED naming
  the ORDER BY and the record count. Ruled: no silent divergence (the
  order_limit pin holds every set of 64 or fewer, mixed included).
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
  - a hop's ORDER BY, and a `SORT`, over keys of mixed types: one total
    order over every key kind (say: nulls, then numbers, then text), so no
    sort algorithm's merge decides where a record lands.
  - a reply field named after an `Object.prototype` member
    (`constructor`, `toString`, `hasOwnProperty`, `__proto__`, …): zod
    reads a declared key through the record's prototype, so a reply that
    leaves such a field out hands zod a function, which fails the call
    (`expected object, received function`), and a `__proto__` the reply
    writes becomes the record's prototype instead of its key.
    crate::extract::validate reads each as any other field. The oracle marks
    those replies (`divergence: "prototype_key"`) and holds this engine to
    TypeScript's verdict with exactly that taken out: the function issues
    dropped (the retry and the failure's detail worked out from what is
    left), the `__proto__` record kept as a key, and a reply with nothing
    left read clean.
    zod also never validates a field a declaration DECLARES as `__proto__`:
    building the entity's object schema assigns `shape.__proto__`, which
    sets the schema's prototype instead of a key, so whatever the reply
    writes there passes unchecked, and the field is missing from the keys
    the "answered under keys none of which it declares" check counts as
    declared (and from that check's message). crate::extract::validate
    validates it, and counts it, as an ordinary field. The oracle holds this
    engine only to replies whose `__proto__` value is valid; the difference
    is in what an invalid one, or one answered under `__proto__` alone,
    does.
  - a reply number above the double range (past ±1.8e308): `JSON.parse`
    reads it as `Infinity`, which zod's number check refuses (`expected
    number, received number`). The reply crosses to this engine on the eval
    wire, which carries `Infinity` as itself, and this engine refuses it as
    zod does (pinned by `validate::tests::
    a_number_past_the_double_range_is_refused_as_zod_refuses_it` and by
    apps/api's `rust_extract.unit.test.ts` on both engines). Over a JSON
    host (the HTTP double, a remote embedder) the number is already
    `null`, which reads clean on both engines. The oracle cannot express it
    (its replies are JSON text), so it is not marked there.
  - a model reply holding a `__proto__` key or a lone surrogate (both
    `JSON.parse` can make): the eval wire cannot carry either, so the shim
    hands this engine the answer without its `parsedJson` (`uncarried`),
    its cost and the rest kept. This engine reads that as one issue at the
    reply's root ("the reply held a key or a text this engine cannot
    read"): it asks once more with the issue named, as for any reply the
    guide does not describe; a second such reply fails the root's call with
    the twice-unanswered MOVENG_RUNTIME text, and a per-entity call keeps
    its entity (`kept_previous_stage`). The TypeScript reads on: a lone
    surrogate is a string zod accepts, and a `__proto__` key is the
    prototype accident above. Pinned on both engines by
    `rust_extract.unit.test.ts`.
  - extraction call-site numbering: the number in an extraction's prompt
    (`x:<node>#<n>`) follows the order concurrent siblings reach the site,
    so a host answering at another speed sees another prompt; numbered by
    the site's place in the fan instead (the recorded runs allow-list the
    cases that depend on it until then). This engine numbers a site when
    its region is planned, as the TypeScript does: what it runs side by
    side it runs at once, so the order it reaches the sites is the order
    the host answers, which is the tree's order wherever the host answers
    in the order asked — every frozen case and every recording (chunk 6A
    Task 3a's measurement). A numbering by the tree alone would hold back
    a later sibling's call until every earlier sibling had numbered its
    calls, which is a sequential fan: it would change the order the host is
    asked in, which the recorded runs hold.
  - a cut at a UTF-16 surrogate pair (a text cut at 80, 200 or 1,000 UTF-16
    units, or a file bounded for the prompt, landing mid-pair): a Rust
    string cannot hold a lone surrogate, so this engine never splits the
    pair and drops it whole; JavaScript's `slice` keeps the high half.
    Specified as: a cut never splits a pair.
  - a fractional `EXTRACTION_FILE_CHARS`: the shim floors it before this
    engine sees it, so the truncation marker prints the whole number
    ("first 2 of …"); the TypeScript's marker prints the fraction ("first
    2.5 of …"). Specified as: the bound is a whole number of characters.

### Known divergences

Where this engine differs from the TypeScript engine on a program that
checks and that admission lets through. Each is pinned or unreachable as
said; the deferred language-version changes above are the others.

None is known beyond those.

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
engine asks of `EnvServices` (src/env_services.rs), four operations. No
clock: every instant the engine needs comes from the run's pin or the host's
`clock.now`.

| operation | answers | JavaScript |
|---|---|---|
| `tz_convert {instantIso, zone}` | `{year, month, day, hour, minute, second, millisecond, offsetMinutes, weekday}` or null (not a zone) | `Intl.DateTimeFormat('en-US', {timeZone, hourCycle: 'h23', …}).formatToParts` |
| `url_parse {text}` | `{href, protocol, username, password, host, hostname, port, pathname, search, hash}` or null | `new URL(text)` |
| `number_format {value, locale, options}` | text, or null | `Intl.NumberFormat` (decimal; `minimumFractionDigits`, `maximumFractionDigits`, `useGrouping`) |
| `normalize {text, form}` | text | `String.prototype.normalize` |

Two implementations:

- **WASM** (`HostImports`): the import `movement_env.call`, a request's
  JSON in and `{value}` out, which the loader gives every instance from
  packages/movement-lang/wasm/env_services.ts. Synchronous, so the evaluator
  calls it mid-expression. The TypeScript engine and the Rust one read zones,
  URLs and text from the one runtime.
- **Native** (`native::Native`, the default `native-env` feature, inert on
  wasm32): `jiff` with its bundled zone data, the `url` crate, ICU4X's
  normaliser and decimal formatter.

tests/env_services.rs holds the native one to tests/env/fixture.json:
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
shim fault, or a whole-corpus run under its routing floor (v1 287, v2 350). Any filter (a path or name pattern, related or
changed files, a shard, positional paths) makes a run partial, and the floor
does not apply to it.
