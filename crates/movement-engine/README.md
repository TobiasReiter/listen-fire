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
| `park` | `ParkedScopeState` v1 written and read as serialize.ts writes and reads it |
| `bindings` | what a name in a run is bound to, the lexical scopes (in declaration order), the source `Position` |
| `trace` | the `MovementTraceEntry` kinds a run appends (`warning`, `gate`, `field_miss`, `block`, `extraction`, `plugin`), and the per-flow buffer they wait in until their statement ends |
| `program` | the pinned source parsed, joined with the `check.program` host call's answer: diagnostics, the import link, the checker's stamps by AST path; the declarations (`Declarations`: the root's and each library's shapes and `type`s, each shape with the file that wrote it, and the plugin imports, by local name) |
| `extract` | the extraction keyword (`x = extract from […] { tree }`): the spec resolved per firing and the calls planned over it (`spec`), each call's system, user and retry messages (`prompt`), a reply read as zod reads it (`validate`), the content read and fetched as resources (`resources`), what it yields (`emission`), and the walk — the model loop, `through` stages, fences, the trace (`run`) |
| `plugin` | a plugin called plainly (`page = fetch_url(url: …)`): its arguments, the invocation timed and priced, what it binds by its declared output |
| `env_services` | `EnvServices`: zones, WHATWG URLs, locale numbers and Unicode normalisation, from the JavaScript runtime (WASM) or natively (below); never a clock |
| `filter` | packages/shared/expression/filter.ts: `compareValues`, `compareToNull`, `evaluatePredicate` |
| `env` | value bindings in scopes with a parent chain; the wire values and trails cross on, and a segment's one wire with its host |
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
  ids the engine names. So a value an adapter answered (a
  `FileRef` read off a landing, carried in a node into a callee's write)
  reaches the next host call as the object it was, as in the TypeScript
  engine; anything the engine built is written out.

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
| a dict whose `kind` names a binding kind | read as a record, as `bindingOf` reads it (`kind in describeBinding` walks the prototype chain, so `"toString"` and `"constructor"` count); its reads, `==`, spreads and record arguments are the TypeScript's for that kind | `record::tests::*`, `records_oracle::records_held_as_values_read_as_the_typescript_reads_them` |

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
- **No entry picked** (none named and more than one movement, or a name the
  file lacks): every movement is walked. The run throws MOVENG_NOT_FOUND
  after the check on either engine anyway.
- **A call reaches its callee, which is walked** (`admit::walks`), once per
  signature: what each argument binds its parameter to at the call (a value
  for a value parameter — `<text>`, `<number[]>`, a declared `type` — else
  the record the argument names: the event, a handle, a node, a walked or
  extracted record, what a node's edge holds), worked out from the call
  site's own bindings, transitively. A call's value is the one kind the
  callee's returns share under that signature (`Callees::returns`); a
  value of more than one kind, or one a recursion leaves open, refuses the
  call (`movement_call`). A position parameter handed a value fails the call
  before the callee runs, on either engine, so that call adds no walk. The
  entry, and any movement no call reaches, takes its parameters as the
  event. So admitting calls admits no unwalked callee: every body a call can
  enter is walked under every binding a call gives its parameters, and a
  combinator's arm or a closure still refuses where it stands.

The walk does not stop at a reason. Each statement is walked whatever the
one before it needed, an `if`'s arms past its condition, a block's body past
its head. A refused `done` carries every reason met, in the order met, each
once (`{refused: <first>, reasons: [<first>, …]}`). The input's and the
parked state's reasons follow the program's. The first is the one a walk
that stopped there would give; `rustRunStats.notAdmitted` counts each run
under it, and `rustRunStats.allReasons` under each reason the run holds.
One exception: `movement_value_param` is noted with its own movement, after
the file-level reasons, so for a program holding both its first reason can
differ from the walk before chunk 7A's.

### The port list

Every reason below is a construct, input or state this engine does not run
yet, and so a port toward zero refusals: what the TypeScript engine does
there is the specification, mirrored here. Each is a stable snake_case
string: the one log line per run names the first, and `rustRunStats` counts
it (`notAdmitted` and `allReasons` for the first two places, `declined` for
the third). "Needs" says what this engine must gain to run it. A size is
given where one was estimated (S, M, L); the rest are unsized. The
constructs this engine already runs are "The run" below.

**The file** (admission):

| reason | the construct | needs |
|---|---|---|
| `import_from_file`, `import_from_<namespace>` | an import from a library file, or from a namespace other than `adapters`, `credentials` and `plugins` | the file scope from the check's `link` (imported movements and shapes, `libraryShape`/`shapeChain`), calls into library movements |
| `file_assignment` | a file-level binding that is neither an instance construction nor a value (a file-level `extract`, node, graph) | file-level evaluation of those right-hand sides |
| `file_call` | a file-level construction or call spelled with a movement's or a plugin's name | `fileLevelCall`'s semantics (a call with no event) |
| `file_statement:<kind>` | any other file-level statement, by the AST's `kind` (`write`, `call`, `match`, …) | statements at file scope |
| `movement_value_param` | a reached movement taking a value (`n: <number[]>`) | a parameter binding kind that is a value, with the checker's coercion rules for it |

A source this engine's parser refuses goes on to `check.program`, whose
own MOVENG_PARSE ends the run, as the TypeScript engine's parse ends it (the
binding × consumer matrix's 24 `graph<Entry> { ?...e }` cells under version
3: both parsers refuse a fill spread in a graph literal).

A file-level `node <Name> { … }`, `type`, `import … from plugins` and value
(`rules = "…"`) are admitted: each binds a name and runs nothing, as
`interpretFileStatement` does. A file-level value is walked as a body's
expression is, reading only the file-level values before it; a body reads
it as a value. A declared shape's words are walked in the file's scope (an
extraction reads them there). An extraction reads a shape and a type, and a
plugin call a plugin, an `IS` test a node declaration, and a declared edge
(`kids: <Kid>`) the landing shape its writes mint; what else reads one is
refused where it stands (`is_test_declared_record`).

**Names** (a reached body):

| reason | the construct | needs |
|---|---|---|
| `name_shadowed` | a body binds a name the movement's parameters or the file bind | the TypeScript's environment rebinding rules (what a later binding does to an earlier one) |
| `name_rebound` | a body binds one name as two kinds (a value and a handle, …), or twice where one binding can see the other (in one scope, or in a scope and one inside it); names are scoped lexically, so two blocks may reuse a hop alias, and two arms or two block bodies a name | the same rules |
| `name_not_value` | a plugin call's argument naming bare a name that may hold something other than a value (the event, a handle, an instance, a node, an extraction's record) | what the TypeScript hands a plugin for a binding |
| `plugin_arg_record`, `builtin_arg_record`, `write_field_record`, `extract_from_record` | a record (other than the event, whose binding object is the data `{kind: 'event'}`) that may reach, inside a list or a map, a plugin's argument; any record reaching a reading this engine may hand back to the TypeScript member (`builtins.function`: a date, a regex, a split), a system write's or match's field, or an extraction's `from` datum written into the prompt. Admission follows what each value holds — free of records, one record whose fields are data, a map or a list of them, or anything — through bindings, collection ops' parameters and answers, bound blocks, node literals and local writes, and parameters typed as scalars | the binding objects themselves on the eval wire: the TypeScript hands its host a record's binding object, its read seam and provenance included |
| `at_record_key`, `node_spread_record` | `AT` over a value that may be a record with a key that is not a text literal, or names an internal of the binding object (its read seam, provenance, `Map`s); a map holding a record spread into a graph, which `asMapList` would file as a child of the binding object's keys | the binding object's internals as values |

