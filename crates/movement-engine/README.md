# movement-engine

The movement engine in Rust. A segment of a run executes inside one WASM
instance and asks for everything outside the program in the host contract's
own shapes (docs/contracts/host-families.md); `apps/api/src/services/movement_engine/
rust_engine.ts` drives it, and `rust_host.ts` forwards each request to the
run's `EngineHost`.

Which runs reach it is `MOVEMENT_ENGINE`'s (`engineRoute` in rust_engine.ts).
Under `by-version`, production's default, a run pinned to language version 5
or later runs here and one pinned to 1–4 on the TypeScript engine; a version-5
run this engine refuses or declines fails with the reason (no fallback), the
emergency switch `MOVEMENT_ENGINE_V5_ON_TS=true` sends version-5 runs to the
TypeScript engine instead, and a resume goes back to the engine that parked
it (the run row's `engine`, handed in as `parkedOnEngine`) whatever the switch
says. `rust` and `ts` force one engine for every version: the test harness's
setting (jest defaults to `ts`), so the corpora, recordings and oracles can
hold this engine to the TypeScript engine on any version.

Under `MOVEMENT_ENGINE=rust` the engine runs two things (under `by-version`,
the whole run only):

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
| `host` | one request builder per host call, each family spelled as host.ts's `HOST_FAMILIES` spells it (`adapters`, `llm`, `llm.client`, `llm.transforms`, `park`, `park.sink`, `park.callbacks`, `control.cancel`, `locks`, `trace`, `clock`, `files`, `ids`), plus the engine's own (`check`, `builtins`, `log`); every host request names the segment |
| `ledger` | the run's spend account for one segment: the budget a priced call is sent, the cost each answers charged, the cap met (`exceeded`) once a budget refusal is charged, a priced plugin refused before the host is asked once the cap is spent (`plugin_refusal`), the charges handed back with `done` |
| `admit` | admission: the allow-list walk over this engine's own parse of the file and the movements the entry reaches, before the check; every stable reason a refusal holds (below) |
| `abi` | the C ABI: `engine_start`, `engine_answer`, `engine_finish`, `eval_expression` |
| `eval` | `evalMovementExpr` over the host-free kinds, with its provenance rules and errors; the folds; what a walk, an `EXISTS` over a record, or a count needs asked of the run |
| `stdlib` | the 17 flat built-ins and all 15 namespaced members |
| `run` | the `segment` entry: `runMovement` / `resumeMovement` for the programs the shim admits (below) |
| `call` | calls of the movements a program declares: the call's step, the callee's scope, its arguments bound, its value, the depth |
| `write` | the `write` statement: targets (a WHERE on one included), fields, identity, update or create, the firing record |
| `verbs` | `match`, `link`, `unlink`, `delete`: the identity half of a write on its own, edges between two handles, a record removed |
| `traverse` | traversal blocks over adapter edges: the head's graph, the hop's fetch, the member gate, the WHERE per landed record, ORDER BY / LIMIT, the body per landing; the walks an expression reads, `EXISTS` and a pick |
| `is_test` | a condition's `IS <type>`: the event, a handle, a landing, a node declaration's structure |
| `order_limit` | packages/shared/expression/order_limit.ts: a hop's pushdown (closed over its scope) and its ORDER BY / LIMIT over what came back, sorted as V8 sorts |
| `address` | address.ts's lexical addresses: `s`, `b`, fan-out `i` and call `c` steps |
| `unique` | `unique by`: the clauses split into keys and narrowings, the search record, the rules that decide without a judge, the identity lock |
| `node` | node and graph literals: value entries, nested nodes, declared edges with their landing shapes, traversal entries, reference entries and record copies (the checker's stamps) |
| `local` | the engine as a run-built node's adapter (local_edge_adapter.ts): the store over an edge's landings, its candidate block, the writes, matches, position writes and links into it |
| `letter_number` | `/[\p{L}\p{N}]/u`'s code points, as Node reads them (generated) |
| `park` | `ParkedScopeState` v1 written as serialize.ts writes it (one `ParkWriter` across scopes, frames and journal), the suspension points, and the resume admission |
| `resume` | `resumeAlongAddress`: a state's spine descended (`if` arms, iterations, branches, call and member frames), the leaf bound or re-entered, each enclosing body finished, joins closed and races settled through the host; `settleRaceFrame` and `fireCallbackBody`; every descriptor kind rehydrated |
| `code` | what a program's bodies write at any depth (the closures they bind to a name, their node declarations); parked code is never looked for here, but rebuilt from its tree (`resume`) |
| `flow` | a flow's own state (its trace buffer, ledger slot, call sites, lock holds), swapped in on each poll; shared futures several flows await (an adapter's resolution) |
| `combinator` | `parallel` and `race`: arms as flows joined on the executor, the write ledger spliced in arm order, a race's winner and its losers cancelled, arms that park joined through their frame |
| `awaits` | `await` of a landing, an `until`, a callback (`park.callbacks.mint`, its `called` edge), and the park each writes |
| `bindings` | what a name in a run is bound to, the lexical scopes (in declaration order), the source `Position` |
| `trace` | the `MovementTraceEntry` kinds a run appends (`warning`, `gate`, `field_miss`, `block`, `extraction`, `plugin`, `ai`, `read`, `chunks`), and the per-flow buffer they wait in until their statement ends |
| `program` | the pinned source parsed, joined with the `check.program` host call's answer: diagnostics, the import link, the checker's stamps by AST path; the declarations (`Declarations`: the root's and each library's shapes and `type`s, each shape with the file that wrote it, and the plugin imports, by local name) |
| `extract` | the extraction keyword (`x = extract from […] { tree }`): the spec resolved per firing and the calls planned over it (`spec`), each call's system, user and retry messages (`prompt`), a reply read as zod reads it (`validate`), the content read and fetched as resources (`resources`), what it yields (`emission`), and the walk — the model loop, `through` stages, fences, the trace (`run`) |
| `plugin` | a plugin called plainly (`page = fetch_url(url: …)`): its arguments, the invocation timed and priced, what it binds by its declared output |
| `env_services` | `EnvServices`: zones, WHATWG URLs, locale numbers and Unicode normalisation, from the JavaScript runtime (WASM) or natively (below); never a clock |
| `filter` | packages/shared/expression/filter.ts: `compareValues`, `compareToNull`, `evaluatePredicate` |
| `env` | value bindings in scopes with a parent chain; the wire values and trails cross on, and a segment's one wire with its host |
| `file` | a file the engine holds (`Js::File`, never a `Js::Object` with a key): an opaque handle onto a file the HOST keeps — the segment's id for it, its identity `handle`, and its opaque view (`name`, `contentType`, `size`, `handle`: what a read or a print of it gives, on both engines; any other member reads as absent). The host makes every file, where an envelope declares one: a field the catalog types `file` (the engine names the declared type on the read, `filesAt`, and the shim applies `filesAtType`), a plugin output's declared file, `files.render`'s answer, a parked `file` (the shim's `filesInParkState`). The descriptor — source, credential, construction args, store, URL — never reaches the engine. The handle is an OPAQUE identity string: the engine compares and carries it (a FILE resource's `externalId`, a `file` origin's `handle`, the dedupe key) and never parses it. `fileFields` for a park (PLAN-07A Task 4d) |
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
| admission walks what the entry reaches, every reason named (PLAN-07A Task 1) | 2,461,388 | 712,055 |
| calls to helper movements, run-built graphs, lazy walks (PLAN-07A Task 2) | 2,585,141 | 758,389 |
| records held as values, mirrored (PLAN-07A Task 3, its fix rounds) | 2,972,633 | 872,415 |
| awaits, parallel and race, every park state resumed (PLAN-07A Task 4) | 3,214,223 | 953,565 |
| case mapping, prototype keys, regex completion, TimSort (PLAN-07A Task 5) | 3,253,385 | 966,528 |
| the forward merge of cloud-native (main merge 2's refusals in) | 3,254,071 | 966,867 |
| host data never read as an engine object (PLAN-07A Task 4b) | 3,031,573 | 908,024 |
| language version 4's changed constructs run (PLAN-07A Task 4c) | 3,044,472 | 912,975 |
| a file is what the envelope declares (`Js::File`, PLAN-07A Task 4d; the forward merges between) | 3,276,404 | 981,675 |
| the engine holds no team (PLAN-07A Task 4d fix round 1) | 3,275,777 | 981,473 |
| a file is an opaque handle the host resolves (PLAN-07A Task 4d fix round 2) | 3,271,057 | 980,116 |
| a file prints as its opaque view (PLAN-07A Task 4d fix round 3) | 3,271,054 | 980,111 |
| admission reads the checker's types for parameters, calls and spreads (PLAN-07A Task 6b) | 3,285,051 | 984,745 |
| a record handed to a position parameter checked at every call (PLAN-07A Task 6b fix round 1) | 3,288,623 | 985,934 |
| parked code rebuilt from its tree: the AST's `Deserialize` (PLAN-08A batch review fix 1; 1,004,729 before it) | 4,002,853 | 1,108,094 |
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
- **One wire per segment** (`env::Wire`, rust_engine.ts's segment `WireOut`).
  The event and every value answer on the eval wire (an adapter's result, a
  priced call's, a built-in's) go out on the shim's one wire for the
  segment, each object and list under an id unique in the segment. Each
  value is written whole: a back-reference (`["r", id]`) names only an
  object earlier in the same value, so the engine decodes answers in
  whatever order it reads them, and an object the host sends again (mutated
  or not) crosses again, under a fresh id, as it now is. A request hands an
  object the host sent back as itself (`["i", id]`), when it is that very
  object, unchanged: the shim gives the host the original, whichever of its
  ids the engine names. So a value an adapter answered (a dict read off a
  landing, carried in a node into a callee's write) reaches the next host
  call as the object it was, as in the TypeScript engine; anything the
  engine built is written out. A file crosses as an opaque handle: the
  host sends `["F", id, { handle, name, contentType, size }]` and the
  engine hands it back as `["F", id]`, the segment's file table keeping the
  descriptor. The tag, never a descriptor's keys, makes a file.

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
  languageVersion?, now?, localZone?}`; `localZone` is the zone a date-time
  text with no offset is read in (the shim's process zone; absent, UTC).
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
`NaN`, `±Infinity`, `-0`, a text holding a lone surrogate (`["s16",
units]`, its UTF-16 code units, a key's too), key order, and identity. Identity matters because
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
| a string | any run of UTF-16 code units, a lone surrogate included (crate::js_string): held in-band in the engine's UTF-8 text (U+FDD0, then a plane-16 private-use character naming the unit; a U+FDD0 the text holds written twice), in a canonical form, so equality is `===` and two halves written side by side are the pair; it crosses the eval wire as `["s16", units]` and the host's JSON text as the `\udXXX` escape `JSON.stringify` writes | `js_string::tests::*`, tests/stdlib_oracle.rs `strings_hold_what_javascript_holds` (strings.json, 10,572 seeded cases, seed 20261016) |
| `.length`, `<` on text | UTF-16 code units; comparison in code-unit order | `js::tests::strings_are_utf16_where_javascript_says_so`, `stdlib::tests::flat_builtins` |
| `split("")`, `slice`, a regex's `.` | per UTF-16 unit: an astral character parts into its two halves, and a cut through a pair keeps the half on its side (every cut: 80, 200, 300 and 1,000 units, and a file bounded for the prompt) | `oracle::…` (`flat.split`, `text.regex_extract`), strings.json (`slice`, `bound`) |
| `toLowerCase`/`toUpperCase` | Node 22.20's ICU (77.1, Unicode 16), not Rust's tables (which follow the toolchain's Unicode, 17 today): each code point's mapping and the final sigma's neighbours read off Node into src/case_mapping.rs by tests/oracle/case_mapping.ts; every case mapping the engine does goes through `js::to_lower_case` / `js::to_upper_case` (`LOWER`, `UPPER`, case-insensitive name lookup, enum matching, slugs) | tests/tail_oracle.rs (case_mapping.json), `stdlib::tests::case_mapping_follows_nodes_icu` |
| `new Date(text)`, `Date.parse` | V8's parser written out step for step (dateparser-inl.h, dateparser.cc, builtins-date.cc `ParseDateTimeString`): the ES5 form first (`[±yy]yyyy[-MM[-DD]][THH:mm[:ss[.f…]]][Z\|±hh:mm\|±hhmm]`, `t` and `z` in either case), then the legacy parser over what is left — numbers, words matched on their first three letters (months, `AM`/`PM`, `UT`/`UTC`/`GMT`/`Z`, the eight US zones, `T`), parenthesised comments, the numeric orders and the 50 pivot for two-digit years (two numbers are a month and a day of 2001), offsets `±hh[mm]`, `±hh:mm`, `GMT±h`. A date alone is UTC; a date-time with no offset is read in the run's local zone (`localZone`; absent, UTC), a reading the clock shows twice being the earlier instant and one it skips read with the offset before the change, as ICU's `getOffsetFromLocal(FORMER, FORMER)` reads it for V8 | `js_date::tests::reads_the_iso_forms_as_v8_does`, `js_date::tests::reads_the_legacy_forms_as_v8_does`, tests/dates_oracle.rs (6,000 seeded texts in five zones) |
| `Date.UTC` round trip | `validParts` refuses years 0–99 (Date.UTC reads them as 19xx), months outside 1–12, days past the month | `stdlib::tests::dates_parse_add_and_format` |
| `toISOString` | six-digit signed years outside 0000–9999; an instant past ±8.64e15 ms throws `RangeError: Invalid time value` (DATE.ADD_DAYS) | `js_date::tests::iso_strings_outside_four_digit_years`, `js_date::tests::time_clip_bounds_and_truncates`, `tests::coalesce_short_circuits_from_version_three` |
| regexes (TEXT.REGEX_EXTRACT) | V8's whole flagless dialect, compiled to a flat program run on an explicit backtracking stack over UTF-16 units: each iteration of a group clears its captures, an empty iteration ends a loop, `.` stops at line terminators; lookahead and lookbehind (right to left, its captures and backreferences too), named groups and `\k<name>`, Annex B's octal, `\c` and identity escapes, a class escape at a range's end, quantified lookaheads. No step budget (a pattern V8 runs slowly runs slowly here). Invalid patterns are null, as `new RegExp` throws. Groups nested past 1,000 levels go back to the TypeScript built-in, so the answer is TypeScript's: V8 overflows its stack on CAPTURING groups nested somewhere between 8,000 and 10,000 deep, at a depth set by the stack it runs on (`(?:` it parses 50,000 deep; handed back past 1,000 all the same) | `js_regex::tests::*`, `oracle::regexes_match_as_node_matches_them` (7,209 seeded cases) |
| `URL` (URL.HOST) | `new URL` itself, asked of the environment (`url_parse`); only the TypeScript's own pre-reading (trim, the assumed `http://`, opaque uris) is written here | `stdlib::tests::url_host_as_whatwg_reads_it`, `oracle::…` (`url.host`) |
| `normalize("NFKD")` (TEXT.SLUG) | asked of the environment (`normalize`) | `stdlib::tests::text_members`, `oracle::…` (`text.slug`) |
| `Intl.DateTimeFormat` (DATE.TODAY, DATETIME.AT) | the zone's wall reading asked of the environment (`tz_convert`); `instantAtZonedWallTime`'s search over those readings written out, `Date.UTC`'s 19xx years included | `stdlib::tests::datetime_at_names_the_instant_on_the_zones_wall_clock`, `oracle::…` (`date.today`, `datetime.at`) |
| `JSON.stringify` (TEXT.SERIALISE) | its quoting and two-space layout; keys sorted by UTF-16 unit, then laid out in object order (index keys first) as `Object.fromEntries` does | `js::tests::json_stringify_indents_as_javascript_does`, `stdlib::tests::text_members` |
| object-literal prototypes | `MAGNITUDE_SUFFIXES["constructor"]` is `Object`, so `"5 constructor"` is NaN; `MONTH_NAMES["constructor"]` fails `validParts` like no month | `stdlib::tests::figures_read_as_the_regex_reads_them` |
| a dict whose `kind` names a binding kind (or an `Object.prototype` name) | data, as every dict is: only an engine object (`Js::Record`) is a record, so the content of data never changes how it is treated (Henry's ruling, 2026-10-10; chunk 7A Task 4b) | `record::tests::a_dict_is_never_a_record_whatever_its_kind`, `tests::maps_keep_javascript_key_order`, apps/api's `rust_engine.unit.test.ts` ("host data is never read as an engine object") |

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
Node over 7,209 seeded pattern/text pairs (regex.json: 3,200 over the core
dialect, 4,000 over the rest of it, and nine long texts and deep nestings). Each function may
hand back to TypeScript no more than its recorded share. All three files are
written by tests/oracle/generate.ts, deterministically; CI regenerates and
diffs them.

The evaluator switch counts what it did (`rustEvalStats` in rust_engine.ts:
not admitted, admitted, answered, fallback by reason). Under
`MOVEMENT_ENGINE=rust` the conformance runs print the totals and fail when Rust
answered nothing.

## Admission

Whether this engine runs a program whole is decided in three places, in
this order, and this engine parses the program once, here. Before any of
them, the run's check: run.ts checks the program (`checkPinned`: its pin,
its parse, the checker) where the TypeScript route checks it, before the run
host opens the segment, so a program that fails it (MOVENG_LANGUAGE_VERSION,
MOVENG_PARSE, MOVENG_CHECK) ends there on either engine and its host sees no
request at all, `segment.open` included (`rustRunStats.endedAtCheck`; never
routed). That check answers this engine's own `check.program` request.

1. **The shim's input checks** (rust_engine.ts: an event, source or parked
   state that cannot cross the eval wire), on what the run is handed,
   before a segment opens.
2. **This engine's admission** (`admit.rs`, and `park::resume_refusal` for a
   resume), on its own parse (a plugin call's declared output is read off
   the input's catalog snapshot, its `plugins` alone), before
   the catalog loads, before `check.program`, before any request: a refused
   run costs one parse and one walk, and no host call
   (`rustRunStats.hostCalls` stays `{}`).
3. **The declines**, after the check and before anything the host can see
   (the version warning's trace entry included): a slot this engine's
   lowering misses and the checker passes. (The one stamp decline,
   `event_field_dated`, retired with PLAN-08A group F′.) A refusal of this
   engine's own met mid-run before the run's first effect declines too
   (`unreproduced`, below).

Either way the shim runs the program on the TypeScript engine.

### What admission walks

- **The file, whole.** Its imports, declarations and file-level values:
  `prepareMovement` binds every one, on either engine, whichever movement
  fires.
- **The movements the entry reaches** (`admit::reachable`). The entry is the
  movement the segment fires (`movementName`, picked by a copy of
  TypeScript's `selectMovement`, shared by Rust admission and execution:
  exactly, or from version 3 in any letter case; else the file's only
  movement). Then every movement a reached movement's text names,
  transitively, in source order.
- **Nothing else.** A movement no reached movement names cannot run, so
  what it holds refuses nothing.
- **Why that is sound.** Either engine enters a movement's body only by
  resolving a name the running body wrote: a call's callee (run.ts
  `runCall`), a combinator's named arm (`armBodyAt` → `movementDeclaration`),
  a movement handed where a closure goes (`closureOf`), and on resume the
  call frames those made. Name resolution is lexical (`resolveCallee`,
  `Environment.resolve`); there is no name built at run time. The walk reads
  every string the movement's AST holds, whole (a callee, an arm's name)
  and through the shared name scan (`scan_name`, so a slot's text and a
  backtick-quoted name count), in any letter case. String literals' words
  count too, so the set read is never smaller than what can run.
- **A library's movements and its file** (PLAN-08A group F). Every library
  the file imports from (the run's catalog snapshot carries its source) has
  its declarations and values walked whole, in its own scope; each library
  movement a walked body calls is walked in its own file under what the
  call passes (`Seed`), and one a body names without calling it, with its
  parameters as the event, as the file's own movements are; what such a
  call hands back is read off the callee's returns in its own file. A
  library's `type`s type its movements' parameters.
- **No entry picked** (none named and more than one movement, or a name the
  file lacks): every movement is walked. The run throws MOVENG_NOT_FOUND
  after the check on either engine anyway.
- **A call reaches its callee, which is walked** (`admit::walks`), once per
  signature: what each argument binds its parameter to at the call (a value
  for a value parameter — `<text>`, `<number[]>`, a declared `type` — else
  the record the argument names: the event, a handle, a node, a walked or
  extracted record, what a node's edge holds), worked out from the call
  site's own bindings, transitively. A call's value is the one kind the
  callee's returns share under that signature (`Callees::returns`); inside
  a recursion it is the value the movement declares it returns, when it
  declares a value (the checker holds every return to it); a value of more
  than one kind, or one a recursion leaves open, refuses the call
  (`movement_call`). A position parameter handed a value fails the call
  before the callee runs, on either engine, so that call adds no walk. The
  entry, and any movement no call reaches, takes its parameters as the
  event. So admitting calls admits no unwalked callee: every body a call can
  enter is walked under every binding a call gives its parameters, and a
  combinator's arm or a closure still refuses where it stands.

The walk does not stop at a statement's reason. Each statement is walked
whatever the one before it needed, an `if`'s arms past its condition, a
block's body past its head. Within one statement it does stop: the first
reason a statement meets ends that statement's walk (a call's later
arguments, a write's later fields are not read), so a statement contributes
one reason. A refused `done` carries each statement's first reason, in the
order met, each once (`{refused: <first>, reasons: [<first>, …]}`). The
input's and the parked state's reasons follow the program's. The first is
the one a walk that stopped there would give; `rustRunStats.notAdmitted`
counts each run under it, and `rustRunStats.allReasons` under each reason
the run's statements first met (not every reason inside a statement: that
would mean walking past a refusal in every builder, which nothing needs
yet).


### The port list

Every reason below is a construct, input or state this engine does not run
yet, and so a port toward zero refusals: what the TypeScript engine does
there is the specification, mirrored here. Each is a stable snake_case
string: the one log line per run names the first, and `rustRunStats` counts
it (`notAdmitted` and `allReasons` for the first two places, `declined` for
the third). "Needs" says what this engine must gain to run it. A size is
given where one was estimated (S, M, L); the rest are unsized. The
constructs this engine already runs are "The run" below.

Each row's last column starts with its status: **Closed** (nothing is left
to port: the reason is refused on either engine, or no checked program
reaches it), or **Open**, with how many runs of the conformance corpora
still meet it (counted under each statement's first reason, `allReasons`, at
chunk 7A Task 7; "no corpus run meets it" is not "unreachable": the row
names a construct a checked program can still write), then what closing it
takes. A row narrowed by an earlier task names the exact construct still
refused in its second column. In a row of several reasons, a reason the
checker or the parser refuses outright is one the patterns oracle reports
`unreached` (`pnpm engine:patterns`, with the diagnostic in its note); the
row stays Open while any of its reasons is reachable.

**The file** (admission):

| reason | the construct | status, and what closing it takes |
|---|---|---|
| `language_version_unsupported` | the run is pinned to a language version this release does not support (`SUPPORTED_LANGUAGE_VERSIONS`), refused by that name before the parse and before any construct's reason, so it is the only reason the run holds. In process the run's check ends such a run first (MOVENG_LANGUAGE_VERSION, before the segment opens); the reason is what the dry run and an embedder that does not check first see | **Closed**: refused on either engine by design. Takes: nothing: an unsupported version is refused on either engine |
| `import_from_file` | an import from a library file the run's catalog snapshot does not carry, that does not parse, or that does not declare the name (admission reads the snapshot's `files` itself, before the check, as `resolveFileFromSnapshot` does for the link). Since PLAN-08A group F a library imported from a file runs: its movements are callees, walked in their own file under what each call passes (and with their parameters as the event where a body names one without calling it), each library's declarations and values walked whole; the run binds an imported movement in its library's own scope, built once per path when the importer's import is bound (`libraryEnv`, `declareFileImports`), and an imported shape as its declaration, its words, `type`s and base read in the file that wrote it, the library's scope built when its words are first read. A library's AST paths carry its file (`@<path>/statements/…`), so its stamps, its nested calls' places and its parked closures are found there | **Closed**: what is left the link reports (MOV_IMPORT_FILE_UNRESOLVED, MOV_IMPORT_FILE_INVALID, MOV_IMPORT_CYCLE, MOV_IMPORT_NOT_EXPORTED), and the run ends at the check on either engine. Takes: nothing |
| `import_from_<namespace>` | an import from a namespace other than `adapters`, `credentials` and `plugins` | **Closed**: the checker refuses it, so no checked program reaches it. Takes: nothing |