**Statements and right-hand sides** (a reached body):

| reason | the construct | needs |
|---|---|---|
| `statement:call`, `movement_call`, `function_call` | a call statement of anything but a movement or a plugin (a built-in's or a collection op's); a call of a movement whose value is not one kind on every path, or whose kind is left open by a recursion; a bound call of a name the program binds that is not a movement, or of any non-movement callee before version 3 | the remaining call forms (a collection op as a statement, closures as callees) |
| `call_park` | an `await sleep(…)` inside a movement a call enters | call frames in the park state: a park inside a callee resumes through them (run.ts ~:2834) |
| `rvalue:closure`, `rvalue:lazy`, `rvalue:inlineBlock`, `expression_closure` | closures and lazy walks as values; a collection op written inside an expression (`{ all: MAP(xs, (x) => …) }`), run by the TypeScript as a call bound first (from version 3) | closure and lazy-walk binding kinds, with the call frames above |
| `statement:combinator`, `rvalue:combinator` | `parallel`, `race` | spawned arms in the executor, the in-run lock gate table (FIFO, shared or exclusive), a write-ordering ledger (write_ledger.ts), arm traces spliced in order, frames and joins in park state, race settlement (losers cancelled) |
| `await_not_sleep` | an `await` of anything but `sleep(…)` (parallel, race, until, a callback, a landing) | the same, and the await kinds' park states |
| `block_park` | an `await sleep(…)` in a block's body: an iteration that parks is joined by the fan-out's frame | fan-out frames that join parked iterations |
| `statement:collection`, `rvalue:collection` | MAP, FILTER, … whose config asks a concurrency or an initial batch other than 1 (members run one at a time here) | bounded fan-out (fans.ts `mapConcurrent`): members run concurrently, their requests interleaved as the TypeScript's are |
| `rvalue:callback` | a callback | `park.callbacks.*`, a callback binding kind, and the callback body's entry ("Entries never routed" below) |
| `statement:refresh` | `refresh` | its semantics (no corpus case runs one) |
| `rvalue:extractCall` | the version-3 `extract(…)` call form | its prompt blocks, `llm.extractCall.call`, site ids `xc:<shape>#<n>` |
| `rvalue:<kind>` | any other right-hand side, by its AST `kind`; for `return`, also `extract`, `write`, `match` and `link`, and in a block's iteration `node` and a record | a returned record binding (a return value that is a record, as a call's value already is) |
| `extract_tier` | `extract "careful" from […]` | the deployment's tier table (ai_tiers.ts `EXTRACTION_TIERS`) as input |
| `plugin_call` | a plugin's call this engine does not make: inside an expression (`{ page: p(…) }`), spelled in another letter case than imported, or of a plugin the input's snapshot does not describe; a `through` stage naming no imported plugin | a call bound inside an expression (checker `nested_calls`), any-case resolution |
| `plugin_call:records` | a call of a plugin whose declared output is `records` | a records-output binding kind |
| `plugin_call_form` | a plugin's call with a positional argument, or an argument that is not a value (a call, a node, a write) | positional arguments; arguments of every kind |
| `builtin_call_form` | a built-in's call with a named argument, an argument that is not a value (a closure, a write, a node), or no expression to read | the built-ins' call forms |