A source the TypeScript parser refuses never reaches this engine: the run's
check ends it with MOVENG_PARSE before the segment opens (the binding ×
consumer matrix's 24 `graph<Entry> { ?...e }` cells under version 3: both
parsers refuse a fill spread in a graph literal). A source only this
engine's parser refuses goes on to `check.program`, and is declined
(`source_does_not_parse`) when the check passes.

A file-level `node <Name> { … }`, `type`, `import … from plugins` and value
(`rules = "…"`) are admitted: each binds a name and runs nothing, as
`interpretFileStatement` does. So is the rest of the file, as that function
reads it (chunk 7A Task 6): a file-level extraction, block, write, match or
link, or a call of a movement or a plugin (`fileLevelCall`), fails the run
with the TypeScript's own MOVENG_UNSUPPORTED before any body (admission walks
nothing after it); any other right-hand side (a node, a graph, a closure)
binds nothing, and a read of it fails naming it on either engine; any other
file statement (a write, an `if`) runs nothing. A dispatched movement taking
other than one parameter, an untyped one or a value (`n: <number[]>`) fails
the run in `prepareMovement` with the TypeScript's MOVENG_RUNTIME, before its
body; a movement taking a value that a call reaches runs (chunk 7A Task 2), as
one handed where a closure goes does. A file-level value is walked as a body's
expression is, reading only the file-level values before it; a body reads
it as a value. A declared shape's words are walked in the file's scope (an
extraction reads them there). An extraction reads a shape and a type, and a
plugin call a plugin, an `IS` test a node declaration, and a declared edge
(`kids: <Kid>`) the landing shape its writes mint; what else reads one is
refused where it stands (`is_test_declared_record`).

**Names** (a reached body):