**Writes, matches, links, deletes** (a reached body):

| reason | the construct | needs |
|---|---|---|
| `write_bind` | a write with `bind` | `park.bindings.*` |
| `match_tuple`, `match_position` | a match over a tuple of paths, or of a bare alias | a tuple binding kind, per-slot writes |
| `write_position_not_record`, `delete_not_record` | `write x { … }` where `x` is not a record (a write's handle, a block's hop alias, a node the run built or what one's edge holds); `delete x` where `x` is not a write's handle or a hop alias | the TypeScript's errors for the rest; a delete of what a node's edge holds |
| `write_position_member_path` | `write m.k { … }`: a write from the record a map's member holds | a member-path record binding |
| `write_root_expression`, `match_root_expression`, `write_root_not_held`, `match_root_not_held` | a linked write or match rooted at an expression, or at a shape the file declares (`write Note.parent { … }`) | the TypeScript's root resolution |
| `write_multi_hop`, `match_multi_hop` | a linked write or match that walks more (or less) than one edge | the TypeScript's error, or its multi-hop semantics |
| `write_spread_path`, `node_spread`, `node_spread_path`, `node_spread_source` | `...m.k` in a write or a graph literal; a spread in a `node { … }` literal; a graph spread of a name that is not a value, a handle or a node | spreads of records and of map members |
| `unique_by_without_key`, `unique_by_reads_beyond_candidate` | a `unique by` clause with no key (no bare field, parent or `field == value`); a conjunct that is not a pure predicate over the candidate | the TypeScript's post-filter for impure conjuncts |

**Nodes and graphs** (a reached body):

| reason | the construct | needs |
|---|---|---|
| `node_declared_entry`, `node_event_entry`, `rvalue:node`, `exists_node` | a declared edge entry inside a graph literal (the parser refuses one); an entry holding the event; a node a block's iteration returns (its block's value would be the records returned); `EXISTS` off a node this run built, or what one's edge holds, of more than one hop or with an ORDER BY or a LIMIT | an entry holding the event; returned records as a block's value; EXISTS's per-origin ORDER BY / LIMIT and its walk past the node plane |
| `is_test_declared_record`, `is_test_declared_graph` | `x IS <Decl>` (a node declaration) where `x` is the event, a handle, a landed record, or a `graph { … }` literal | a checker stamp carrying the assignability verdict (the checker stays TypeScript, behind `check.program`) |

**Traversal blocks and heads** (a reached body):