| reason | the construct | status, and what closing it takes |
|---|---|---|
| `name_shadowed` | a body binds a name the movement's parameters or the file bind | **Closed**: the checker refuses it (MOV_SHADOWED_NAME) under every supported version, so no checked program reaches it. Takes: the TypeScript's environment rebinding rules (what a later binding does to an earlier one) |
| `name_rebound` | a body binds one name as two kinds (a value and a handle, …), or twice where one binding can see the other (in one scope, or in a scope and one inside it); names are scoped lexically, so two blocks may reuse a hop alias, and two arms or two block bodies a name | **Closed**: the checker refuses it (MOV_REBOUND_NAME, or MOV_SHADOWED_NAME), so no checked program reaches it. Takes: the same rules |
| `name_not_value` | a plugin call's argument naming bare a name that may hold something other than a value (the event, a handle, an instance, a node, an extraction's record). Kept after main's nested-record rule (forward merge 3) and chunk 7A Task 6b. Since main's record walk (group G, 2026-10-12) a through stage's argument is held to what the plugin takes, as a plain call's is: the event there ends at the check (its `deck` is a file, MOV_CALL_ARG_TYPE), and a record the run wrote, handed whole (`through [echo(q: co)]`), checks and reaches it | **Open** (no corpus run meets it). Takes: what the TypeScript hands a plugin for a binding |
| `plugin_arg_record`, `builtin_arg_record`, `write_field_record` | a record (other than the event, whose binding object is the data `{kind: 'event'}`) that may reach, inside a list or a map, a plugin's argument; any record reaching a reading this engine may hand back to the TypeScript member (`builtins.function`: a regex, a split), or a system write's or match's field. Admission follows what each value holds — free of records, one record whose fields are data, a map, a list of records or a list of maps, or anything — through bindings, collection ops' parameters and answers, bound blocks, node literals and local writes. Since chunk 7A Task 6b it reads the types the checker holds a program to where it held a value may be anything: a parameter typed by a value type takes a value no record is (every argument bound to it is held to that too, `call_arg_record`); a closure's parameter typed by a position takes one record, a graph the run built among them, whose field reads are values (where no node of the body holds a record in a field); a call of a closure, a movement or an extraction hands back what its own returns hand back (`return n + base` a value, `extract(…)` its records), nested in an expression too; `COALESCE`, `IF`, `AND` and `OR` hand back one of their operands; a map spread of a record copies its fields; a graph spread `...m.k` reading a record copies the record's. Each reason is still reached where the checker is silent, and each such run is a genuine record. Since main's B14 (a call's value holds what its returns may hold: a function's on every version, a closure's from version 3) the checker also sees a record handed back into a field by a closure or a function (`body: f()`, `f = () => COALESCE(co, "x")`, MOV_WRITE_FIELD_TYPE) and a graph whose entry holds one (MOV_GRAPH_ENTRY_RECORD), so those end at the check on both engines and no patterns-oracle program reaches `write_field_record` now; where a corpus run still meets it, the TypeScript hands the record to its host as the binding object, which the real host refuses mid-run ("is an instance of Bound, which does not cross the host boundary as JSON") after the run's earlier writes, so no Rust run could end as it does and the refusal stays at admission. Since group G the checker types `MULTI(co)` as a list of records, so it ends at the check where the direct form does (`MULTI(co)` to a json parameter: rust_checker_types). A combinator over arms a value holds (`r = await parallel(arms)`, `arms` a MAP whose function returns closures: the two v3 corpus runs in resume_inside) reads each arm's returns since PLAN-08A Task 2; a receipt whose arms are NAMES (a closure or a movement, `parallel([f, g])`) reads each name's returns the same way, so named arms returning text write whole (both-engine tests, v3-v5; a name whose returns may hold a record keeps the refusal at admission, but since main's receipt walk (58b55a3d..130de411) the checker holds a receipt to what its arms return on every version, so a record in a receipt reaching a field, entry, argument or extraction ends at the check on both engines and that `receipt_holder` refusal is unreachable from a checked program); the two v3 corpus runs left are nested movement calls (`nested_movement_call`'s). Since main's record walk (group G, 2026-10-12) the checker sees a record through `COALESCE`, `IF`, `MULTI`, a through stage's argument and a map lookup, and checks every record in an extraction input: `body: COALESCE(co, "x")` ends at the check (MOV_WRITE_FIELD_TYPE), as do `{ k: COALESCE(co, "x") }` to a plugin and every record inside a through stage's argument (MOV_CALL_ARG_TYPE), and a system's record in `extract from [ … ]` (MOV_EXTRACT_CONTENT); a record handed back by a closure called in a field (`body: f()`) ends there too since B14. `plugin_arg_record` is now unreached (the patterns oracle's programs all end at the check); `builtin_arg_record` is unreached (the checker refuses a record handed to a text parameter) | **Open** (met in the corpora, every reason: v3 2, all `write_field_record`). Takes: the binding objects themselves on the eval wire: the TypeScript hands its host a record's binding object, its read seam and provenance included |
| `extract_from_record` | a record in an extraction's `from` datum | **Closed** (fix round 1 of the group G merge, 2026-10-12): the prompt writes a datum as its value, a record at any depth as its fields (`fieldsValueOf`, extract/prompt.rs `segment_for_datum`, over `record::fields_of` as `recordFields`), a block's records and a receipt's slots as lists; a record whose fields are not in hand (a system's record, the event) fails the run with the TypeScript's own MOVENG_UNSUPPORTED, and so does a file inside an input or a value holding itself. The checker refuses a system's record and a file inside an input first (MOV_EXTRACT_CONTENT), so those runs end at the check on both engines. Pinned: the patterns oracle compares every request, the prompt text included, byte for byte for a written record (versions 2 and 4), a node with an absent field, an earlier extraction's result, a record under a key, and records nested in maps and lists; extraction.json's `wiredDatum` cases pin the file refusal's words. The file refusal is pinned at the prompt function, not at a run's ending: no checked program reaches it on either engine |
| `call_arg_record` | a value that may hold a record (through `COALESCE` or `MULTI`, where the checker is silent: a closure's value parameter) handed to a value parameter: a closure's or a movement's, by a call or as a collection op's function named (`MAP(xs, note)`, a REDUCE's accumulator too). Admission reads a value parameter as free of records (chunk 7A Task 6b), so it holds each argument to that. `MULTI(co)` hands on a list holding the record itself; a write into a scalar field coerces that list to its text (`"[object Object]"`, on both engines), but the parameter's value may reach a plugin or a map as the binding object, and where it goes is not read here, so it stays refused (as does a parameter that never reaches the host, `FILTER([COALESCE(co, "x")], keep)`) | **Open** (no corpus run meets it). Takes: as `write_field_record`: the binding object as the TypeScript hands it on; or which hosts a parameter's value reaches |
| `position_arg_record` | a record that may hold a record in a field handed to a position parameter (`hp(r: x)`, `x = graph<Co> { name: f() }`, `f = () => COALESCE(co, "x")`): the callee's body reads the parameter field by field as data, so every call site — a movement's, a closure's, a nested one, a named callback, a function handed by name to a collection op — holds what it hands to a record known to hold none in a field: a system's or an extraction's record, the event, or a node of the caller's own where none of its nodes holds one (a node a call hands back is read by the callee's returns). A sibling of `call_arg_record` rather than it: the argument is itself a record, and what may hold one is a field of it (fix round 1 of chunk 7A Task 6b). Since main's graph-entry rule (MOV_GRAPH_ENTRY_RECORD, every version) the checker closes the direct form, a record through `COALESCE` written in the graph's entry (`name: COALESCE(co, "x")`), which ends at the check on both engines; since main's B14 so does a record handed back by a closure called in the entry (`name: f()`), so no patterns-oracle program reaches this refusal now. A value that MAY be a record and may be data (main's B15: a COALESCE or an IF of a record and text, a number or null, a name bound only to one, a closure's or a function's call handing one back) is no longer refused (main merge 10): each record operand is held to the rule above (`clean_record`'s `either_clean`, `either_holder`), and the run binds the record, or fails passing the data, as `evaluateCallArg` does; under version 5 the checker refuses it (MOV_CALL_ARG_MAYBE_RECORD) on both engines (rust_checker_types.unit.test.ts, each member kind on version 4) | **Open** (no corpus run meets it). Takes: as `write_field_record` |
| `at_record_key` | `AT` over a value that may be a record with a key that is not a text literal, or names an internal of the binding object (its read seam, provenance, `Map`s). The checker refuses `AT` on a record for any key that is not an index (MOV_AT_RECORD_KEY, main's record walk, group G), so `AT(co, key)` and `AT(FIRST(rows), "provenance")` end at the check; what reaches it is admission's imprecision only. Since PLAN-08A group F′ part 2 a GROUPBY over records is read as a map of lists of them (as a KEYBY is a map of them), so `AT(grouped, FIRST(x.entries).name)` over an extraction call's records in a MAP member's map field runs (the corpus's one run, which group F′'s staging exposed: its reason was the GROUPBY beside the KEYBY) | **Open** (met in the corpora, every reason: none). Takes: a holder for each further shape admission reads as anything, as one is met |
| `node_spread_record` | a map holding a record spread into a graph (`held = { k: f() }`, `f = () => COALESCE(co, "x")`, then `graph { ...held }`). A record the checker sees in the map at any depth (`held = { k: co }`, `{ first: FIRST(rows) }`, inside a null-prototype map) is closed by the checker since main's graph-spread rule (MOV_GRAPH_SPREAD_RECORD): the run ends at the check on both engines; since main's B14 so is one handed back by a closure (`k: f()`, a closure's value read from version 3), so no patterns-oracle program reaches the engine's own refusal now (the engine's `spread_into_graph` still fails such a run at its key) | **Closed** (PLAN-08A Task 2): the run fails as the TypeScript's `spreadIntoGraph` fails it, the record found anywhere in the map before its key is filed (`holdsRecord`; MOVENG_RUNTIME "'k' holds a record, and a map spread into a graph copies values and maps…", crate::node `spread_into_graph`). Takes: nothing |

**Statements and right-hand sides** (a reached body):

| reason | the construct | status, and what closing it takes |
|---|---|---|
| `statement:call`, `movement_call`, `function_call` | a call statement of anything but a movement, a plugin or (from version 3) a closure bound to a name: a built-in's is the checker's (MOV_BUILTIN_UNUSED from version 3, MOV_NAME_UNRESOLVED before), (a function an import binds is a movement callee since PLAN-08A group F); a call of a movement whose value is not one kind on every path, or whose kind is left open by a recursion that declares no value it returns (one that declares a value hands that back: PLAN-08A group C); a bound call of a name the program binds that is no movement and no closure (the TypeScript fails it), of any non-movement callee before version 3, or of a name the program binds to closures that differ in what their parameters take. A call of a closure bound to a name runs (`executeClosureCall`: arguments bound by name or by order in the caller's source order, the body in its captured scope under the call's step, a park inside it resumed there; chunk 7A Task 6), returned too (`return f(n)`), and a function whose return is such a call hands back a value where every closure of the name returns one free of records: in a library function as in the root (the PLAN-08A batch review's L2, closed by PLAN-08B Task 2; before, `movement_call` and `function_call` refused it). A name bound to a call's value (`h = mk(2)`, then `h(1)`) is a closure where every `return` of the callee hands one back — a closure literal or a name bound to closures; the callee a body or file-level closure, a `function` or `movement` of the file, a library's function, or another such name (`k = h(2)`), spelled in any letter case `resolveCallee` reads — so its call runs as a closure's, in the scope the callee's call made, and hands back what that closure's returns do, read in the walk that holds its names (`Callees::closures_returned`, `outside_closure_holder`; the merge 11 review's item 4, which `function_call` refused at v3-v5 where the TypeScript ran it). Both-engine tests v3-v5 (body_closure_scope: with arguments, twice, inside MAP and handed to it by name, chained, a park inside the returned closure's call resumed either way round, the same bytes); a call of a file-level closure's value into a json field (`write_field_record` before) runs by the same reading. A callee one of whose returns is no closure leaves the name no closure and the call refused (`function_call`), but the checker refuses that program first (MOV_RETURN_PLANE_MISMATCH) | **Open** (met in the corpora, every reason: none). Takes: for `movement_call` and `function_call`, a call's value kind decided at run time (a recursion's, a closure's of differing parameters); what is left of `statement:call` the checker refuses |
| `rvalue:closure`, `rvalue:lazy`, `rvalue:inlineBlock`, `expression_closure` | closures and lazy walks as values (a movement's body returning a lazy walk hands the walk back as its call's value since PLAN-08A Task 2; one returned from a closure, an arm, an op's function or a block's iteration is refused); a collection op written inside an expression (`{ all: MAP(xs, (x) => …) }`, run as a call bound first from version 3) runs since PLAN-08A group C: admission collects its function's body as a statement's op's and walks it as a member's, the run stages it at its place in the slot (`<slot>/nested/<start>-<end>`, which the check answer stamps), and a park in a member finds the op again by its span among the statement's nested calls; a closure where nothing stages it (a `unique by` condition, which is lowered) the checker refuses (MOV_EXPR_PARSE), so `expression_closure` is reached by no checked program | **Open** (met in the corpora, every reason: none). Takes: closure and lazy-walk binding kinds as values (a closure a combinator or a callback holds already parks and resumes) |
| `statement:collection`, `rvalue:collection` | MAP, FILTER, … whose settings record this engine does not read (a setting not written as a literal); any `concurrency` and `initialConcurrency` run since chunk 7A Task 6 | **Open** (no corpus run meets it). Takes: the settings' reading where the checker's `readCollectionConfig` reads more |
| `statement:refresh` | `refresh` | **Closed** (PLAN-08B Task 2; Henry kept its mutation, 2026-10-13). `interpretRefresh`, as the TypeScript runs it: a write handle's record is re-fetched through its system's adapter, resolved by its type alone as a source, and its `resultData` (and each written field the fresh record names) moves on for every holder within the segment, the run's result included (after a park, names that were bound to one handle come back as separate handles, on both engines: the TypeScript's own behaviour, mirrored, tracked as bug B7; so a refresh after a park moves the name it names). The adapter is handed a copy of a write's fields, so a refresh never changes an object an adapter kept; a traversed record's inline data moves on, seen through every name that holds it (crate::bindings `Landed::set_position`). `readRecord` where the adapter has it (null fails the run, F22), else each snapshot field read through `getFieldValue` at a probe position (through the graph's read wrapper for a traversed record); a handle with no id has nothing to move; any other binding fails as the TypeScript fails it. A moved record parks as it now stands |
| `statement:<kind>` | any other statement, by its AST `kind`. A `shape` declared in a body (`statement:shape`) runs since PLAN-08A group F: hoisted for the body as `executeStatements` declares it (a resume entering past it finds it again, or keeps the one its park rebuilt), its words and its base read in the body's scope, its `type`s in the body's file; parked as `localShape` (its declaration) and rebuilt from where the program writes it, its words then read in the running file | **Closed**: what is left (an import, a `type`, a movement or a listen in a body) the parser or the checker refuses. Takes: nothing |
| `nested_movement_call`, `nested_call_form` | a call written inside an expression (from version 3, crate::nested, as `stageNestedCalls` binds each first to a name only the engine spells, in the order written and only where reached; the closure's, the plugin's and the extraction's run since chunk 7A Task 6, a movement's since PLAN-08A group C: admission collects the movement calls a statement's own expressions nest with its statements' calls, so the callee is walked under what each passes, and the run stages it as a statement's call, a park inside it resumed through the statement's call frame) that calls a movement whose value is not known to be a value (a record, a node, a kind decided at run time: the name it is bound to is read as a value), or does not read as a call (the checker refuses it). An argument a statement's place stamps (a write, a node, a function, a type) runs since PLAN-08A group C: the check answer carries the stamps on a nested call at its place in its slot (`<slot>/nested/<start>-<end>/value`, program_check.ts), and the run reads the call there (crate::program `node_at`) | **Open** (met in the corpora, every reason: none). Takes: for `nested_movement_call`, a nested name bound to whatever kind the call hands back |
| `extract_call_shape`, `extract_call_settings` | an extraction call (`x = extract(…)`, `extractOne(…)`, which run since chunk 7A Task 6, crate::extract::call) whose shape is not a declaration in scope (a name the body rebinds to something else); settings that do not read clean (the checker refuses them). Since PLAN-08A group F′: a shape written in place reads its words in the body's scope (any words, worked out or not), a name bound to a shape is the shape (from version 3), a shape declared in a body or imported is one in scope | **Open** (met in the corpora, every reason: none) |
| `extract_call_model` | an extraction call's written `model` (`{ model: 'claude-opus-5' }`). Retired as an admission reason in PLAN-08B Task 1: the checker and both engines hold it to one list, the catalog snapshot's `models` (filled by `availableChatModels`; ai_tiers.ts `runChatModels` gives a snapshot without one the same function's answer, and the shim hands the Rust engine that list as the snapshot's `models`), so a checked program's model is always in it | **Closed** for checked programs. The Rust engine's run-time check stays only as the backstop for an unchecked program (a snapshot without `models`, which the checker leaves unchecked): a model outside the list fails the run with MOVENG_RUNTIME in the TypeScript's words, the list printed (`unreachedModelMessage`), on either engine. An embedder that sends no list at all ends such a call unreproduced. Takes: nothing |
| `rvalue:<kind>` | any other right-hand side, by its AST `kind`; for `return`, also `extract`, `write`, `match` and `link`, and in a block's iteration `node` and a record. A returned block (`return crm-[c:companies]-> { … }`, a park inside it joined by its fan-out) runs since PLAN-08A group C | **Open** (met in the corpora, every reason: none). Takes: a returned record binding (a return value that is a record, as a call's value already is) |
| `plugin_call` | a plugin's call this engine does not make: of a plugin the input's snapshot does not describe, or a `through` stage naming no imported plugin, both of which the checker refuses (a stage spelled in another letter case is MOV_NAME_UNRESOLVED). One spelled in another letter case than imported is the plugin's call from version 3 (`resolveCallee`, PLAN-08A Task 2: a statement, a binding, a construction or another call's argument), and one inside an expression, `{ page: p(…) }`, runs since chunk 7A Task 6, as a nested call | **Closed** (PLAN-08A Task 2). Takes: nothing a checked program reaches |
| `plugin_call_form` | a plugin's argument that is the call of a function the program declares (a movement's, a closure's, a plugin's) whose value may hold a record a way admission does not follow: a movement's or a closure's call runs since PLAN-08A Task 2, its value held to what its returns hold (a value, or one record whose fields hold none, which the plugin is handed as its fields, `recordFields`), and so does a plugin's whose output is a value or a record (`executePluginCall`, run first). A positional first argument (the run fails, on either engine), a built-in's call (the value it computes), a node (its fields) and a write, a function or a type (the TypeScript's `unsupported`, mirrored) run since chunk 7A Task 6. Still reached by a function whose `return` hides a record from the checker (`COALESCE(co, n)`, group G's) | **Open** (no corpus run meets it). Takes: group G's checker change (COALESCE typed as the union of its operands), which makes the last form the checker's |
| `builtin_call_form` | a built-in's call `readCall` refuses: a named argument, a value built-in handed an argument that is not a value (a closure, a write, a node), or no expression to read (the checker refuses each). A call among a built-in's arguments reads as `readCall` reads it at an argument's place since PLAN-08A group C: a function's (a movement's with named arguments, `CONCAT(mark(t: "a"))`) is staged, a collection op is its expression (`FIRST(MAP([e], (x) => …))`) | **Closed** (PLAN-08A group C). Takes: nothing a checked program reaches |

**Writes, matches, links, deletes** (a reached body):

| reason | the construct | status, and what closing it takes |
|---|---|---|
| `write_bind` | a write with `bind` | **Open** for versions 1–4 (no corpus run meets it); retired under version 5 by the checker (`MOV_WRITE_BIND_RETIRED`), so a checked version 5 program never meets it. Takes: `park.bindings.*` |
| `match_tuple`, `match_position` | a match over a tuple of paths, or of a bare alias | **Closed** (PLAN-08B Task 2). A tuple's match finds one record at the convergence of its paths, resolved as a tuple write's target is (`resolveTupleWriteTarget` under the verb `match`: one graph, one inferred type, every path's parent and WHERE on the candidate), and binds the handle it found or misses as a linked match does (absent from version 4, the scope ended before). The parser refuses a match of a bare alias; a member path's root, bound for the match alone, fails as the TypeScript's `resolveWriteTarget` fails a position target |
| `write_position_not_record`, `delete_not_record` | `write x { … }` where `x` is not a record (a write's handle, a block's hop alias, a node the run built or what one's edge holds); `delete x` where `x` is not a write's handle, a hop alias or what a node's edge holds (a delete of what a node's edge holds runs since PLAN-08A group E: a system's record is deleted in its system, a run-built node fails as `resolvePositionWriteTarget` fails it; since PLAN-08A group F′ part 2 so do a delete of the event and of a value admission knows holds no record, with the TypeScript's own error) | **Open** (met in the corpora, every reason: none). For `delete`, retired under version 5 by the checker (`MOV_DELETE_NOT_RECORD`, `MOV_DELETE_NOT_DECLARED`); open for versions 1–4. Takes: for `write x { … }`, the TypeScript's errors for the event and a value; for `delete`, a value that may hold a record and an extraction's root, each mirrored |
| `write_root_expression`, `match_root_expression`, `write_root_not_held`, `match_root_not_held` | a linked write or match rooted at an expression that is no member path (the parser refuses it), or at a shape the file declares. A root that is a member path (`write m.k { … }`, `write m.k-[:e]-> { … }`) is bound for the write alone and runs since chunk 7A Task 6 (`bindTargetRoots`). A linked write rooted at a declared shape (`write Note-[:item]-> { … }`, retired at author time and still run for saved programs) runs since PLAN-08A group E as `materializeShapeWrite`: an in-memory position of the shape's type, each field's trail kept, its WHERE and `unique by` failed as the TypeScript fails them | **Closed**: a match rooted at a shape the checker refuses (MOV_LINKED_UNKNOWN_EDGE), an expression root the parser. Takes: nothing |
| `write_multi_hop`, `match_multi_hop` | a linked write or match that walks more (or less) than one edge | **Closed** (PLAN-08A Task 2): the run fails where the TypeScript's `singleWriteEdge` fails it (MOVENG_UNSUPPORTED "multi-hop linked writes", crate::write `single_edge`), after the effects before it; forgiven by a collection op's `onError` as the TypeScript's is. A target path the lowering cannot read stays refused by this name; the checker refuses it first. Takes: nothing: the TypeScript's own failure, mirrored |
| `write_spread_path`, `node_spread`, `node_spread_path`, `node_spread_source` | `...m.k` in a write or a graph literal; a spread in a `node { … }` literal; a graph spread of a name that is not a value, a handle or a node. A graph spread of a value's member runs since PLAN-08A group E (`spreadSourceBinding`: what the map holds under each key, bound as `x = m.k` binds it, copied by the checker's plan or spread as a map) | **Closed** (PLAN-08B Task 2). The event is a record like any other: `...msg` copies its source position by the checker's plan, as a graph's reference entry holds it, and `...r.k` off a record reads `k` off it as `x = r.k` binds it (`readLandingField`), on both engines (the TypeScript failed both before, MOVENG_UNSUPPORTED and MOVENG_RUNTIME, so a program the checker passed ran on neither); a step that is neither a map's key nor a record's field copies nothing or fails as `spreadMap` and `spreadRecord` fail it. A spread in a `node { … }` literal the parser refuses (`node_spread`, unreached); a write's `...m.k` the checker spells out or refuses (`write_spread_path`) |
| `unique_by_without_key`, `unique_by_reads_beyond_candidate` | a `unique by` clause with no key (no bare field, parent or `field == value`); a conjunct that is not a pure predicate over the candidate | **Closed**: the checker refuses both (MOV_UNIQUE_CONJUNCT_NEEDS_WHERE), so no checked program reaches them. Takes: the TypeScript's post-filter for impure conjuncts |

**Nodes and graphs** (a reached body):

| reason | the construct | status, and what closing it takes |
|---|---|---|
| `node_declared_entry`, `node_event_entry`, `rvalue:node`, `exists_node` | a declared edge entry inside a graph literal (the parser refuses one); an entry holding the event; a node a block's iteration returns (its block's value would be the records returned); `EXISTS` off a node this run built, or what one's edge holds, of more than one hop or with an ORDER BY or a LIMIT | **Open** (no corpus run meets it). Takes: an entry holding the event; returned records as a block's value; EXISTS's per-origin ORDER BY / LIMIT and its walk past the node plane |
| `is_test_declared_graph` | `x IS <Decl>` (a node declaration) where `x` is a `graph { … }` literal, whose entries may hold a system's records nested (an `IS` of the event, a handle or a landed record runs since chunk 7A Task 6: `check.compatible` asks the checker's assignability of the record type's schema) | **Closed** (PLAN-08B Task 2). A system's record a synthesised node's edge holds (a handle, a landed record, the event) is compared with the declaration's node at that place by the checker, as `surfaceMisfit` compares a landing across an edge: `check.compatible` carries the declared edges walked from the root (`path`), and a declaration a library writes names its file (`file`), for the subject itself too. A record of no known type, or one no schema enumerates, fits there, as `subjectSurface` gives such a landing no surface |

**Traversal blocks and heads** (a reached body):

| reason | the construct | status, and what closing it takes |
|---|---|---|
| `block_head_rootless`, `block_head_expression_root`, `block_head_root` | a block head with no root; rooted at an expression (`AT(rows, 0)-[c:company]->`) or a value (a list of records), or anything but an instance, a write's handle, the event, an enclosing block's hop alias, what an extraction yielded, a node the run built or what one's edge holds | **Closed** (PLAN-08A Task 2): a rootless head fails the run where the TypeScript's `resolveHeadIterations` fails it (MOVENG_UNSUPPORTED "rootless block heads (relative traversal)", crate::traverse `head_iterations_past`); a head off an expression or a value runs (chunk 7A Task 3), and one off any other name fails as the TypeScript's does, so admission refuses neither. Takes: nothing |
| `block_head_value_root` | a block head rooted at a kept walk (`files-[f:x]->` continues the walk past its head) | **Closed** (PLAN-08A Task 2): the hop continues the kept walk past its head, in the scope it captured (`resolveHeadIterations(walk.head, env, extraSteps)`, crate::node `run_deferred_past`), its WHERE and ORDER BY held to what a value's head holds them to. Takes: nothing |
| `block_multi_hop`, `block_head_step` | a head of more than one hop, a hop that is not an edge | **Closed** (PLAN-08A group D): a head walks every hop off every path the hop before reached, breadth first, each hop's ORDER BY and LIMIT per origin (`walkSourceHeadPaths`, crate::traverse `source_head_paths`; down a node's edges `walkSynthesisedEdges`, past a system's record the source's walker; down an extraction its entities' children), each hop's alias naming its own level's record; admission holds every hop's WHERE and ORDER BY to what its landing reads, and binds every hop's alias. A parked iteration's exports leave out every hop's alias (and a `_resources` hop's), as `hopAliasNamesOf` does. A hop that is not an edge (`#transform`) the checker refuses (MOV_TRANSFORM_HOP_RETIRED). Takes: nothing |
| `block_head_extract_hop` | a head over what an extraction yielded whose hop carries a WHERE (the TypeScript refuses it), an ORDER BY, a LIMIT or an incoming direction (which it does not read) | **Closed** (PLAN-08A Task 2): a WHERE fails the run as the TypeScript's `headIterationsFrom` fails it (MOVENG_UNSUPPORTED "WHERE filters on extract-result block heads", crate::traverse `extract_paths`); an ORDER BY, a LIMIT or a direction is not read, by either engine. Takes: nothing |
| `block_head_resources` | a `_resources` head (off the event or an extraction) | **Closed** (PLAN-08A group D): off the event or a system's record, the record's bundle through the event's source (`resolvePositionResources`: `getRelated` of the reserved `_resources` reference, each record's `data` a resource, every one without an id given one by `ids.mint`); the host makes each resource's `fileRef` slot a file (`filesIn: "resources"` on `adapters.call`, rust_host.ts, `withResourceFile`), so a file carried forward into a write is the very descriptor (the shim's file table hands back the object it was given). A `_resources` head on a record landed from another system (`crm-[c:companies]-> { c-[f:_resources]-> … }` under an email event) is read through the event's source adapter too, with that record's position (`email.getRelated("_resources")` asked about an Attio record): a TypeScript quirk (run.ts hands `resolvePositionResources` `this.source.adapter`, not the record's own read), mirrored exactly, not a design. Henry ruled 2026-10-13 that `_resources` becomes an edge only `extract` produces, which retires this read off a system's record on both engines: under version 5 (Dancing Wren) the checker refuses it (MOV_RESOURCES_NOT_EXTRACTED), and a run that meets it anyway fails on either engine with the TypeScript's own MOVENG_UNSUPPORTED before the host is asked ("Language version 5: the port list"); versions 1–4 read it as described here. Off an extraction, the resources it stamped. The hop's WHERE is read over each resource with it current (`filterResources`: `@resource.*` and the WHERE's resource fields read its `data`), its alias naming it; off anything else the run fails as the TypeScript's does (MOVENG_UNSUPPORTED "this block head over …"). Takes: nothing |
| `traversal_meta_edge` | a hop over a `#`-prefixed edge: the engine's own meta references, which the TypeScript read wrapper hands the adapter unrestamped | **Open** for versions 1–4 (no corpus run meets it); retired under version 5 by the checker (`MOV_META_HOP_RETIRED`). Kept refused by name under Henry's ruling (2026-10-12): PLAN-08A group F found no block-meta binding to close it with (the TypeScript builds none; `resume_state_kind:blockMeta`). Takes: the meta-edge walks over run-built accumulants (run.ts `metaEdgeBindings`), the adapter pass-through without restamping (kg.ts) |
| `select_multi_hop`, `traversal_root` | `x = FIRST(…)` of a walk of more than one hop; a walk rooted at a kept walk, or with no root | **Closed** (PLAN-08A group D): a pick walks every hop as a block head does (`selectedPositionBinding` over `walkSourceHeadPaths`); a hop off a kept walk continues the walk past its head (`resolveDeferred`, crate::reading `deferred_landings`), each hop held to what every kind reads; a walk with no root (a resource walk past a hop, whose root the lowering drops) fails as the TypeScript's evaluator fails it (MOVENG_UNSUPPORTED "relative traversal (no alias root)"). Takes: nothing |
| `traversal_step`, `traversal_steps`, `traversal_terminal`, `exists_step` | a hop that is not an edge; a field read off a held name that also walks hops; a walk ending in anything but a field | **Open** (no corpus run meets it). Takes: the full walk evaluator, with the TypeScript's errors for the forms it refuses |
| `walk_extract_hop`, `exists_extract_hop` | a hop down an extraction with a WHERE; in `EXISTS`, one with a WHERE, an ORDER BY or a LIMIT | **Closed** (PLAN-08A Task 2): a walk's WHERE (or a hop that is no edge) fails the run as the TypeScript's `walkExtractSteps` fails it (MOVENG_UNSUPPORTED "WHERE filters on extract-result hops", crate::traverse `walk_extract`), its ORDER BY, LIMIT and direction not read; an `EXISTS` reads each hop's WHERE, ORDER BY and LIMIT over the entities' children as `evaluateExists` does (crate::reading `exists`). Takes: nothing |

**Expressions** (a reached body, or a file-level value):

| reason | the construct | status, and what closing it takes |
|---|---|---|
| `aggregate:llm`, `aggregate:sort_key`, `aggregate_records` | the `llm` fold; `SORT(xs, key)` whose key is not a field name; `FIRST`/`LAST`/`ONLY`/`SUM`/… of a bare walk anywhere but a binding's whole right-hand side or a graph's entry (`COUNT` of one is admitted) | **Open** (no corpus run meets it). Takes: the llm fold through the host, record sorts, record-valued folds |
| `aggregate:only` | `ONLY(e)` of an expression its failure cannot spell back (a resource walk, which the checker refuses read so, MOV_RESOURCE_WALK_UNREAD), or of a bare walk anywhere but a binding's whole right-hand side or a graph's entry (a `node { … }` entry the checker refuses, MOV_NODE_ENTRY_NODE_VALUE) | **Closed** (PLAN-08A Task 2): crate::formula spells the rest as the formula grammar's `serialize` does (chunk 7A Task 6), and a graph's entry `owner: ONLY(msg-[:files]->)` holds the record it picks on its edge, bound as `bindSlotValue` binds it (`referencedRecords`; crate::node). Takes: nothing a checked program reaches |
| `expression:<type>` | an expression kind this engine does not evaluate, by its lowered `type`: `resource_traverse` read outside a walk, which the checker refuses (MOV_RESOURCE_WALK_UNREAD), and `edge_property` outside a hop's WHERE. A `resource` read (`@resource.*`, a `_resources` WHERE's field) runs since PLAN-08A group D: the current resource's `data` field, null with no provenance outside a `_resources` WHERE, as the TypeScript's evaluator reads it. The retired `kg_value` and `kg_exists`, which the checker passes, and the TG engine's reads (`parent_result`, `action_result`, `linked_object`, `extract_value`) run (PLAN-08A Task 2): the run fails as the TypeScript's evaluator fails a kind it has no case for, before any part is read (MOVENG_UNSUPPORTED "the expression kind 'kg_value'"). `AI()` (`llm`) runs here (chunk 7A Task 6) | **Open** (no corpus run meets it). Takes: `resource_traverse` and `edge_property` read where the checker passes them, with the TypeScript's errors |
| `expression:exists` | a rootless `EXISTS(-[…]->)` | **Closed** (PLAN-08A Task 2): outside a hop's WHERE the run fails as the TypeScript's evaluator fails it (MOVENG_UNSUPPORTED "rootless EXISTS()"); inside one it walks off the landed record, through the run's source as `evaluateExists` does (the binding it makes has no read of its own), or off the extracted entity (`Ask::ScopedExists`). Takes: nothing |
| `meta:<key>` | a key of the dispatch's `meta.bag` (`@trigger`, `@mutationContext`), which the checker refuses as an unknown `@` key, so no checked program reaches it (`@current_*`, `@user_*` and `@actor_*` run here, chunk 7A Task 6) | **Closed**: no checked program reaches it. Takes: nothing a program can write; the bag's reading if the checker ever admits one |
| `function:<id>` | a function the evaluator does not run, by its lowered id: a namespaced member it lacks, or a name the program binds or declares that no nested call reads (a call written in place of a closure, a plugin or an extraction is staged since chunk 7A Task 6: `nested_movement_call` below; a closure's spelled in another letter case, `INC(…)` of `inc`, runs when the name has one spelling program-wide, as `resolveFunction` reads it; several case-variant spellings, a sibling scope's `Get` beside `get`, are refused here by name because admission does not track scopes, and the true scope walk is chunk 8B's admission-precision item). A name nothing answers (`DOMAIN_OF`) runs here: a function the write field advertises (`invokeFieldFunction`), else the TypeScript's own MOVENG_UNSUPPORTED; so do `FILE` (`files.render`) and `READ` (`files.resolveFileText`, traced `{kind: "read"}`) (chunk 7A Task 6), and `CHUNKS` (crate::chunks: the size mode exact, the entities estimate on this engine's own letter tables, "Known divergences"; traced `{kind: "chunks"}`; PLAN-08A group F′) | **Open** (met in the corpora, every reason: none). Takes: several case-variant spellings of one closure name read by scope (chunk 8B's admission precision) |
| `within_compare` | `WITHIN` | **Open** (no corpus run meets it). Takes: WITHIN against the pinned instant |
| `static_number`, `proto_key` | a numeric literal JSON cannot carry (`Infinity`, `-0`); a `__proto__` key written in an object literal | **Closed** (PLAN-08A Task 2): a `-0` the lowering folds into a literal (`x = -0`) is `0`, as it is on the TypeScript engine, whose lowered tree crosses to it as JSON (fix round 1: `eval::static_value`; a `-0` written in place, `{ n: -0 }`, stays a negation and is `-0` on both; a `-0` computed at run time is `-0` on both), and no literal reads as a non-finite number (`1e400` does not parse); a literal's `__proto__` key is `Object.prototype`'s setter, as `value[member.key] = …` is (`JsObject::assign`: an object or `null` the prototype, anything else ignored), the eval wire carrying the prototype both ways (`["o", id, entries, prototype]`: a host's answer holding such a map crosses back as itself, rust_wire.ts `composite`), pinned by rust_values_cross.unit.test.ts on both engines. Takes: nothing |

A hop's WHERE and ORDER BY key, and a write's or a match's target WHERE, are
walked as expressions scoped at the landed record (the candidate, for a
target): a bare name (`property`, `edge_property`) is the record's field
(or a value the body binds of that name), and the rest is the expression
walk above.

**A parked state** (admission; `park::resume_refusal`). A state either
engine parked resumes here, its frames, joins, journal, `until` and every
binding kind included; only these are refused:

| reason | the state | status, and what closing it takes |
|---|---|---|
| `resume_state_does_not_read` | it does not read off the wire, or its scopes, frames or journals (a frame's own) are not lists, which the TypeScript does not read either (chunk 7A Task 6 fix round 1) | **Closed**: a malformed state, which the TypeScript does not read either. |
| `resume_state_version` | a version other than 1 | **Closed**: the park-state contract refuses it on either engine. |
| `resume_state_suspended` | a `suspended` other than `true` | **Closed**: the park-state contract refuses it on either engine. |
| `resume_state_kind:localShape` | a shape declared in a body, held across a park (serialize.ts `localShape`) | **Closed** (PLAN-08A group F; batch review fix 1): rebuilt from the declaration the state carries, as serialize.ts rehydrates it, never looked for in the program; its words read in the running file as serialize.ts's rehydration leaves them. Takes: nothing |
| `resume_state_code_does_not_read` | code the state carries as its syntax tree (a closure's, a run-time arm's body, a body-local declaration, a kept walk's head or mapping) that does not read back as the AST it was written from | **Closed** (batch review fix 1): a state neither engine writes — both park every such piece as the whole tree (serialize.ts; park.rs `program_code`, since the first Rust park), so none in a store lacks one. Refused by name rather than guessed at by searching the program. Takes: nothing |
| `resume_state_kind:blockMeta` | a block's meta edges bound as a name (serialize.ts writes and rehydrates one) | **Open** (no corpus run meets it, and no run makes one: the TypeScript's only builders of a `blockMeta` binding, run.ts `buildCombinatorReceipt` and `buildRaceReceipt`, are called nowhere, so only a state made by hand holds one). Kept refused by name under Henry's ruling (2026-10-12: more than a day's port for a construct no corpus run reaches). Takes: a block-meta binding kind with its reads (a head over its meta edges, `metaEdgeBindings`, expression.ts `walkMetaSteps` and the surface reads), which `traversal_meta_edge` needs too |

A state that reads but is malformed for its kind (a `handle` without its
record) fails the resume loudly (MOVENG_RUNTIME, "the parked state holds
…"), never resumes it wrong.

**Parked code is rebuilt from its tree** (docs/contracts/park-state.md, "Code
is carried as a name, or as its syntax tree"; batch review fix 1). A
closure, a run-time arm's body, a kept walk's head and mapping, and a
body-local declaration come back as the tree the state carries — read into
the typed AST (movement-parser's `Deserialize`, by `kind`) — exactly as
serialize.ts rehydrates them, never by finding a span in the re-parsed
program: a span names no file, and a library edited while the run slept
holds other code at it. A closure or a walk becomes a file of its own
(`DeclaringFile::Parked`, paths `%<n>/…`): its stamps are the checker's
facts the parked tree carries (`fields`, `copy`, `reference`), its nested
calls are placed in it, and the next park writes it back from it.

**The shim's input checks** (`notAdmitted`, one reason each):

| reason | the input | status, and what closing it takes |
|---|---|---|
| `event_does_not_cross` | an event or parked state the eval wire cannot carry as itself (a function, a bigint, a class instance (a plain object whose prototype was assigned, `null` included, crosses with it, PLAN-08A Task 2 fix round 1), a shared open reference, an array hole; a `Date` is its ISO text on both engines, transition artefacts row 13; an own `__proto__` key crosses as a key, row 7, and a lone surrogate as its code units, row 9) | **Open** (no corpus run meets it). Takes: nothing a host sends (the event is data a webhook's or a poll's JSON made) |

**After the check** (`declined`):

| reason | what the stamps say | status, and what closing it takes |
|---|---|---|
| `event_field_dated` | the program read an event field the source's schema types as a date: an adapter might have answered it as a `Date` | **Closed** (PLAN-08A group F′, Henry's ruling): a `Date` the event or an adapter holds is its ISO text on both engines (transition artefacts row 13); the decline is gone |
| `catalog_does_not_load`, `event_does_not_read`, `instant_does_not_read`, `local_zone_does_not_read`, `check_answer_malformed` | the run's input or the check's answer does not read (a `localZone` the environment's zone database does not know) | **Open** (no corpus run meets it). Takes: to become errors: shim faults in all but name |
| `source_does_not_parse` | a source this engine's parser refuses and the checker passes | **Open** (no corpus run meets it). Takes: the grammar this engine lacks (none is known) |
| `condition_does_not_lower`, `expression_does_not_lower`, `block_head_does_not_lower` | a slot (or a block head's probe) this engine's lowering misses, and the checker passes; alone, it is not refused at admission: a slot the checker refuses (`CURRENCY.PARSE(…)`) ends the run at the check on either engine, as the TypeScript's does (chunk 7A Task 6). With another reason it is refused with it, and the admission dry run (`dryAdmission`, never answered) names it among the refusals. A field read off a call's answer (`FIRST(held.entries).name`) runs since PLAN-08A group F′: the TypeScript does not lower it either, it binds the call to a name first whatever the call is (`hoistingMemberReads`), and so does this engine's staging now (crate::nested `staged_calls`), from version 3 | **Open** (met in the corpora, every reason: none). Takes: the lowering's coverage of whatever else a checked slot holds, in crates/movement-parser (shared with the browser's parser artifact, so a change there weighs its size) |
| `unreproduced` | mid-run, this engine's own refusal of what the TypeScript engine runs on through (MOVENG_UNSUPPORTED naming the construct, "Errors a run can meet mid-run" below), met before the run's first effect: it has asked its host only reads (the check, `adapters.resolve`, an adapter's read methods, the clock, the cancel gate, `builtins.*`), so nothing it did is kept | **Open** (no corpus run meets it). Takes: each construct's port; after an effect the same refusal fails the run |

**Not refusals, still TypeScript.** Zero refusals is not zero TypeScript:

- **Hand-backs mid-run.** An admitted run still asks the TypeScript
  standard library for a reading this engine does not reproduce
  (`builtins.function`, `builtins.compare`; the evaluator's `fallback`).
- **Mid-run failures by name** ("Errors a run can meet mid-run" below): a
  divergence wherever the TypeScript engine carries on, each listed with
  what closes it ("Known divergences").

### Language version 4: the port list

Version 4 (Luminous Owl, main's d5bb93f794) changed what four constructs
mean. Each was refused by name under `since(v, 4)` until it was ported
(PLAN-07A Task 4c), and each port is a `since(v, 4)` conditional at the
point of difference; a version 1 to 3 program runs exactly as before (the
v1, v2 and v3 corpora).

| main's change | sha | on this engine |
|---|---|---|
| a named match that finds nothing binds absent and the block carries on; a judge outage on a match leaves a `MOVENG_MATCH_JUDGE_UNAVAILABLE` warning | 26ed0b502f, 30e1acc55b | runs (crate::verbs `OnMiss`); a link's body still ends the scope on a miss, which version 4's checker refuses (`MOV_LINK_MATCH_BODY_RETIRED`) |
| `-[:@old]->` off a write handle: the record the write found, the handle itself under `dry_run`, the previous handle on a chained write | 1bd0d3aa10, 30e1acc55b | runs: the hop is answered from the handle, never an adapter (crate::reading `is_old_edge`: an expression's walk, an `EXISTS`, a pick, a block head); the record before rides on the handle (crate::bindings `Old`) and a park carries it as `old` / `oldIsSelf` |
| `write org { … }` on a handle updates it in place | 1bd0d3aa10, 30e1acc55b | runs: the handle `org` moves on to the updated record (crate::bindings `Handle::move_to`), seen by every scope holding it, its `@old` a snapshot of it as it stood (or itself, under `dry_run`); a match's handle, a landing or a snapshot is written through as before, into a new handle |
| a handle reads the record as found (`foundData`) for a field its write did not set; a parent link carries only what the parent's own write got back | 1bd0d3aa10, ac7ac15ec8 | runs: every update that found its record by identity (`unique by`, native constraints or the adapter's own rule) or through a position keeps it (crate::write `record_before`), whatever admission can see; a hop and a parent link read only `resultData` |

tests/oracle/handles.json holds the four to the TypeScript: 983 seeded
programs (seed 20261012, written by generate.ts's `writeHandlesOracle`,
tests/handles_oracle.rs) over a CRM of two companies, written through it and
through a rehearsing instance: writes with and without `unique by` (FUZZY
among them, a judge scripted per case: an index, none, or out), a CRM that
matches by name or by its own rule (every company, whatever was asserted)
and that can read a record back or not, `write h { … }` and `x = write h {
… }`, guarded matches that hit or miss and a write through what one found,
writes through a traversal landing and per MAP member, linked writes off a
handle, and reads of every handle into notes (its fields, `-[:@old]->`
picked, tested, filtered, counted, compared with the handle, walked twice,
a block over it), now and then a sleep. Each case compares every call the
CRM received, the writes exactly as the result hands them back (the
contract's write record: the handle's `old`, which only `-[:@old]->` reads,
never leaves the run, on either engine), the trace, the parked state byte
for byte and how the run ended; none differs, none is refused. Regenerated twice from the TypeScript engine, byte-identical.

### Language version 5: the port list

Version 5 (Dancing Wren, main's 4319a39f..e0736369) retires four constructs.
Every change is a checker refusal, so a version 5 program that uses one ends
at its check on either engine before a segment opens; what the engine itself
changes is one `since(v, 5)` conditional, and a version 1 to 4 program runs
exactly as before (the v1 to v4 corpora; the v4 corpus is this branch's own
live tests at c39a99d6, run under both engines).

| main's change | sha | on this engine |
|---|---|---|
| `write … bind` retired (`MOV_WRITE_BIND_RETIRED`) | eb334103 | nothing engine-side: the checker refuses it under 5; `write_bind` stays refused by admission for 1–4 |
| every `#` hop retired (`MOV_META_HOP_RETIRED`); `#transform` is the plugin called as a function | 274f7f98, 66d2a376 | nothing engine-side: the checker refuses it under 5; `traversal_meta_edge` stays refused by admission for 1–4; the function form is a plugin call, which runs |
| `delete` only of one stored record whose type's describe says `deletable: true` (`MOV_DELETE_NOT_DECLARED`, `MOV_DELETE_NOT_RECORD`) | 77a5b63c, f76e52bc | nothing engine-side: the checker refuses it under 5; `delete_not_record` stays as it was for 1–4. The catalog carries `PositionSchema.deletable` (the Rust reader declares it, so a snapshot carrying it still loads) |
| `_resources` only on an extraction's result (`MOV_RESOURCES_NOT_EXTRACTED`) | 0f522195, f76e52bc | a `_resources` head off the event or a system's record is refused under 5 with the TypeScript's own MOVENG_UNSUPPORTED (run.ts's message, byte for byte; crate::traverse `RESOURCES_RETIRED`), before the host is asked for the reserved reference or its `filesIn: "resources"` envelope; versions 1–4 read it as before, the mirrored quirk included; an extraction's resources are unchanged on every version |
| the knowledge graph's resources edge is matched by its reserved field id (`EdgeSchema.resources`) | 2cc63d78 | on every version: a hop over an edge the schema flags `resources` goes to the adapter's `getRelated` as the reserved `_resources` field id (kg.ts `surfaceReadAdapter`; crate::traverse `related_items_as`), and its landing's fields (`URL`, `Name`, `Type`) are read through `getFieldValue` as any landing's are. The catalog carries `EdgeSchema.resources` |

Main merge 10 brings two more, each a `since(v, 5)` at its point of difference:

| main's change | on this engine |
|---|---|
| a maybe-record (a record or data) handed to a position parameter is refused (`MOV_CALL_ARG_MAYBE_RECORD`, B15) | nothing engine-side under 5: the checker refuses it. For 1–4 admission no longer refuses it (`position_arg_record` above): it runs as the TypeScript runs it |
| a `parallel` / `race` receipt's slot holding one record reads as that record (B16; `MOV_RECEIPT_RECORD_SLOT` warns on the move up) | crate::reading `bare`: from version 5 a `Tuple` slot holding one record reads as the record (`record::held`), as a list literal's member does; versions 1–4 read it null, as before (rust_park_identity.unit.test.ts, with and without a park inside the arm) |

rust_dancing_wren.unit.test.ts holds the `_resources` head (versions 1–5,
and version 5 past a checker made to miss it) and the knowledge graph's
`Resources` walk (versions 4 and 5) to the TypeScript on both engines.

### What admission cannot decide

These depend on what a value holds, not on what the program says, and stay
mid-run failures ("Errors a run can meet mid-run" below): a record held in
a value handed to the host. A
name typed as a value may hold a record at run time (a member of a walk
read as a list), so
admission walks a collection op's function, a closure's body and a
movement's position parameters under every kind a value can carry there
(`Kind::Held`), and the run dispatches on the binding it holds. Two mid-run
MOVENG_UNSUPPORTED errors are the TypeScript engine's own, mirrored, and
are not refusals: a movement parameter typed against something that is not
an instance, and a trigger type other than webhook, poll, snapshot and
mutation — the TypeScript engine throws the same.

### The evidence

- **One log line per run**, at the decision point:
  `movement engine: engine=rust|ts run=<id> reason=<reason|admitted>`
  (`admitted` for a run this engine ran, to its end or its own failure;
  `shim_fault` for one the shim faulted; `mirrored_failure` for one this
  engine admitted that ended mid-run in the TypeScript's own
  `MOVENG_UNSUPPORTED`, which both engines end it with;
  `unreproduced_mid_run` for one that ended mid-run, after an effect, in
  this engine's own refusal of what the TypeScript runs on through (the
  `done`'s `unreproduced` marker, a divergence); `ended_at_check` for a
  Rust-routed run that failed
  its check, which no engine ran (`isCheckFailure`: MOVENG_LANGUAGE_VERSION,
  MOVENG_PARSE, MOVENG_CHECK; anything else the check throws is a
  `shim_fault`); `movement_engine_ts` when
  the run's route did not choose this engine). At info for a run routed
  here; at debug for one that was not.
- **`rustRunStats`** (rust_stats.ts): `notAdmitted` by first reason,
  `allReasons` by each statement's first reason in a run not admitted (one
  count per run per reason; "What admission walks"), and `declined` by reason;
  `routed`, the segments this engine started, its admission's refusals
  among them; `admitted`, those its admission let by (`routed` less the
  refusals); `ranWhole`, the runs it ran to their end (a run's own
  failure included); `mirroredFailure`, the admitted runs that ended
  mid-run in the TypeScript's own `MOVENG_UNSUPPORTED`, mirrored, and
  `unreproduced`, those that ended mid-run in this engine's own refusal
  after an effect (what admission should have refused: a divergence),
  neither counted in `ranWhole`, so the routing floors count only runs that
  ended as a run ends; `shimFaults`; `hostCalls` by `family.method`. The admission dry run
  runs nothing, so it has no such ending.
- **`GET /api/v1/system/engine-stats`** (system scope, like `/tg-runs`):
  `{engine, fallback, v5OnTs, uptimeSeconds, since, runs, evaluator}`, the
  settings and this process's counters
  since it started.
- **The admission dry run** (`rustRunStats.dryRun`, under `runs.dryRun` in
  engine-stats): every run, resume, race settlement and callback firing the
  TypeScript engine runs because
  its route did not choose this engine is also put to this engine's
  admission, without running it: under `by-version` only a version-5 one
  (under the emergency switch, or one the TypeScript engine parked), since
  versions 1–4 never reach this engine. The shim builds the segment input a real
  run would, calls the start entry, and reads the first step: a `refused`
  done is the verdict, and an admitted run's first step (`check.program`) is
  never answered; the segment is finished there. So the dry run makes no
  host call and changes nothing about the run, and a fault in it is counted
  (`faults`) and logged at warn, never thrown. It counts `firings` (runs it
  could ask about), `sampled` (runs it asked about), `admitted`, `first` (refused
  runs by the reason named first, the one a real run is counted by), `all`
  (refused runs by every reason named, once each: the engine's admission
  names each statement's first reason since chunk 7A's walk, so `all` counts the
  same reasons `rustRunStats.allReasons` does for a routed run) and `byVersion` (the same, by the run's
  pinned language version). It misses what admission cannot see: declines
  after the check (a lowering miss) and mid-run hand-backs.
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
| `builtins.function`, `builtins.compare` | a built-in reading this engine hands back (a pattern nested past 1,000 groups, `WITHIN` with the clock's answer) | the TypeScript member itself |
| `park.sink.commitTimerPark` | a `sleep` in a run that is not a rehearsal, on a host that serves it | `host.park.sink`; `wakeAt` is `clock.now`'s answer plus the sleep |
| `park.sink.commitLimitPause` | the first time the run meets its cost cap (a budget refusal, charged, that the ledger says is the cap), on a host that serves it and can suspend | `host.park.sink.commitLimitPause` |
| `park.sink.commitSuspension` | the flow suspends: at the statement that met the cap, before each statement of a paused run (`limitPaused`), at a `suspendAt` address; on a host that serves it | `host.park.sink.commitSuspension` |
| `control.cancel.cancelledNow` | the last check (not after a park) | `host.control.cancel.cancelledNow` |
| `llm.client.call` | each region of an extraction, once, and once more when its reply does not read ("Extraction" below); `{segmentId, system, userMessage, label, model, effort, maxTokens?, budget}` | `host.llm.client.call`, answered on the eval wire (`parsedJson` as `JSON.parse` left it); its cost charged |
| `llm.extractCall.call` | each extraction call (`extract(content, Shape, config)`, `extractOne(…)`), once, and once more when its reply does not read: `{system, blocks, label, model, effort, maxTokens?, segmentId, budget}`, the prompt as blocks — each content item one, a cache breakpoint at the end of the longest content prefix this run already sent at that model and effort and at the end of the content, the shape and the rules last (extraction_call.ts) | `host.llm.extractCall.call`, answered on the eval wire; its cost charged; traced `{kind: "extraction", form: "call", …, cache}` |
| `llm.transforms.invoke` | each `through` plugin per entity, and a plugin's plain call ("Plugin calls" below); `{segmentId, plugin, config, extractedContext, budget}`, the plugin by its registered name | `host.llm.transforms.invoke`, on the eval wire both ways; its cost charged |
| `files.resolveFileText` | each source file an extraction's `from […]` names, once per file; each content file of the run's extraction calls, once per run | `host.files.resolveFileText`, on the eval wire both ways (the file tagged `["F", descriptor]`; the host is handed the plain descriptor); its cost charged |
| `ids.mint` | an extraction's resources without ids, once per batch: the `from` text, each source file, the bundle pipeline's files, then every record's fetched files in the tree's order | `host.ids.mint`: `count` distinct texts, or the run fails |
| `lookup.resolveActingUser` | the first `@user_*` a segment reads, when the source's `methods` list `getActorCandidates`; `{triggerId?, instance, event, segmentId}`, the event on the eval wire | `host.lookup.resolveActingUser`; its answer kept for the segment, a host error read as no user (`resolveMovementActingUser`) |
| `adapters.call` `extractActor` | the first `@actor_*` a segment reads, when the source's `methods` list it | `host.adapters.call`; its answer kept for the segment, an error read as no actor (`resolveMovementActor`) |
| `llm.client.call` (`AI()`) | each `AI(prompt[, tier])` an expression evaluates: `{system, userMessage, label: "movement-ai-expression", model, effort?, maxTokens?, budget}` at the tier's settings (ai_tiers.ts `aiExpressionSettings`, a fixed table: no deployment input) | `host.llm.client.call`; its cost charged; the reply read out of its envelope (`aiAnswer`), traced `{kind: "ai", prompt, hasValue}` |
| `files.render` | each `FILE(content, type)`: `{segmentId, content, type}` | `host.files.render`, its descriptor back on the eval wire tagged as a file (`["F", descriptor]`) |
| `check.compatible` | `x IS <Decl>` of the event, a handle or a landed record: `{source, languageVersion, declaration, schema, recordType}` (the instance schema the record's type is read in) | the checker's `surfaceMisfit` over `schemaSurface(schema, recordType)` and the file's declaration (run.ts `evaluateDeclaredNodeTest`): `{fits}`, or `{undescribed}`, which stops the run as "can't tell" |
| `adapters.call` `invokeFieldFunction` | a function a write's destination field advertises (`describe`'s `functions`), called in that field's value: `{recordType, fieldId, functionName, args: {instructions, data}}` (`bindMovementFieldFunctions`) | `host.adapters.call` |
| `log.write` | the log lines the TypeScript engine writes (an extraction's skipped stage, a plugin's empty argument, a continued answer, a truncated file, a refinement kept), kept and sent as the statement's trace is handed over, so a line costs no yield inside a fan | the platform's logger, the run's id added; never the run's failure |

An origin id is an index in the run's own table (below): no host or result
sees one. Every id a host or a result sees comes from `ids.mint`.

**A lost run lease** is the run host's (docs/contracts/host-families.md "Failure"): the
cancel gate, or a park the lease fence refuses, throws `RunLeaseLost`; that
host error fails the run with the very object, and the run host's settle
recognises it. The engine never asks whether the lease is lost.

### Calls

`call.rs` is run.ts's `executeCall` → `runCall` for a movement the program
declares (exactly, or from version 3 in any letter case): a statement
(`persist(n: d)`), a bound call (`x = label(t: msg.\`subject\`)`, and the
construction spelling `x = persist(n: d)`), a returned one, a call among
another's arguments. The call is its statement's next step (`… .c k`); the
callee's scope forks from the file's; its arguments evaluate in the caller's
source order (a value parameter's as a value, with its trail; an inline
write as what it writes; a node literal as the node; a nested call as its
value; a position parameter's as the record its argument names, anything
else failing as `passing … as a movement argument`); its parameters bind in
declaration order; its statements are the run's own (the cancel gate, the
trace handed over a statement at a time); a match that finds nothing ends
the callee's scope, and the caller goes on. Its value is what it returned:
a `return` binds any right-hand side (`return n`, `return node { … }`,
`return f(x)`), as `declareAssign` does. Before version 3 a movement already
running is not called again (`recursive movement calls (…)`); from it the
depth is bounded by the deployment's `MOVEMENT_MAX_CALL_DEPTH`, which the
shim reads into the input (`maxCallDepth`), failing as `CallDepthExceeded`.

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
entity's fields. A WHERE on its hop fails the run as the TypeScript's does
(MOVENG_UNSUPPORTED); an ORDER BY, a LIMIT or an incoming direction is not
read, by either engine.

What stays the TypeScript engine's (refused, "Admission" above): returning a
record from a bound block, a park in a body. Heads of more than one hop and
heads off `_resources` run since PLAN-08A group D.

### Records held as values

A value may hold a record (chunk 7A Task 3): a member of a walk read as a
list, a closure's parameter (`bindingOf`, record.rs). Only an engine object
is one (`Js::Record`): a dict is data whatever keys it carries, a `kind`
naming a binding's included (chunk 7A Task 4b). Each is
read, compared, spread, written from, linked and walked as the TypeScript
reads that binding (`readBareName`, `traverseFrom`, `readBindingField`,
`compareRecords`, `spreadKeysOf`, `resolveTupleWriteTarget`,
`referencedRecords`), with V8's TypeError messages where the TypeScript
throws one. Records compare by identity, else by address. A field an
object lacks reads `Object.prototype`'s member, and a dict made text runs
V8's ToPrimitive over its own `toString` and `valueOf`. A
GROUPBY or KEYBY filing a member under `__proto__` sets the answer's
prototype (`JsObject::proto`): reads go through it, a list there makes
the answer's text a join, the answer is no dict (`isDictValue`), and the
eval wire carries the prototype (`["o", id, entries, prototype]`); a list
there answers `Array.prototype`'s names (`["f", "Array#<name>"]`) (a record
there leaves the answer a dict: no prototype makes data a record), and a
filing onto a list the prototype holds pushes onto that very list (lists
are shared and mutable, `JsArray::push`). The hops past a kept walk run inside it
(`resolveHeadIterations(walk.head, env, extraSteps)`): in the scope it
captured, so a WHERE there reads the names as they were when the walk was
kept, and breadth first across its origins, hop by hop, as the TypeScript
asks. A list that holds itself joins as V8 joins it (the repeated list is
empty text), is written by the JSON writers as `safeStringify` writes it
(its text, the fallback V8's circular-structure TypeError takes there) or
with its circles cut where the TypeScript never meets one, fails a park,
`TEXT.SERIALISE` and `plainValueOf` with the RangeError their recursive
writers end in, crosses the eval wire as shared references, and compares
by identity first (`deepEqual` over two that hold themselves differently
ends in the RangeError its recursion does). A
collection op's `onError` never forgives this engine's own refusal
(`ErrorClass::Unreproduced`). MAP, FILTER,
REDUCE, GROUPBY, KEYBY and MEMBERS run their members `concurrency` at a
time after a first batch of `initialConcurrency` (`runMembers`, chunk 7A
Task 6: each member a flow of its own, its trace spliced in member order,
a parked member holding its slot; `interpretCollectionOp`, its `onError`
and answer shapes; as calls from version 3). A park writes a held record as the TypeScript's `recordValue`
descriptor and refuses a function (MOVENG_PARK_NONSERIALIZABLE). On the
eval wire a built-in crosses as `["f", name]` and `Object.prototype` as
`["p"]`; a record whose binding object is data (the event, a callback, a
shape position, a resource) crosses to the host as `["x", id, descriptor]`
and back as `["x", id]`, and every object the host sends is data. A request
holding any other record is never made (`HeldRecord`, per request).
Pinned by tests/oracle/records.json: 4,407 cases, seed 20261010, run on the
TypeScript engine against an adapter that answers walks (`items`, `subs`,
two records named `__proto__`) and writes; the Rust engine ends each as the
TypeScript did (0 differ; 0 refused at admission, measured at PLAN-08A
group D, which ran the walks straight off a `lazy` binding that
`traversal_root` refused). About 3,000 of them hand the program a payload holding a
dict whose `kind` names a binding kind or an `Object.prototype` name, and
24 file a record under `__proto__` with KEYBY: since main's fix merged
forward (cloud-native into chunk 7A, forward merge 2) both engines read
each as the data it is, and these cases are what proves it.

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
  maps; V8's TimSort, so mixed key kinds land as JavaScript lands them),
  over a value, a walk read for a field, or (`COUNT` only) the
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
`runExtraction` around it, for `x = extract ["tier"] from […] { tree }`.
Every call the extraction makes asks for its tier's settings
(`extractionCallSettings`): with no tier the density heuristic's model at
`low`; with one, the built-in row (sonnet at `low`, `high`, `xhigh`) under
the input's `extractionTiers`, and the room a reasoning depth needs
(`maxTokens` 64,000 at `high` and `xhigh`):

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
recording; "Transition artefacts to mirror" below).

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
attached and its text under `text`, a `records` output one such node per
record it found, in its order (the empty list for none). A priced plugin is refused before the
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
written with. In a node literal, a declared edge (`companies: <Company>`,
`posted: <crm-[:companies]->>`) starts empty, carrying the declared node's
landing shape (its fields, and each nested node as an edge of its own, the
`extends` chain folded in as `inheritDeclaration` folds it); a traversal
entry (`files: msg-[a:files]->`, or with a per-item `node { … }` tail) is
walked where the literal stands, as a block head walks; a `lazy` entry
(and `x = lazy …`) keeps the walk, its scope captured flat
(`captureScope`), and runs it at every read: a block head over the edge,
`files.\`name\`` (each landing's field, collapsed), `EXISTS(files)`.
A graph of a declared shape (`graph<Company> { … }`, its `extends` folded
in) makes each child edge the shape declares, empty where the literal wrote
none, carrying the child's landing shape; orders its fields as declared;
reads a spread map's keys as children where the shape says so; and checks
the value built against the shape where a spread brought keys nobody could
type, and from version 3 always for presence (`graphValueMisfit`). A
record spread copies by the checker's plan, its planned edges walked one
hop on the node plane (a node's landings, a walked record's through its own
graph) and each landing copied by the edge's plan (`snapshotRecord`). An
expression reads a node's edge one hop deep (`walkMetaSteps`): a field
across its landings, `COUNT`, `EXISTS` with a WHERE scoped at each landing.

**The graph a run builds** (`local.rs`, local_edge_adapter.ts): a write, a
match or a position write into an edge of a node the run built runs the
ordinary write path (crate::write) over a store whose landings are the
edge's own — the same identity search, rules, judge, fill modes and
outcomes, the identity lock named for `local` and the edge (the host sees
it), the landing's own lock the run's alone (the host sees none). A landing
is its index on the edge; a create appends one of the edge's landing shape
(`landedOn` the edge), a merge updates it in place. The candidate block is
the store's: an exact component on normalised equality, a FUZZY one on a
shared distinctive word (`/[^\p{L}\p{N}]+/u` split, from src/letter_number.rs,
which tests/oracle/letter_number.ts writes from Node; kind words and a
domain's TLD dropped), at most 20 landings (`candidatesCapped`). A landing
that is a reference (a `link`ed handle, a walked record) is read live and,
matched, updated through its own system under its record and identity
locks, logged as that system's write. The firing log gets a `local` row,
uncommitted, with no external id; the statement binds the landing. `link
n -[:e]-> x` appends `x`. A block head over a node's edge fans out over its
landings, the hop's WHERE scoped at each (`hopFilterKeeps`; its ORDER BY and
LIMIT are not read, as `walkNodePlane` does not read them).

### Parks

`park.rs` writes `ParkedScopeState` version 1, and `resume.rs` reads it,
as serialize.ts and run.ts do, so a run parked by either engine resumes on
either (the both-engine tests write a state on each and compare the strings
byte for byte). One state is written for the whole run: the leaf's address
and binding (`presenceBind`, `until`), the scope chain root first, each
scope's own bindings in declaration order, then the frames, innermost last
(a call's site with its finished calls and the callee's scope, a collection
op's member, a combinator arm's join), with nodes and kept walks numbered
once across all of it, as one `serializeBinding` pass numbers them. Code a
state carries (a closure's body, a kept walk's head and mapping) is rebuilt
from the tree it carries, never found again in the program ("Parked code is
rebuilt from its tree", above). States cross on the eval wire both ways, so every
object keeps its key order.

A resume (`input.resume = {state, reenter?, answer?,
deferRaceSettlement?}`) descends the state's spine as `resumeAlongAddress`
does: `if` arms, block iterations and combinator branches by the address,
calls and members by the frames. It binds the answer (a `Correct` answer
rematerialised as an extraction), steps past or re-enters the leaf (a
re-entered statement replays its journalled calls), then finishes each
enclosing body. A branch that finishes closes its join through the host
(`persistBranchExport`, `decrementJoin`, `collectBranchExports`); the last
one runs the combinator's continuation, and a race's winner cancels its
losers' parks, inline or once per batch (`input.settle`, run.ts
`settleRaceFrame`). A fired callback's body runs from its captured state
(`input.fire`, `fireCallbackBody`).

**Awaits and arms.** A `parallel` or `race` runs its arms as flows on the
one executor: each keeps its own trace buffer and its slot in the write
ledger, spliced and renumbered in arm order when the combinator returns.
Effects take the in-run locks run.ts takes (a shared lock per type and key
set, exclusive per record and edge, FIFO in arrival order). An arm that
parks writes its state and its join; the arms that finish persist their
exports. A callback mints its row (`park.callbacks.mint`) and binds
`{kind: 'callback', …}`; awaiting it, a landing (`resolveAwait`,
`commitAwaitPark`) or an `until` parks as the TypeScript does.

tests/oracle/parallel.json holds this to the TypeScript: 398 seeded
programs (seed 20261011, written by generate.ts) of two to four arms, some
nested, that take every kind of the run's locks: writes `unique by` a key
two arms share, by two fields (another key-set group), FUZZY (the type
lock exclusive), updates of and links between records written before the
combinator (record and edge locks), links from the arm's own record (one
written per arm before the combinator), plain writes, and counts whose
WHERE names the arm (pushed to the adapter, so the request names it). Both
runs have the same scheduled host: adapter calls and cross-run locks are
answered one at a time, the run going as far as it can before the next,
the oldest step's request first and, among one step's, the least by its
text. A lock taken carries the request its flow made next, so the arm and
the key it was taken for are compared. 326 cases ask exactly the
TypeScript's requests in its order, with its ids. Two kinds of case may
differ, and each must still ask every request and no other, each arm in
its own order (its counts and its links from its own record included),
the movement's requests after the combinator after all the arms' (the
same requests on either side of the continuation's first write), with the
writes in ledger order and the same ending:
- 63 where two arms one step let run reach one in-run gate in modes that
  exclude each other (FUZZY against a key, two key-set groups, one key, one
  record or edge). The TypeScript's arms reach it in the order their
  microtasks let them, this engine's in arm order.
- 9 where two flows let through together ask the very same cross-run lock,
  one text a host cannot tell apart, answered the other way round.

Of those 72, 47 hold a count or a link an arm asked, so each is held to its
arm's order too (chunk 7A Task 6; before, a count, a link and the
continuation's write were held to nothing past the first difference).


A suspension (run.ts `suspendFlow`) writes `{version: 1, address,
bindingName: null, suspended: true, journal, scopeChain, frames?}` for the
flow at a statement's boundary, the journal the calls its statement had
finished. The flow suspends:

- **at its cost cap.** The engine refuses a priced plugin itself, before
  `llm.transforms.invoke`, once the run's own figures meet the cap (as
  run_context.ts `pricedCalls` does); no other priced call. The
  host refuses one once its budget is spent (the meter refuses when the run
  has spent at or past its cap), and that refusal, once its cost is charged,
  is the cap met if the ledger's own figures say so (`spent >= cap`, counted
  from `capBaselineMicrodollars`); otherwise the statement fails with the
  host's message. So the call that crosses the cap is kept, and the run
  pauses at the next priced call, just before its statement, as run.ts
  `suspendAtLimit` does, inside a block, a member or a callee as at the top.
  The first time, the run is marked paused
  (`commitLimitPause`, where the host serves it) and says so on its trace
  (`RUN_PAUSED_COST_CAP`); a sink that cannot suspend is not paused, and the
  run fails with `RunCostCapExceeded`.
- **before each statement of a paused run** (`limitPaused` in the input: a
  flow woken while its run's pause holds). A sink that cannot suspend lets
  the flow run on.
- **at a `suspendAt` address**, once each, before a statement or before its
  k-th call (`… .c k`). A sink that cannot suspend fails the run
  (`MOVENG_RUNTIME`).

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
  (parallel arms) have their reads in flight together. A unique by
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

These end a run partway through, where the TypeScript engine would carry
on. Each comes back as an error (the run fails), naming the construct; none
produces a different answer. One met before the run's first effect (a
write, a lock, a priced call, an id, a park, the trace handed over, a log
line) is a decline instead (`unreproduced`, "After the check" above): the
TypeScript engine runs the segment, having seen only reads.

- A plugin, a file reader or a model answers a value the eval wire cannot
  carry as itself (a `Date`, a class instance, a function), or an adapter
  answers a class instance or a function: `RustShimError` from the shim.
  (A `Date` an adapter or the event holds is its ISO text on both engines,
  transition artefacts row 13; a lone surrogate crosses as its code units,
  an own `__proto__` key as a key: rows 7 and 9.)
- A record held in a value reaching a host request admission did not
  foresee: MOVENG_UNSUPPORTED before the request is made (a backstop;
  admission refuses each route it knows, by name).
- Parking a value whose message or data would print a record's binding
  object other than the event's or a block's returned records' (its read
  seam, its computed schema): MOVENG_UNSUPPORTED.
- A file reader answering `unreadable` with a reason outside the four
  (`unsupported_type`, `bytes_unavailable`, `extraction_failed`, `no_text`):
  the host has broken its typed contract; the TypeScript traces the reason
  as given, this engine fails the run naming it (extract/resources.rs
  `resolve_file_text`).

None of the first three is a built-in's reading, so none can be handed to the
TypeScript member (`builtins.*`).

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

A text holding a lone surrogate is `["s16", [units…]]`, its UTF-16 code
units, wherever a text stands (a value, an object's key, a file's display):
two halves of a pair, sent apart, read as the pair. Both sides write it so;
each reads a plain string as well.

**The JSON text.** Every input, answer and output is JSON text read and
written as `JSON.parse` and `JSON.stringify` do: a string anywhere in it may
hold a lone surrogate as its `\udXXX` escape (a parked state's, a trace's,
an error's), which the engine reads (serde_json alone refuses it) and
writes back the same way.

**The input** (`engine_start`): `{entry: "segment", source, languageVersion,
movementName?, event, segmentId, credentialIds?, spend?, now, localZone?,
catalog, dryRun?, resume?, fire?, settle?, limitPaused?, suspendAt?, serves,
extractionFileChars?, maxCallDepth?, extractionTiers?, dryAdmission?}`. `segmentId` is the segment the run host opened (`segment.open`),
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
deployment's `EXTRACTION_FILE_CHARS`, 50,000 when absent); `localZone` is
the IANA zone a date-time text with no offset is read in, `now` among them
(the shim's process zone, verified against its `Date`; UTC when absent);
the engine holds no team (the shim names it on the engine's log lines, as the
host's own fact); `fire` and `settle`
run a callback body or settle a deferred race against `resume`'s state;
`maxCallDepth` is how many named calls deep a run may nest from version 3
(call_depth.ts, the deployment's `MOVEMENT_MAX_CALL_DEPTH`);
`extractionTiers` is what the deployment buys for each extraction tier
(ai_tiers.ts, its `EXTRACTION_TIERS` parsed: `{careful: {model?, effort?},
…}`, each member over the built-in row's; the built-in table when absent);
`dryAdmission` marks the admission dry run's start, which is never answered,
so a slot the lowering misses is named among its refusals.
Other members are ignored.

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
| `llm.extractCall.call {segmentId, system, blocks: [{text, cacheBreakpoint?: true}], label, model, effort?, maxTokens?, budget, wire: true}` | on the eval wire: `{parsedJson, rawText?, usage?, cost?}`, or a budget refusal |
| `llm.transforms.invoke {segmentId, plugin, config, extractedContext, budget, wire: true}` (`config` and `extractedContext` on the eval wire) | on the eval wire: `{text?, data?, records?, outcome?, cost?}`, or a budget refusal |
| `files.resolveFileText {segmentId, file, budget, wire: true}` (`file` on the eval wire) | on the eval wire: `{text, rawTextId?}` or `{unreadable, detail?}`, and `cost?`, or a budget refusal |
| `ids.mint {segmentId, count}` | `count` distinct texts |
| `log.write {lines: [{level, message, fields}]}` | `undefined`: the lines on the platform's log, the run's id added (the engine's own, like `check` and `builtins`) |
| `builtins.function {id, args, now, languageVersion}` | `{value}` or `{threw: {class: "MovementEngineError" \| "Error" \| "RangeError", code?, message}}`: the TypeScript member's value or what it throws; `id` is the lowered function id (`text.regex_extract`, `split`), `args` on the eval wire, the value too |
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
- `{refused: reason, reasons}`: admission refused the program, its input
  or its parked state on this engine's own parse; nothing was asked of the
  host. `reasons` is each statement's first reason, in the order met,
  `reason` first ("What admission walks");
- `{declined: reason}`: past the check, nothing the host can see has
  happened; run the program another way.

Beside any of the first three, `cost: [{source, microdollars}]` is what the
segment's priced calls spent, by source, for the run's account. Beside
`failed` or `thrown`, `unreproduced: true` says the error is this engine's
own refusal of what the TypeScript engine runs on through, met after an
effect (before one, the segment declines `unreproduced` instead): its
`error` is coded MOVENG_UNSUPPORTED, as the TypeScript's own failure this
engine mirrors is, so the marker is what tells a divergence from a mirrored
ending (PLAN-08A Task 1).

`error` is `{class: "MovementEngineError", code, message}` (`message` without
the `CODE: ` the TypeScript constructor adds), `{class: "Error" |
"RangeError", message}`, `{class: "RunCostCapExceeded", capMicrodollars,
spentMicrodollars}` (the cap met where the run cannot suspend; the shim
builds the TypeScript's error from the figures), or `{hostError: ref}`: the
error a host call failed with, by the `ref` its answer carried. A run that
suspends at its cap ends in a parked `result`.

## Mirroring JavaScript

The rule for what this engine reproduces of JavaScript:

- **The cheap core is mirrored exactly.** Numbers (`Number(text)`,
  `String(number)` through `ryu-js`, `Math.round`, `toFixed`, `%`), strict
  equality, truthiness, key order, UTF-16 lengths and comparisons. Each is
  pinned by the test the table above names.
- **The expensive tail is mirrored too, as it is retired** (Henry,
  2026-10-09: the TypeScript engine is retired and no language version is
  added for it). Each row below becomes the TypeScript's behaviour in Rust,
  under a `before`/`since` conditional where it differs by version, pinned
  by an oracle generated from TypeScript. Until a row is mirrored, this
  engine answers only what it reproduces and hands the rest back
  (`fallback`, `builtins.*`), or refuses or fails as the row says.

### Transition artefacts to mirror

Sizes are estimates (XS, S, M, L).

| # | the artefact | here today | the mirror | its oracle | size |
|---|---|---|---|---|---|
| 1 | the regex dialect | mirrored (chunk 7A Task 5): `js_regex` made complete and kept (lookbehind, named groups and `\k<name>`, Annex B's octal and `\c` escapes, a class escape at a range end, quantified lookaheads), with no budget, on an explicit stack so neither long texts nor nesting cost native stack; a group name spelled in ID_Start/ID_Continue read off Node (src/letter_number.rs). Residual: nesting past 1,000 levels hands back to the TypeScript built-in, since V8's own limit for capturing groups (between 8,000 and 10,000) depends on its stack | oracle regex.json, 7,209 cases (the 4,009 new from seed 8), none handed back | tests/oracle/regex.json (tests/stdlib_oracle.rs) | done |
| 2 | date parsing | mirrored (chunk 7A Task 5b): V8's parser ported step for step in crate::js_date, the ES5 form then the legacy one (keyword table, parenthesised comments, zone words, numeric orders, two-digit years, offsets), NaN where V8 gives NaN; a date-time with no offset read in the run's local zone (`localZone`, the shim's process zone; absent, UTC), ICU's reading of a skipped or repeated wall time included. `DATE`, `DATETIME`, `DATE.FORMAT`, `DATE.FORMAT_ISO` and the comparator's `<` between texts no longer hand back (ORDER BY never read dates: `compareOrderValues` orders as text) | oracle dates.json (6,000 seeded texts, seed 20261013, in UTC, Europe/London, America/New_York, Asia/Kolkata and Pacific/Apia: `Date.parse`, `DATE`, `DATE.FORMAT`, `<`; tests/dates_oracle.rs) | tests/oracle/dates.json (tests/dates_oracle.rs) | done |
| 3 | Unicode case mapping | mirrored (chunk 7A Task 5): Node 22.20's ICU 77.1 (Unicode 16), its tables generated into src/case_mapping.rs by tests/oracle/case_mapping.ts, the final sigma's cased and ignorable neighbours probed through `toLowerCase` itself; regenerate when the pinned Node moves | oracle case_mapping.json (4,000 seeded texts, seed 20261013, tests/tail_oracle.rs) | tests/oracle/case_mapping.json (tests/tail_oracle.rs) | done |
| 3a | the local edge's word split (`/[^\p{L}\p{N}]+/u`, FUZZY candidates) | src/letter_number.rs, generated from Node 22.20 (Unicode 16) by tests/oracle/letter_number.ts | regenerated with row 3's data whenever the pinned Node moves; the language's own Unicode version once one is named | none differential: the tables are generated from Node itself (tests/oracle/letter_number.ts) | XS |
| 4 | ORDER BY and `SORT` over mixed key kinds | mirrored (chunk 7A Task 5): V8's ArrayTimSort ported step for step (crate::order_limit: the minimum run, runs found and reversed, binary insertion, the pending-run invariants, `merge_lo`/`merge_hi` with galloping and the shared `minGallop`, the early exits an inconsistent comparator takes), so keys mixing numbers with texts land where JavaScript lands them at every length; the 64-record refusal is gone | oracle mixed_sort.json (400 seeded key lists, 1 to 2,000 keys, seed 20261014, tests/tail_oracle.rs; the stable merge it replaces got 317 of them wrong) | tests/oracle/mixed_sort.json (tests/tail_oracle.rs) | done |
| 5 | a reply field named after an `Object.prototype` member, and a declared `__proto__` | mirrored (chunk 7A Task 5) in crate::extract::validate: a declared key read through the reply's prototype (js.rs's one `Object.prototype` name table), a key handed on written with `object[key] = value` (`__proto__` sets the prototype), a declared `__proto__` no key of the shape; the emitted entity's fields read through that prototype. A field or node DECLARED `__proto__` (inline in an extraction, or in a node declaration: every such name is program text) is the checker's `MOV_SHAPE_FIELD_PROTO` (chunk 7A Task 6, a bug fix without a version: past the read the TypeScript's entity never held it as a field, its context's prototype was set from the reply's `__proto__.value`), so the run ends at the check on either engine; the validator's reading of a declared `__proto__` stays, pinned by the oracle's spec trees, which no checked program now reaches | oracle extraction.json, every program 0 reply pinned to TypeScript's verdict unfiltered (tests/extraction_pin.rs) | tests/oracle/extraction.json (tests/extraction_pin.rs) | done |
| 6 | a reply number above the double range | refused as zod refuses it | nothing: over a JSON host it is `null` on both engines; documented | none: the oracle's replies are JSON text, which cannot hold the number; pinned by `validate::tests` and rust_extract.unit.test.ts on both engines | 0 |
| 7 | a host's value (an event, an adapter's, a plugin's or a model's answer, a parked state) holding an own `__proto__` key or a lone surrogate | mirrored (chunk 8A Task 8). An own `__proto__` key: the eval wire carries it as a key both ways (rust_wire.ts writes it, and reads it back with `Object.defineProperty`, never `object[key] = …`; env.rs holds it as an own entry), a read of it reads the own value, and every copy path assigns where the TypeScript assigns (`Object.assign` in a spread and in a record plugin's data, `object[key] = …` in a park's map, its rehydration, `withFileFields`, `fileFieldsOf` and `plainRecordOf`), so a `__proto__` key there sets the prototype on both engines, and keeps it own where the TypeScript spreads or `JSON.parse`s. A lone surrogate: carried whole, row 9 (the shim's `uncarried` and this engine's refusal of it are gone) | done | apps/api's rust_wire_round_trip.unit.test.ts (an event field, an adapter's answer, a record and a records plugin's answer, an `AI()` reply, an extraction reply, a park and both resumes, the HTTP host double; both engines; the `__proto__` cases and the lone-surrogate cases) | done |
| 8 | extraction call-site numbering | numbered as the TypeScript numbers it | already mirrored; a test with a slow host to pin it | none: the recorded runs (engine-runs.v1/v2) hold the order; the call-site allowance names the cases that depend on it | 0 to S |
| 9 | a string holding a lone surrogate (a host's answer `JSON.parse` made, a cut through a pair, `split("")` or a match through an astral character) | mirrored (chunk 8A Task 8b): crate::js_string holds any run of UTF-16 code units, a lone surrogate in-band (U+FDD0, then a plane-16 private-use character naming the unit), canonical so equality is `===`; the eval wire carries it as `["s16", units]` (env.rs, rust_wire.ts), the host JSON text as the `\udXXX` escape (`read_json_text`/`write_json_text` at lib.rs, abi.rs, env.rs and the environment import, since serde_json refuses the escape); every cut keeps the half on its side (80, 200, 300 units, 1,000 units, a file bounded for the prompt), `split("")`, a regex and a records plugin's text spread read code units, `Date.parse` reads them. Retired: `refuse_uncarried`, the file text's and the `AI()` reply's uncarried refusals, the extraction reply's unreadable issue, the `AI()` trace cut's refusal, the astral-text records spread's refusal, the shim's three writer refusals and `uncarried`, the `builtins.function` hand-backs for `split("")` and a match through a pair. The program source is read in the same form, and the parser (crates/movement-parser `util::form`, shared with this crate) reads its code units, so a span counts what the TypeScript parser counts: a source holding a U+FDD0 or a lone half parks and resumes alike on both engines (fix round 1; before it, a source holding a U+FDD0 parked a closure one column late). `JsString` reads its text only through unit-aware operations and `as_form()`, the named read of the form (no `Deref` to `str`). Shared with the TypeScript engine, not a divergence: a parked state holding a lone surrogate is refused by the park store's Postgres `jsonb` (the parked-run tables), which refuses the `\udXXX` escape, on either engine alike | strings.json (10,572 seeded cases, seed 20261016: the built-ins, the comparator, every cut, `JSON.stringify` and the JSON text boundary, byte-identical regenerated) and stdlib.json (the two formerly handed-back cases); rust_wire_round_trip.unit.test.ts, rust_extract.unit.test.ts | tests/oracle/strings.json (tests/stdlib_oracle.rs) | done |
| 10 | a fractional `EXTRACTION_FILE_CHARS` | mirrored (chunk 7A Task 5): the shim passes the deployment's number as written; the text is cut where `slice` truncates it and the marker and the trace's `chars` print the number itself (`first 2.5 of …`) | oracle file_bound.json (seed 20261012, tests/tail_oracle.rs) | tests/oracle/file_bound.json (tests/tail_oracle.rs) | done |
| 11 | records held in values, `Object.prototype` field reads, identity comparison of records, a dict made text (V8's ToPrimitive) | mirrored (chunk 7A Task 3): `Js::Record` the only record, one `Object.prototype` name table (js.rs), V8's TypeError messages; residuals in "Errors a run can meet mid-run". The structural binding emulation (a dict whose `kind` names a binding's read as that binding, `Binding::Shaped`) is deleted (chunk 7A Task 4b): data is never an engine object | oracle records.json (4,482 whole programs, seed 20261010, tests/records_oracle.rs; regenerated from the fixed TypeScript engine by forward merge 2, so the payloads shaped like engine objects prove both engines read them as data) | tests/oracle/records.json (tests/records_oracle.rs) | done |
| 12 | `__proto__` keys in values and literals; `-0` and `Infinity` literals | literals run (PLAN-08A Task 2): a folded `-0` literal is `0` on both engines, a literal's `__proto__` key assigned (the prototype on the eval wire's fourth `o` member, both ways); an own `__proto__` key in host data is row 7's | nothing more for literals | tests/oracle/patterns.json (`static_number`, `proto_key`: whole, exact); rust_values_cross.unit.test.ts (the host's input by `Object.is`, prototypes kept) | done |
| 13 | a `Date` an adapter answers | closed (PLAN-08A group F′, Henry's ruling): a `Date` the event or an adapter's answer holds is its ISO text (`null` when invalid, as a park's JSON makes it) on BOTH engines, made at the engine's side of the host boundary (apps/api host_adapter.ts `isoDates`: the TypeScript's adapter stand-in and every run entry's event; the shim's `adapters.call`), so no `Date` is on the wire and `event_field_dated` is retired. No version: no in-process adapter answers a `Date` today (every date-typed field arrives as text: the HTTP clients' JSON, Slack's `ts` and the system adapter's stored events made ISO, Telegram's `linked_at` made ISO; Airtable's and Sheets' `Date` handling is on writes), so no saved program's text, comparison or park changes | nothing more | rust_write.unit.test.ts (a `Date` in the event and in an adapter's record: interpolated, compared against the ISO text, parked, on both engines) | done |
| 14 | a `#` edge's restamp (kg.ts) | `traversal_meta_edge` refused | the read wrapper's pass-through without restamping | none: refused at admission | — |
| 15 | identity of host objects across host calls | in process only: the segment's wire hands an object the host sent back as that object (`["i", id]`), and an object the host sends again UNCHANGED, under the id it was first sent under, decodes as the one object already held; an object the host MUTATES between two answers decodes fresh the second time, where the TypeScript holds the one object (see "Known divergences") | nothing for a remote host: it serves JSON shapes, so identity across calls is not part of the contract | none: rust_engine.unit.test.ts pins the identity the wire keeps, and rust_write.unit.test.ts an answer mutated between re-sends | — |
| 16 | two names for one write handle across a park | mirrored (main's B7, then this crate): a park writes one handle once (`ParkWriter`'s handle table, `Rc::ptr_eq`) and a second sighting as `{kind: 'handleRef', id}`, the first descriptor carrying the `id` (written last, as serialize.ts back-patches it: a state whose handles were numbered is written a second time with the numbers known); the reader makes the one handle from the descriptor that numbers it, whichever it reads first, and refuses a reference no descriptor numbers. A completed branch's export is one park, `#return` first. A state holding each handle once is written byte for byte as before. Main's R1, mirrored at main merge 10: the reader (`ParkReader::over_state` / `over_descriptor`, serialize.ts `indexState` / `indexDescriptor`) indexes every numbered handle AND node descriptor in the whole state by the descriptor's structure (a scope's `bindings`, a closure's `captured`, an edge map walked as maps of descriptors whatever the author named them; a code member skipped only on the kind that has it), and a reference read before its descriptor (the movement scope's frame copy, parked inside a call) reads that descriptor whole, its `old` included, and marks it read; a node is registered before its edges are read. The writer is unchanged | nothing more | rust_park_identity.unit.test.ts (park on each engine, resume on each, the parked states and exports byte-identical: `b = a`, `b = write a { … }`, `-[:@old]->`, a branch completing on the resume; R1: a handle and a node parked inside a closure's call under each name like a descriptor member, a capture, an `@old` read through a reference first) | done |
| 17 | which members of a parked state the shim's file walk reads into (rust_wire.ts `filesInParkState`) | a name list (`PARKED_DATA_MEMBERS`) of descriptor members that hold data: a future descriptor whose new data member is left off the list is walked into, and a file-shaped object in that data would be made a file (a file revived from data) | a walk typed per descriptor kind, reading only the members park-state.md says hold a file | the park-state round trips (rust_write.unit.test.ts) with a descriptor of every kind holding a file-shaped object in its data | S |

#### The rows in detail

Neither row 3 nor row 4 can be met any more:

- **Row 3 (mirrored): case maps as Node's ICU maps it.** Rust's own
  tables follow Unicode 17 and differed from Node 22's (Unicode 16) on
  characters whose properties changed between the two: U+0295 (ʕ) is cased
  for the final-sigma rule in Node and not in Rust, so `"ΑΣʕ"` lowered to
  `αςʕ` here and `ασʕ` in TypeScript. The tables are now Node's, pinned to
  Node 22.20 (ICU 77.1); a Node upgrade that moves ICU regenerates them
  (tests/oracle/case_mapping.ts), and the oracle says what moved.
- **Row 4 (mirrored): mixed keys sort as V8 sorts them.** The sort was
  V8's binary insertion up to 64 items and a stable merge past it, which
  agrees with V8 for every total order; keys mixing numbers with texts are
  not one (the comparator has cycles), so past 64 V8's merge alone decides
  where records land, and the run failed rather than order them otherwise.
  crate::order_limit now runs V8's TimSort itself, galloping included, so
  the order is V8's at every length.

What each of rows 1, 2, 4, 5 to 10 does today, in the TypeScript and here
(written when these were to be specified by a language-version bump; the
mirror replaces that plan):

  - the regex dialect (mirrored, row 1: `js_regex` is kept and reads the
    whole of V8's flagless dialect);
  - date parsing (mirrored, row 2: V8's parser, and local time read in
    the run's zone);
  - Unicode case mapping: which Unicode version the language's case tables
    follow, so neither engine's runtime decides it.
  - a hop's ORDER BY, and a `SORT`, over keys of mixed types (mirrored,
    row 4: V8's TimSort decides where a record lands, here as there).
  - a reply field named after an `Object.prototype` member
    (`constructor`, `toString`, `hasOwnProperty`, `__proto__`, …), mirrored
    (row 5): zod reads a declared key through the record's prototype, so a
    reply that leaves such a field out hands zod a function, which fails the
    call (`expected object, received function`, at the field, or at the
    first record of a child node so named); and zod hands each key on with
    `object[key] = value`, so a `__proto__` the reply writes becomes the
    record's prototype instead of its key (an object or `null`; any other
    value is dropped). zod never validates a field a declaration DECLARES as
    `__proto__`: building the entity's object schema assigns
    `shape.__proto__`, which sets the schema's prototype instead of a key,
    so whatever the reply writes there passes unchecked, and the field is
    missing from the keys the "answered under keys none of which it
    declares" check counts as declared (and from that check's message).
    crate::extract::validate does each of these, and the oracle pins every
    such reply to TypeScript's verdict as it stands. Past the read, the
    TypeScript stores a declared `__proto__` field as its entity's
    prototype too: the entity never holds it as a field, its context's
    prototype is set from the reply's `__proto__.value` (an object) or lost
    (`null`), and its provenance's likewise. The name is program text, so
    the checker refuses it (`MOV_SHAPE_FIELD_PROTO`) on either engine. A reply's own
    `__proto__` key crosses the eval wire as a key (row 7), and the
    validator assigns it as zod does.
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
  - a fractional `EXTRACTION_FILE_CHARS` (mirrored, row 10): the
    TypeScript compares the text's length with the number as written, cuts
    at `slice`'s truncation of it, and prints it in the marker ("first 2.5
    of …"); this engine takes the same number from the shim and does the
    same.

### Known divergences

Where this engine differs from the TypeScript engine on a program that
checks and that admission lets through. A refusal or a hand-back is not
one: the TypeScript engine runs that program, or answers that reading. A
mid-run failure where the TypeScript engine carries on is one, and every
such failure still reachable is listed here with its reason and what
closes it. Each fails the run naming what it met (MOVENG_UNSUPPORTED,
marked and counted `unreproduced`, unless the table says otherwise); met before the
run's first effect it declines instead (`unreproduced`), and the TypeScript
engine runs the segment.

**Answers that may differ (Henry's ruling, 2026-10-12):**

| the reading | how it may differ | why it is kept |
|---|---|---|
| `CHUNKS(text, { entities: n })`'s cut and its trace's `expectedEntities` | the estimate reads `\p{L}`/`\p{N}` from the table Node's own answers wrote (crate::letter_number) and `\p{Lu}` from Rust's `Uppercase` narrowed to letters (the TypeScript's regex reads Unicode's `Lu`), so on text with an uncommon uppercase letter a proper-noun run may count differently and a piece boundary move by a line. The size mode, the links and the list items are exact | a regex dialect grown for one estimate was ruled out; tests/oracle/chunks.json holds the size mode on any text and the entities mode on ASCII text |
| the order of edge names inside a stored copy plan (a parked closure's graph spread, `edges` in `{ fields, edges }`) | the TypeScript writes them in declaration order, this engine in sorted order (the wire does not carry the declaration order, program.rs `copy_plan_js`); the park is byte-equal across engines everywhere else | Henry's ruling, 2026-10-14: the order is not significant, a copy plan's edges are a set, so a state parked by either engine resumes on either |

**Mid-run failures where the TypeScript engine carries on:**

| the failure | why this engine stops | what closes it |
|---|---|---|
| a plugin, a file reader or a model answering a value the eval wire cannot carry as itself (a `Date`, a class instance, a function), or an adapter answering a class instance or a function: `RustShimError` from the shim | a backstop: none is known to answer one (a `Date` an adapter or the event holds is its ISO text on both engines, row 13) | the host's typed contract (a ruling could make the TypeScript refuse it too) |
| parking a value whose message or data would print a record's binding object other than the event's or a block's returned records' | a backstop: the park would write the TypeScript's internals (its read seam, its computed schema), which this engine does not hold | admission refusing each route that reaches one, by name, as each is found (none is known) |
| a record held in a value reaching a host request admission did not foresee | a backstop: MOVENG_UNSUPPORTED before the request is made, where the TypeScript hands its host the binding object (which a real host refuses mid-run itself) | admission refusing each such route by name, as each is found (none is known) |
| a file reader answering `unreadable` with a reason outside the four (`unsupported_type`, `bytes_unavailable`, `extraction_failed`, `no_text`) | the host has broken its typed contract; the TypeScript traces the reason as given | nothing on the engine's side: a host fault (a ruling could make the TypeScript refuse it too) |

The corpora's `mirroredFailure` runs (v1 6, v2 6, v3 4; their
`unreproduced` is 0) are none of these:
each is a corpus case pinning a failure both engines end the run with (an
unadvertised `DOMAIN_OF`, a file-level extraction, a callback with no sink;
in v1 and v2, a recursive movement call and a value handed to a position
parameter).

**Contract note: a write record carries no `old`.** Under version 4 a write
that found its record holds the record as it stood (`-[:@old]->` reads it).
The TypeScript keeps it on the handle as `old`, the engine's own handle
object (its instance, adapter, credential name and schema). The run's result
hands back the contract's write record (packages/engine-contracts
write_record.ts), which has no `old`: the TypeScript strips it where the
result is assembled, and this engine never puts it there. Neither engine's
result differs for it, and the conformance recorder records such a run.

**Held back by decision:**

| construct | the TypeScript | this engine | why held |
|---|---|---|---|
| when flows woken together ask the host again (collection members, `parallel` arms: "Concurrent flows" below) | each continuation runs its microtasks to its next request; flows that do different non-host work before it (a taken `if` arm against an untaken one, an `else` arm against the `then` arm) reach it in different numbers of ticks, so the host may answer the first before the second asks | the shim hands every settled answer over before serving what it leads to, so flows woken together ask together | the request paths and answers are the same and the conformance kit's rule matches them; the order the requests are made in differs, and with it which answers came before each (`after`). Example: TypeScript asks `getRelated`, `describe`, `describe`, `getFieldValue`, `locks.acquire`; this engine asks `describe`, `describe`, `getRelated`, `locks.acquire`, `getFieldValue`. Ruled not a defect: a real host's latency makes this order nondeterministic anyway, and reproducing it would mean counting V8's microtask ticks per code path (2 of the generator's 153 compared programs) |
| an object an in-process adapter answered and then MUTATED before answering it again | holds the one object: a later read, `IN` or `CONTAINS` sees the mutation through every name holding it | decodes the second answer fresh: names bound to the first answer keep its old contents | parked (Task 3 review): only an in-process adapter that mutates what it already returned can produce it; a protocol-v2 adapter answers fresh JSON each time, so cannot; no corpus program does |

### Concurrent flows

Collection members (`concurrency` > 1) and `parallel` / `race` arms run as
futures polled together (`join_all`); a member slot takes the next member as
its own finishes, as `runMembers`' slots do. The shim answers the engine one
settled request at a time, but hands over every answer already settled
before it serves any request those answers led to (rust_engine.ts
`driveEngine`): the TypeScript engine runs each continuation an answer wakes
before the host is asked anything further, so flows woken together ask
together, and the host sees the same requests with the same answers before
them. What is left is the microtask depth of each continuation: flows doing
different non-host work before their next request can ask in a different
order, which a real host's latency makes nondeterministic anyway (Known
divergences above).

## The check

The checker is still TypeScript, so a segment asks for it: `check.program
{source, languageVersion, upgradingFrom?}`, checked against the run's own
snapshot (the host holds it; the segment was handed the same), answered
`{diagnostics, link?, stamps}` by apps/api's program_check.ts (the same check
every TypeScript run passes). A program that fails it never gets an answer:
the host ends the run with MOVENG_CHECK (or MOVENG_PARSE,
MOVENG_LANGUAGE_VERSION), exactly as the TypeScript engine throws before it
runs anything. In process the run host checks before it opens the segment
(run.ts), as the TypeScript route does, and answers the request from that
check: a program that fails it has made no host request on either engine.
The request carries no segment, so an embedder may answer it, or check,
before its own `segment.open`.

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
MOVEMENT_ENGINE=rust pnpm test:conformance:v2                       # the whole corpus (v1, v2, v3 alike): routing floors apply
MOVEMENT_ENGINE=rust pnpm test:conformance:v2 --testPathPattern refs  # one file: no floor, every other check
MOVEMENT_RUST_RUNS_BY_FILE=1 MOVEMENT_ENGINE=rust pnpm test:conformance:v1  # per-file routed counts
```

The teardown prints `Rust evaluator: {…}` (expressions not admitted,
admitted, answered, fallbacks by reason), `Rust runs: {runsRouted,
runsAdmitted, ranWhole, mirroredFailure, unreproduced, shimFaults,
endedAtCheck, declined, hostCalls}` (routed counts the segments admission
refused too; admitted does not), every count with its denominator (`Rust
runs, ran whole N of M runs attempted (…)`: each run the Rust route was
entered for ends under exactly one of these), `Rust runs not admitted:
{reason: count}` (by first reason, largest first), `Rust runs not
admitted, every reason: {reason: count}` (each run counted under each
statement's first reason) and a `Rust ceiling (<corpus>):` line per
ceilinged class, its count beside its ceiling. The endings:

- `ranWhole`: the engine ran it to its end, its own failure included;
- `mirroredFailure`: admitted, then ended mid-run in the TypeScript's own
  `MOVENG_UNSUPPORTED`, which this engine mirrors: both engines end the
  run so, and every corpus case that ends so pins it;
- `unreproduced`: admitted, then ended mid-run, after an effect, in this
  engine's own refusal of what the TypeScript runs on through ("Errors a
  run can meet mid-run"; the `done`'s `unreproduced` marker): a divergence;
- refused at admission by name (`notAdmitted`, the shim's input checks
  among them) and `declined`: the TypeScript engine ran it;
- `endedAtCheck`: it failed its check, which the Rust route makes before
  the segment opens, as the TypeScript route does ("Admission" above): it
  never reached this engine, and ends the same on either;
- `shimFaults`: a fault of the shim's own.

It fails a run in which Rust answered nothing, admitted runs none of which
ran whole, any decline outside the lowering's misses or any shim fault, a
whole-corpus run whose `ranWhole` is under its routing floor (v1 1030, v2
1260, v3 2215: the measurement, with no margin), or any run with a class
over its ceiling. Any filter (a
path or name pattern, related or changed files, a shard, positional paths)
makes a run partial, and the floor does not apply to it; a ceiling is an
upper bound, so it applies to every run.

**The ceilings** (PLAN-08A Task 1): the most runs each corpus may end in
each class that is not a run this engine ran. Each starts at its count when
set (2026-10-12) and only falls: a task that closes a reason lowers its
ceiling, and a reason a closed one hid inside the same statement gets its
own ceiling at its first measurement. Floors and ceilings move together
with the measurement, never with a margin: a task that lifts runs raises
the floors to its new measurement in the same commit. Zero refusals is
every ceiling at 0.

| class | what it counts | v1 | v2 | v3 |
|---|---|---|---|---|
| `refused` | runs refused at admission by name, under each run's first reason | 10 | 19 | 79 |
| `everyReason` | the same runs under each statement's first reason, by reason (a reason not named: 0) | 10 | 21 | 88 |
| `declined` | runs declined after the check before any effect, by reason (a reason not named: 0) | 0 | 0 | 3 |
| `unreproduced` | runs that ended mid-run in this engine's own refusal: a divergence | 0 | 0 | 0 |
| `shimFaults` | runs that ended in a fault of the shim's own | 0 | 0 | 0 |
| `handBacks` | what a run still asks the TypeScript to compute: `builtins.function` and `builtins.compare` calls, and the evaluator's `fallback`s | 0, 0, 0 | 0, 5, 0 | 0, 5, 0 |
| `evaluatorNotAdmitted` | expressions the evaluator switch kept for the TypeScript evaluator, never sent to Rust: mostly the TypeScript engine's runs asking it, so it falls as refused runs fall | 79 | 97 | 580 |
| `mirroredFailure` | runs that ended mid-run in the TypeScript's own `MOVENG_UNSUPPORTED`, both engines alike: held where measured, as a port may change one | 6 | 6 | 4 |

Zero refusals is not zero TypeScript until the hand-backs are 0 too. The
other gates for zero sit beside their own tests: the binding × consumer
matrix's refused cells per version (rust_admission_matrix.unit.test.ts:
2 / 2 / 7 / 7), the recordings the Rust replay target skips, by the skip's reason
(engine_runs_replay.ts: v1 12, v2 22 in all, `{}` at 0; its floors 431 and
520, the measurement), where every recording that encoded a fixed bug is
accounted for as itself, run and diverging where the bug says or skipped
(v2's one is among the skips today), and the patterns oracle, whose
`by_contract` (both engines refuse by the park-state contract) and
`unrecordable` (the eval wire cannot carry the input) are not ports left
to make, and which fails a program refused or declined for a reason the
port list has retired.