| reason | the construct | needs |
|---|---|---|
| `block_head_rootless`, `block_head_expression_root`, `block_head_value_root`, `block_head_root` | a block head with no root; rooted at an expression (`AT(rows, 0)-[c:company]->`), a value (a list of records) or a kept walk (`files-[f:x]->` continues the walk past its head), or anything but an instance, a write's handle, the event, an enclosing block's hop alias, what an extraction yielded, a node the run built or what one's edge holds | heads rooted at every binding kind |
| `block_multi_hop`, `block_head_step`, `block_head_does_not_lower` | a head of more than one hop, a hop that is not an edge, a head the probe cannot read | multi-hop walks |
| `block_head_extract_hop` | a head over what an extraction yielded whose hop carries a WHERE (the TypeScript refuses it), an ORDER BY, a LIMIT or an incoming direction (which it does not read) | the TypeScript's refusal and readings there |
| `block_head_resources` | a `_resources` head (off the event or an extraction) | resource descriptors (FileRef) crossing as the descriptor |
| `traversal_meta_edge` | a hop over a `#`-prefixed edge: the engine's own meta references, which the TypeScript read wrapper hands the adapter unrestamped | the meta-edge walks over run-built accumulants (run.ts `metaEdgeBindings`), the adapter pass-through without restamping (kg.ts) |
| `select_multi_hop`, `traversal_root`, `traversal_step`, `traversal_steps`, `traversal_terminal`, `walk_extract_hop`, `exists_step`, `exists_extract_hop` | `x = FIRST(…)` of a walk of more than one hop; a field read or walk rooted at a name not held as its root; a hop that is not an edge; a field read off a held name that also walks hops; a walk ending in anything but a field; a hop down an extraction with a WHERE (or, in `EXISTS`, an ORDER BY or a LIMIT) | the full walk evaluator, with the TypeScript's errors for the forms it refuses |

**Expressions** (a reached body, or a file-level value):

| reason | the construct | needs |
|---|---|---|
| `aggregate:llm`, `aggregate:only`, `aggregate:sort_key`, `aggregate_records` | the `llm` fold; `ONLY(e)` of anything but a name; `SORT(xs, key)` whose key is not a field name; `FIRST`/`LAST`/`ONLY`/`SUM`/… of a bare walk anywhere but a binding's whole right-hand side (`COUNT` of one is admitted) | the llm fold through the host, record sorts, record-valued folds |
| `expression:<type>`, `expression:exists` | an expression kind that needs the host, by its lowered `type` (`llm`, `meta`, `resource_traverse`, `kg_value`, `edge_property` outside a hop's WHERE, …); a rootless `EXISTS(-[…]->)` | host reads in expressions (AI(), KG values) |
| `meta:<key>` | `@user_*` and `@actor_*`, and any other key of the dispatch's `meta.bag` (only `@current_date` and `@current_timestamp` are read here) | the acting-user and actor lookups |
| `function:<id>` | a function the evaluator does not run, by its lowered id (`chunks`, `domain_of`, `file`, …) | the built-ins `CHUNKS`, `DOMAIN_OF`, `FILE`, … |
| `within_compare` | `WITHIN` | WITHIN against the pinned instant |
| `static_number`, `proto_key` | a numeric literal JSON cannot carry (`Infinity`, `-0`); a `__proto__` key written in an object literal | wire support for those values (the transition artefacts' strings and keys rows) |
| `condition_does_not_lower`, `expression_does_not_lower` | a slot that does not lower (the checker's miss) | lowering coverage, or the slot handed to the check |

A hop's WHERE and ORDER BY key, and a write's or a match's target WHERE, are
walked as expressions scoped at the landed record (the candidate, for a
target): a bare name (`property`, `edge_property`) is the record's field
(or a value the body binds of that name), and the rest is the expression
walk above.

**The input** (admission; `admit::input_refusal`, over the reached
movements, before anything is asked):

| reason | what the input would make the run do | needs |
|---|---|---|
| `cost_cap_inside_block` | a capped run with a priced step in a block's body (a write, a match or a link that matches, an extraction, a plugin's call): the cap can be met at any of them | suspension inside fan-out iterations, joined by the fan-out's frame |
| `cost_cap_inside_call` | a capped run with a priced step inside a callee, or a call with a write or a call among its arguments: the cap met inside a callee suspends through a call frame, and met past one of its statement's calls, with that call in the statement's journal | call frames in the park state, and the statement's call journal |
| `lazy_park` | a run that may park (an `await sleep(…)` outside a rehearsal, a cost cap, a `suspendAt`, a paused run) holding a kept walk (`x = lazy …`, a `lazy` node entry) | a kept walk in the park state (`serializeDeferredWalk`: its head, tail and captured scope) |
| `suspend_at_inside_block` | a `suspendAt` address with an `i` step | the same |
| `suspend_at_call` | a `suspendAt` address with a `c` step (before a statement's k-th call) | a call journal to run a statement again by |

**A parked state** (admission; `park::resume_refusal`). A run the TypeScript
engine parked must resume here, so each is a port too:

| reason | the state | needs |
|---|---|---|
| `resume_state_does_not_read` | it does not read off the wire | — |
| `resume_state_version` | a version other than 1 | — |
| `resume_state_frames`, `resume_state_until` | frames, an `until` | frames and joins (parallel and race arms, `b` branches, `keepArmCount`, `recordJoin`), `until` |
| `resume_state_journal` | a journal with a call in it | the call journal |
| `resume_state_suspended` | a `suspended` other than `true` | — |
| `resume_state_address` | an address stepping into anything but `if` arms (`^s\d+(\.b\d+\.s\d+)*$`) | `i` and `c` steps and parallel branches |
| `resume_state_kind:<kind>` | a binding of a kind this engine does not rebuild (`extractRoot`, `extractPosition`, `sourcePosition`, `shapePosition`, `lazyWalk`, `callback`, `resource`, `recordValue`, `localShape`, a `shape` outside the file scope, `tuple`, `closure`, `blockMeta`); this engine writes an extraction's emission into a park as the TypeScript does, but does not read one back | each kind's rehydration (serialize.ts `rehydrate`) |
| `resume_state_returned_records` | a bound block's returned records | positions with landings |
| `resume_state_extraction_origin` | an extraction among a binding's origins | extraction provenance on resume |
| `resume_state_value_holds_record` | a value binding holding a record (a binding-shaped dict) | the record model held as a value |
| `resume_state_deferred_edge` | a node's edge that is deferred (a `lazy` entry's) | a kept walk rehydrated (`rehydrateDeferredWalk`) |

**The shim's input checks** (`notAdmitted`, one reason each):

| reason | the input | needs |
|---|---|---|
| `event_does_not_cross` | an event, source or parked state the eval wire cannot carry as itself (a function, a bigint, a `Date` or any non-plain prototype, a shared open reference, an array hole, an own `__proto__` key, a lone surrogate) | a `Date`, a lone surrogate and a `__proto__` key on the wire (the transition artefacts' surrogate and prototype rows) |
| `resume_answer` | a resume that answers into its leaf (an ask) | the answer's binding rematerialised (`rematerialiseAnswer`) |
| `resume_defers_race_settlement` | a resume that defers a race's settlement | the race settlement entry |

**After the check** (`declined`):

| reason | what the stamps say | needs |
|---|---|---|
| `event_field_dated` | the program reads an event field (by name, or as a `...msg` spread's stamp names it) that the source's schema types as a date: an adapter may answer it as a `Date` | a `Date` value on the wire (or a ruling that adapters never answer one) |
| `catalog_does_not_load`, `event_does_not_read`, `instant_does_not_read`, `check_answer_malformed` | the run's input or the check's answer does not read | to become errors: shim faults in all but name |
| `source_does_not_parse` | a source this engine's parser refuses and the checker passes | the grammar this engine lacks (none is known) |

**Not refusals, still TypeScript.** Zero refusals is not zero TypeScript:

- **Hand-backs mid-run.** An admitted run still asks the TypeScript
  standard library for a reading this engine does not reproduce
  (`builtins.function`, `builtins.compare`; the evaluator's `fallback`), or
  fails loudly ("Errors a run can meet mid-run" below).
- **Entries never routed.** `settleRaceFrame` (a race settled after a batch
  resume) and `fireCallbackBody` (a callback's body) have no entry here:
  every race settlement and callback body runs on TypeScript.

### What admission cannot decide

These depend on what a value holds, not on what the program says, and stay
mid-run failures ("Errors a run can meet mid-run" below): a `__proto__` key
spread in from a value, a record held in a value handed to the host, a
binding-shaped dict of a kind whose reading needs what the run does not hold
for it. A name typed as a value may hold a record at run time (a member of
a walk read as a list, a dict whose `kind` names a binding kind), so
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
  `shim_fault` for one the shim faulted; `movement_engine_ts` when
  `MOVEMENT_ENGINE` did not choose this engine). At info under
  `MOVEMENT_ENGINE=rust`; at debug under `ts`.
- **`rustRunStats`** (rust_stats.ts): `notAdmitted` by first reason,
  `allReasons` by every reason a run not admitted holds (one count per run
  per reason), and `declined` by reason;
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
The stamp the check declines on (`event_field_dated`) is read in every
called movement too, an event parameter by the names a call gives it.

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

### Records held as values

A value may hold a record (chunk 7A Task 3): a member of a walk read as a
list, a closure's parameter, a dict whose `kind` names a binding kind or
an `Object.prototype` member (`bindingOf`, mirrored in record.rs). Each is
read, compared, spread, written from, linked and walked as the TypeScript
reads that binding (`readBareName`, `traverseFrom`, `readBindingField`,
`compareRecords`, `spreadKeysOf`, `resolveTupleWriteTarget`,
`referencedRecords`), with V8's TypeError messages where the TypeScript
throws one. Records compare by identity, else by address. A field an
object lacks reads `Object.prototype`'s member, and a dict made text runs
V8's ToPrimitive over its own `toString` and `valueOf`. A dict the
TypeScript takes for a record of a system (a `sourcePosition`, a `handle`,
an `instance`) is read through its graph as that binding is (shaped.rs):
the event's source, or an instance resolved from the dict's slug,
credential name and construction config; a dict's own `read` holds no
adapter, so a read through it throws V8's TypeError where the TypeScript
calls into it. Every other kind's walks, `EXISTS` hops, field reads, bare
reads and parks read the dict's keys in the order the TypeScript's case
reads the binding's, a member of its lists switched on by its `kind`. A
GROUPBY or KEYBY filing a member under `__proto__` sets the answer's
prototype (`JsObject::proto`): reads go through it, a list there makes
the answer's text a join, the answer is no dict (`isDictValue`), and the
eval wire carries the prototype (`["o", id, entries, prototype]`); a list
there answers `Array.prototype`'s names (`["f", "Array#<name>"]`), a record
there makes the answer that record to `bindingOf` (the KEYBY case), and a
filing onto a list the prototype holds pushes onto that very list (lists
are shared and mutable, `JsArray::push`). A walk a dict carries runs from
its captured pairs. The hops past a kept walk run inside it
(`resolveHeadIterations(walk.head, env, extraSteps)`): in the scope it
captured, so a WHERE there reads the names as they were when the walk was
kept, and breadth first across its origins, hop by hop, as the TypeScript
asks. A list that holds itself joins as V8 joins it (the repeated list is
empty text), is written by the JSON writers as `safeStringify` writes it
(its text, the fallback V8's circular-structure TypeError takes there) or
with its circles cut where the TypeScript never meets one, fails a park,
`TEXT.SERIALISE` and `plainValueOf` with the RangeError their recursive
writers end in, crosses the eval wire as shared references, and compares
by identity first. A
collection op's `onError` never forgives this engine's own refusal
(`ErrorClass::Unreproduced`). MAP, FILTER,
REDUCE, GROUPBY, KEYBY and MEMBERS run one member at a time
(`interpretCollectionOp`, its `onError` and answer shapes; as calls from
version 3). A park writes a held record as the TypeScript's `recordValue`
descriptor and refuses a function (MOVENG_PARK_NONSERIALIZABLE). On the
eval wire a built-in crosses as `["f", name]` and `Object.prototype` as
`["p"]`; the event's binding object crosses as `{kind: 'event'}`. A request
holding any other record is never made (`HeldRecord`, per request).
Pinned by tests/oracle/records.json: 3,753 cases — 1,200 programs from 36
body templates, 4 written out for `onError` and held walks, and 68 directed
ones (17 dicts a walk or instance reading meets, each under 4 bodies), each
under versions 1 to 3 where the checker passes it, seed 20261010 — run on
the TypeScript engine against an adapter
that answers walks (`items`, `subs`, two records named `__proto__`) and
writes. The generated dicts include instances with non-text slugs, schemas
of their own and non-map configs, walks with captured pairs, text where
records belong, and `kind: "__proto__"`; the templates include lists a
GROUPBY filing makes hold themselves, and hops past a kept walk whose WHERE
reads names declared after it; the directed dicts carry the walk and
instance shapes the TypeScript reads without refusing. GROUPBY and KEYBY answers are read
by member. The Rust engine ends each as the TypeScript did (0 differ; 147 are
refused at admission: the programs `AT`-ing a record by a name,
`at_record_key`, and those walking straight off a `lazy` binding,
`traversal_root`).

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
  validation failure instead: "Transition artefacts to mirror" below.)
- A record held in a value reaching a host request admission did not
  foresee: MOVENG_UNSUPPORTED before the request is made (a backstop;
  admission refuses each route it knows, by name).
- A dict shaped like an `instance` whose own schema holds a `collections`
  table the read wrapper's types do not read, or is `null`, read through its
  graph: MOVENG_UNSUPPORTED. One with no `collections` at all reads as the
  TypeScript reads it: a collection scan fails with the read wrapper's
  TypeError after the scan, a streamed walk (which no read wrapper touches)
  proceeds, and a hop's WHERE through one naming selected members fails as
  `hopSelection` does where the hop's target is not in its positions; a
  wrapped hop off a record through one, and a WHERE through one whose
  positions name the target, are MOVENG_UNSUPPORTED. Its slug, credential
  name and construction config are read as the TypeScript reads them,
  whatever they are, and the host is asked for the slug as the dict holds
  it (the host keys its registry by it, as the TypeScript's does).
- A walk a dict holds as data (`lazyWalk`, a deferred edge) rooted at an
  expression with source text, or whose mapping has an entry that evaluates
  a value or walks a head, a spread to apply, a graph shape or a declared
  edge naming a declaration in scope, or an edge named by anything but text:
  MOVENG_UNSUPPORTED. Every other walk a dict holds runs as the TypeScript
  runs it: captured pairs keyed by the value itself (a root named by no text
  reads the pair keyed by that very value), a later pair replacing an
  earlier one, the root spelled and the hops probed as their text, and a
  mapping building the nodes, nested nodes, declared edges and graphs the
  data writes, with the TypeErrors where it is not a literal's shape. A head
  rooted at a dict shaped like a synthesised node, a kept walk or a meta-node
  walks that kind's plane; one hop off a dict shaped like a callback is
  MOVENG_UNSUPPORTED (the TypeScript reads the calls its callback sink holds).
- Parking a value whose message or data would print a record's binding
  object other than the event's or a block's returned records' (its read
  seam, its computed schema): MOVENG_UNSUPPORTED.
- A hop's ORDER BY over more than 64 records whose keys mix numbers with
  other kinds, or a `SORT` over more than 64 such members:
  MOVENG_UNSUPPORTED ("Transition artefacts to mirror" below). TypeScript orders them by
  V8's merge.
- `x IS <Decl>` of a node whose landing under a declared edge is a system's
  record (a handle, a landed record): MOVENG_UNSUPPORTED, as that landing's
  structure is its system's types. Admission lets no such node reach an
  `IS` (a `node { … }` literal nests nodes only; a `graph { … }` literal is
  refused, `is_test_declared_graph`).

None of the first five is a built-in's reading, so none can be handed to the
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
- `{refused: reason, reasons}`: admission refused the program, its input
  or its parked state on this engine's own parse; nothing was asked of the
  host. `reasons` is every reason met, `reason` first ("What admission
  walks");
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

| # | the artefact | here today | the mirror | size |
|---|---|---|---|---|
| 1 | the regex dialect | `js_regex` reads most of it; hands back lookbehind, named groups and `\k<name>`, octal and `\c` escapes, a class escape at a range end, groups nested past 100, a step or depth budget met | `js_regex` kept and made complete, with no budget (a budget diverges where TypeScript is merely slow); oracle regex.json | M |
| 2 | date parsing | ISO texts only; V8's legacy forms handed back, including under every `<` between two texts with a digit (filter.rs) and ORDER BY | V8's legacy parser ported (dateparser.cc: keyword tables, parenthesised comments, zone names, two-digit years), fuzzed against Node; an ISO date-time without offset read in a local zone that becomes a run input | L |
| 3 | Unicode case mapping | Rust's tables (Unicode 17); a known divergence (detail below) | Node's ICU (Unicode 16): code points assigned after 16 unmapped, the cased and final-sigma deltas fixed (U+0295); the data pinned to Node 22's ICU | S |
| 3a | the local edge's word split (`/[^\p{L}\p{N}]+/u`, FUZZY candidates) | src/letter_number.rs, generated from Node 22.20 (Unicode 16) by tests/oracle/letter_number.ts | regenerated with row 3's data whenever the pinned Node moves; the language's own Unicode version once one is named | XS |
| 4 | ORDER BY and `SORT` over mixed key kinds | V8's binary insertion to 64 records; past 64 with mixed kinds, MOVENG_UNSUPPORTED (detail below) | V8's TimSort ported exactly (run detection, merge_lo/merge_hi, galloping); oracle by seeded mixed-key lists | M to L |
| 5 | a reply field named after an `Object.prototype` member, and a declared `__proto__` | read as any other field | a fixed table of `Object.prototype` member names with zod's issue text per declared type, and the prototype-set semantics, in crate::extract::validate; the oracle marks these replies (`prototype_key`) | M |
| 6 | a reply number above the double range | refused as zod refuses it | nothing: over a JSON host it is `null` on both engines; documented | 0 |
| 7 | a model reply holding a `__proto__` key or a lone surrogate | `uncarried`: one issue at the reply's root | the wire carrying both (follows row 9), and `__proto__` as an own key in values | follows 9 |
| 8 | extraction call-site numbering | numbered as the TypeScript numbers it | already mirrored; a test with a slow host to pin it | 0 to S |
| 9 | a cut at a UTF-16 surrogate pair | the pair dropped whole | a string that can hold a lone surrogate, a tagged form for it on the eval wire, an escape-aware writer at the host JSON boundary; also unblocks `event_does_not_cross` for surrogates, row 7 and `split("")` of astral text | L |
| 10 | a fractional `EXTRACTION_FILE_CHARS` | floored by the shim | the raw number passed, cut at its truncation, printed with ryu-js number text | XS |
| 11 | records held in values (binding-shaped dicts: `bindingOf` walks the prototype chain), `Object.prototype` field reads, identity comparison of records, a dict made text (V8's ToPrimitive) | mirrored (chunk 7A Task 3): `Js::Record` and `Binding::Shaped`, one `Object.prototype` name table (js.rs), V8's TypeError messages; residuals in "Errors a run can meet mid-run" | oracle records.json (3,612 whole programs, seed 20261010, tests/records_oracle.rs) | done |
| 12 | `__proto__` keys in values and literals; `-0` and `Infinity` literals | `proto_key`, `static_number` refused | the wire carrying them | — |
| 13 | a `Date` an adapter answers | `event_field_dated` declined; MOVENG_UNSUPPORTED mid-run | a `Date` on the wire, or a ruling that adapters never answer one | — |
| 14 | a `#` edge's restamp (kg.ts) | `traversal_meta_edge` refused | the read wrapper's pass-through without restamping | — |
| 15 | identity of host objects across host calls | in process only: the segment's wire hands an object the host sent back as that object (`["i", id]`) | nothing for a remote host: it serves JSON shapes, so identity across calls is not part of the contract | — |

#### The rows in detail

Rows 3 and 4 are the two a run admitted here can meet today:

- **Row 3: one reading differs.** `toLowerCase` /
  `toUpperCase` follow Rust's tables (Unicode 17); Node 22's ICU follows
  Unicode 16. A character whose properties changed between the two can map
  differently. The known case is U+0295 (ʕ), which counts as cased for the
  final-sigma rule in Rust and not in Node: `"ΑΣʕ"` lowers to `αςʕ` here and
  `ασʕ` in TypeScript. Pinned by
  `stdlib::tests::case_mapping_follows_rusts_unicode_tables`, and not
  handed back.
- **Row 4: one reading fails loudly: a hop's ORDER BY over keys that mix
  numbers with other kinds, past 64 records.** The sort is V8's
  (crate::order_limit): binary insertion up to 64 items, which reproduces
  V8 exactly for any comparator; past 64 V8 merges its runs, which this
  engine reproduces for every total order. Mixed number and text keys are
  not one (the comparator has cycles), so there V8's merge alone decides
  where records land. Rather than order them differently, the run fails
  with MOVENG_UNSUPPORTED naming the ORDER BY and the record count. Ruled:
  no silent divergence (the order_limit pin holds every set of 64 or
  fewer, mixed included).

What each of rows 1, 2, 4, 5 to 10 does today, in the TypeScript and here
(written when these were to be specified by a language-version bump; the
mirror replaces that plan):

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
checks and that admission lets through: row 3 above (pinned), and the rows
that refuse, hand back or fail loudly rather than differ. None is known
beyond those.

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
admitted: {reason: count}` (by first reason, largest first), `Rust runs not
admitted, every reason: {reason: count}` (each run counted under every
reason it holds), and fails a run in which Rust
answered nothing, admitted runs none of which ran whole, any decline or
shim fault, or a whole-corpus run under its routing floor (v1 392, v2 467). Any filter (a path or name pattern, related or
changed files, a shard, positional paths) makes a run partial, and the floor
does not apply to it.
