# movement-engine

The movement engine in Rust. A segment of a run executes inside one WASM
instance and asks for everything outside the program in the host contract's
own shapes (docs/contracts/host-families.md); `apps/api/src/services/movement_engine/
rust_engine.ts` drives it, and `rust_host.ts` forwards each request to the
run's `EngineHost`.

Which runs reach it is decided by the run's pinned language version alone
(`engineRoute` in rust_engine.ts): version 5 or later runs here, 1–4 on the
TypeScript engine, which no longer runs version 5. There is no fallback and
no admission step: the checker is the one gate, and a version-5 run this
engine will not run fails where it is met with `MOVENG_UNSUPPORTED`, naming
the reason. A resume goes back to the engine that parked it (the run row's
`engine`, handed in as `parkedOnEngine`); a version-5 state the TypeScript
engine parked cannot resume, and fails saying so. `MOVEMENT_ENGINE`,
`MOVEMENT_ENGINE_FALLBACK`, `MOVEMENT_ENGINE_DRY_RUN_EVERY` and
`MOVEMENT_ENGINE_V5_ON_TS` are retired, and boot refuses any of them set.

The engine runs a whole run, and only that (`eval_expression` is gone):
bindings, `if` and `return` over reads of the event and of values (slice
2a), writes with identity (`unique by`) and the nodes a run builds (slice
2b), `sleep`, parked and resumed in its own state, traversal blocks over
adapter edges, plugin calls and the extraction call ("The run" below). The
extraction keyword (`x = extract from […] { … }`) is a version-5 refusal in
the checker. The conformance corpora run on this engine for version 5.

## Modules

| module | what |
|---|---|
| `executor` | a single-threaded async runtime: the segment is one future; a `HostCall` future registers its request and yields; `join_all` keeps several in flight; `map_concurrent` runs a fan at most so many at a time (fans.ts `mapConcurrent`) |
| `host` | one request builder per host call, each family spelled as host.ts's `HOST_FAMILIES` spells it (`adapters`, `llm`, `llm.client`, `llm.transforms`, `park`, `park.sink`, `park.callbacks`, `control.cancel`, `locks`, `trace`, `clock`, `files`, `ids`), plus the engine's own (`check`, `log`); every host request but those names the segment |
| `ledger` | the run's spend account for one segment: the budget a priced call is sent, the cost each answers charged, the cap met (`exceeded`) once a budget refusal is charged, a priced plugin refused before the host is asked once the cap is spent (`plugin_refusal`), the charges handed back with `done` |
| `abi` | the C ABI: `engine_start`, `engine_answer`, `engine_finish` |
| `eval` | `evalMovementExpr`: the expression kinds, with their provenance rules and errors; the folds; what a walk, an `EXISTS` over a record, or a count needs asked of the run (`Reader`) |
| `stdlib` | the 17 flat built-ins and all 15 namespaced members |
| `run` | the `segment` entry: `runMovement` / `resumeMovement` for a version 5 program (below) |
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
| `marks` | `/\p{M}/u`'s code points, as Node reads them (generated) |
| `park` | `ParkedScopeState` version 2 (one `ParkWriter` across scopes, frames and journal; code named by its place in the pinned program, libraries pinned by `park.sources` hash), the suspension points, and the state's refusal (`resume_refusal`) |
| `resume` | `resumeAlongAddress`: a state's spine descended (`if` arms, iterations, branches, call and member frames), the leaf bound or re-entered, each enclosing body finished, joins closed and races settled through the host; `settleRaceFrame` and `fireCallbackBody`; every descriptor kind rehydrated |
| `code` | code a park names by its place in the program: an AST path read back as the typed node it names in the pinned source |
| `flow` | a flow's own state (its trace buffer, ledger slot, call sites, lock holds), swapped in on each poll; shared futures several flows await (an adapter's resolution) |
| `combinator` | `parallel` and `race`: arms as flows joined on the executor, the write ledger spliced in arm order, a race's winner and its losers cancelled, arms that park joined through their frame |
| `awaits` | `await` of a landing, an `until`, a callback (`park.callbacks.mint`, its `called` edge), and the park each writes |
| `bindings` | what a name in a run is bound to, the lexical scopes (in declaration order), the source `Position` |
| `trace` | the `MovementTraceEntry` kinds a run appends (`warning`, `gate`, `field_miss`, `block`, `extraction`, `plugin`, `ai`, `read`, `chunks`), and the per-flow buffer they wait in until their statement ends |
| `program` | the pinned source parsed, joined with the `check.program` host call's answer: diagnostics, the import link, the checker's stamps by AST path; the declarations (`Declarations`: the root's and each library's shapes and `type`s, each shape with the file that wrote it, and the plugin imports, by local name) |
| `extract` | the extraction call (`extract(content, Shape, { … })`, `extractOne(…)`, `call`): a declaration's spec resolved per firing (`spec`), a reply read as zod reads it (`validate`), files read and resources stamped (`resources`), the record an ask's correction answers (`emission`), and what the call and the `AI()` expression share: tier settings, priced calls, plugin invocation (`run`) |
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
artifact the engine segments are absent, and refused by name.

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
  The event and every value answer (an adapter's result, a priced call's)
  cross as plain JSON (env.rs): a list is `["l", [items…]]`, an object
  `["o", [[key, value]…]]` in its own key order; `undefined`, `NaN`,
  `±Infinity` and `-0` are `null` (a member holding `undefined` is left
  out), a lone surrogate is U+FFFD. Nothing crosses by identity: an object
  reached twice is written twice, and an object the host sends again
  crosses again, as it now is. A record whose binding object is data (the
  event, a callback, a shape position, a resource) crosses to the host as
  `["x", id, descriptor]` and back as `["x", id]`; a request holding any
  other record is never made. A file crosses as an opaque handle: the host
  sends `["F", id, { handle, name, contentType, size }]` and the engine
  hands it back as `["F", id]`, the segment's file table keeping the
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

The evaluator (`eval`) runs inside a segment; there is no separate export.
It reads the lowered `Expression` JSON back into the parser's own types
(crates/movement-parser/src/lowering/expression.rs) and evaluates it as one
async walk. What it cannot answer itself it asks of the run (`eval::Reader`:
an event field, a walk, `AI()`, the clock for `WITHIN`), as a host request
the walk awaits where it is made.

- Errors carry the class the TypeScript threw (`MovementEngineError` with
  its code, `Error`, `RangeError`, `TypeError`); the shim rebuilds them.
- The run's pinned instant (`now`, a `toISOString` text) is what
  `DATE.TODAY(zone)` reads, in the zone, through the environment services.
  The engine reads no clock of its own.
- Provenance is origin ids: the run numbers its origins, the evaluator
  mints one id per literal it evaluates, and a name, a branch or a
  `COALESCE` passes its binding's trail through.

### JavaScript semantics, written out

Each row names the test that pins it (`js::tests::…` and so on are in the
module; `frozen::…` is tests/stdlib_frozen.rs).

| what | how it is handled | test |
|---|---|---|
| `Number(text)` | trimmed (Rust's whitespace), then a plain decimal (`12`, `-1.5e3`, `.5`, `5.`) or `Infinity`; `""` → 0; a radix prefix (`0x10`) or anything else NaN | `js::tests::string_to_number_matches_javascript`, `frozen::the_standard_library_answers_as_it_was_frozen` (`coerce.number`, `flat.tonumber`) |
| `String(number)` | the shortest digits that read back as the number (one formatter for the parser, the checker and the engine: movement_parser::util::js), laid out as JavaScript lays them out (`1e+21`, `1.5e-7`, `0.000001`); on a 17-digit tie the last digit may differ from JavaScript's | `js::tests::number_to_string_prints_shortest_digits` |
| `String(value)` | arrays join with `,` (null and undefined members empty), objects `[object Object]` | `js::tests::string_and_number_coercions_of_composites` |
| `===`, `includes`, `Set` | strict equality (NaN not itself, `-0 === 0`), SameValueZero for membership, objects by identity (`Rc`) within the run; nothing from the host keeps its identity | `js::tests::identity_not_shape_decides_equality`, `filter::tests::membership_uses_same_value_zero`, `tests::the_callers_maps_cross_as_copies` |
| truthiness | `0`, `-0`, `NaN`, `""`, null, undefined are false | `tests::absence_reads_as_typescript_reads_it` |
| `ROUND` | Rust's `round`: a half away from zero (`-2.5` → `-3`) | `stdlib::tests::flat_builtins`, `frozen::…` |
| `toFixed` (NUMBER.FORMAT, CURRENCY) | Rust's `{:.N}`: the double's exact value, a tie to even (`0.25` → `0.2`) | `js::tests::to_fixed_is_rusts_fixed_point`, `stdlib::tests::number_format_and_currency` |
| `%` | Rust's `%` is fmod, the dividend's sign, as JavaScript's | `filter::tests::remainder_and_division_by_zero`, `tests::arithmetic_keeps_javascript_semantics` |
| object key order | the order keys were first set, a number-like key included; a repeated key keeps its place | `js::tests::maps_keep_their_keys_in_the_order_first_set`, `tests::maps_keep_their_keys_in_the_order_first_set` |
| a map's keys | own entries only: `__proto__` is a key like any other, and `constructor` or `toString` a map lacks reads absent | `js::tests::a_map_is_a_map` |
| `trim`, `\s` | Rust's `char::is_whitespace` (U+0085 in, U+FEFF out) | `js::tests::strings_are_characters` |
| a string | a Rust `String` (crate::js_string): Unicode text, so equality, hashing and order are its own. A lone surrogate's `\udXXX` escape in the host's JSON is read as U+FFFD (serde_json alone refuses it); the engine makes none of its own | `js_string::tests::*`, `env::tests::a_lone_surrogate_crosses_as_the_replacement_character` |
| `.length`, `<` on text | `.length` in characters (code points: an emoji is 1); comparison by code point | `js::tests::strings_are_characters`, `stdlib::tests::flat_builtins` |
| `split("")`, a cut | by character: an emoji stays whole in a split, a spread of a text, CHUNKS and every cut (80, 200, 300 and 1,000 characters, and a file bounded for the prompt) | `stdlib::tests::flat_builtins`, `chunks::tests::*`, `extract::emission::tests::*`; tests/stdlib_frozen.rs and tests/chunks_frozen.rs hold Rust's answers |
| `toLowerCase`/`toUpperCase` | Rust's own tables (`str::to_lowercase`/`to_uppercase`, the toolchain's Unicode, 17 today); Node's ICU (Unicode 16) maps differently only where Unicode 17 changed a case | `stdlib::tests::case_mapping_follows_rusts_tables` |
| a date-time text (`DATETIME`, `DATE`, a comparison) | ISO 8601 / RFC 3339 only (crate::js_date); no offset is UTC; a day the month lacks or the hour 24 is no date-time; a comparison reads only ISO texts as dates (`"item 3" < "item 12"` compares texts) | `js_date::tests::reads_the_iso_forms`, `js_date::tests::refuses_everything_else`, `filter::tests::texts_that_only_v8_read_as_dates_compare_as_texts` |
| `Date.UTC` round trip | `validParts` refuses years 0–99 (Date.UTC reads them as 19xx), months outside 1–12, days past the month | `stdlib::tests::dates_parse_add_and_format` |
| `toISOString` | six-digit signed years outside 0000–9999; an instant past ±8.64e15 ms throws `RangeError: Invalid time value` (DATE.ADD_DAYS) | `js_date::tests::iso_strings_outside_four_digit_years`, `js_date::tests::time_clip_bounds_and_truncates`, `tests::coalesce_short_circuits` |
| regexes (TEXT.REGEX_EXTRACT) | a flagless dialect over code points (an astral character is one character), compiled to a flat program run on an explicit backtracking stack: each iteration of a group clears its captures, an empty iteration ends a loop, `.` stops at line terminators; lookahead and lookbehind, named groups (ASCII names) and `\k<name>`, backreferences, `\xHH`, `\uHHHH`, `\u{H…}`, `\cX` with a letter, an escaped non-letter. Annex B is not read: an octal escape, `\N` past the groups, `\c` without a letter and an unknown letter escape are malformed. Groups nested past 1,000 are malformed. No step budget. A malformed pattern is null, as `new RegExp` throws | `js_regex::tests::*`, `regex_frozen::regexes_match_as_they_were_frozen` (7,209 seeded cases) |
| `URL` (URL.HOST) | `new URL` itself, asked of the environment (`url_parse`); only the TypeScript's own pre-reading (trim, the assumed `http://`, opaque uris) is written here | `stdlib::tests::url_host_as_whatwg_reads_it`, `frozen::…` (`url.host`) |
| `normalize("NFKD")` (TEXT.SLUG) | asked of the environment (`normalize`) | `stdlib::tests::text_members`, `frozen::…` (`text.slug`) |
| `Intl.DateTimeFormat` (DATE.TODAY, DATETIME.AT) | the zone's wall reading asked of the environment (`tz_convert`); `instantAtZonedWallTime`'s search over those readings written out, `Date.UTC`'s 19xx years included | `stdlib::tests::datetime_at_names_the_instant_on_the_zones_wall_clock`, `frozen::…` (`date.today`, `datetime.at`) |
| `JSON.stringify` (TEXT.SERIALISE) | its quoting and two-space layout; keys sorted as texts, then laid out in object order | `js::tests::json_stringify_indents_as_javascript_does`, `stdlib::tests::text_members` |
| the figure and month tables | `MAGNITUDE_SUFFIXES["constructor"]` is `Object`, so `"5 constructor"` is NaN; `MONTH_NAMES["constructor"]` fails `validParts` like no month (stdlib.rs keeps the tables' own quirk) | `stdlib::tests::figures_read_as_the_regex_reads_them` |
| a dict whose `kind` names a binding kind | data, as every dict is: only an engine object (`Js::Record`) is a record, so the content of data never changes how it is treated (Henry's ruling, 2026-10-10) | `record::tests::a_dict_is_never_a_record_whatever_its_kind`, apps/api's `rust_engine.unit.test.ts` ("host data is never read as an engine object") |

`tests/priced_pin.rs` holds the priced-plugin cap to tests/oracle/priced.json:
80 priced-plugin ledgers. It is written by tests/oracle/generate.ts with the
others, and CI diffs it too. (Until the extraction keyword was retired,
2026-10-16, an extraction.json pinned the keyword's specs, prompts and reply
reading as well; that code is gone.)

`tests/stdlib_frozen.rs` holds every built-in and the comparator to their
recorded answers (tests/frozen/stdlib.jsonl, 11,357 cases) and
`tests/regex_frozen.rs` the regex matcher (regex.jsonl: 7,209 seeded
pattern/text pairs, 3,200 over the core dialect, 4,000 over the rest of it,
and nine long texts and deep nestings). The answers are Rust's: the files were
first written by the TypeScript engine, and Rust agreed with it except where
version 5 differs on purpose (CHANGELOG.md). To change an answer on purpose,
run the test with `FROZEN_REGENERATE=1` and read the diff of the .jsonl.

## Refusals

The checker is the one gate. Before any run, run.ts checks the program
(`checkPinned`: its pin, its parse, the checker), so a program that fails
it (MOVENG_LANGUAGE_VERSION, MOVENG_PARSE, MOVENG_CHECK) ends there and its
host sees no request at all (`rustRunStats.endedAtCheck`). Past the check
the engine refuses a run in three places, each below: before the run asks
anything (`done` is `{refused}` or `{declined}`), when a resumed state does
not read, and mid-run, where a construct this engine has no case for fails
the run with MOVENG_UNSUPPORTED naming it. Nothing runs a refused program
another way: every refusal of a checked version 5 program is a checker or
engine bug.

**Before the run.** The shim fails the run with MOVENG_UNSUPPORTED "the
Rust engine does not run this movement (<reason>)" and counts it in
`rustRunStats.unsupported` under the reason.

| reason | when | what closes it |
|---|---|---|
| `language_version_runs_on_typescript` | `{refused}`: the run is pinned below version 5, refused before the parse and before anything is asked | nothing: versions 1–4 run on the TypeScript engine by their pin (`engineRoute`), so the shim never sends one; an embedder that does gets this |
| `event_does_not_cross` | the shim's, before the instance opens: an event, parked state, answer or callback's values that is not data (a function, a bigint, a symbol, a class instance, a value that holds itself, an array hole, a non-enumerable own key) | nothing a host sends: the event is data a webhook's or a poll's JSON made |
| `catalog_does_not_load`, `event_does_not_read`, `instant_does_not_read`, `snapshot_models_do_not_read`, `check_answer_malformed` | `{declined}`: the input or the host's check answer does not read (the catalog snapshot, the event off the wire, `now` as an ISO 8601 instant, `snapshotModels` as a list of texts, the check answer or one of its stamps) | nothing: shim faults in all but name |
| `source_does_not_parse` | `{declined}`: without `nativeCheck` only, a source this engine's parser refuses and the host's checker passes (with `nativeCheck` the engine's own parse fails the run with MOVENG_PARSE) | the grammar this engine lacks (none is known) |

**A parked state** (`park::resume_refusal`). A resume whose state does not
read fails before the host is asked anything, with MOVENG_UNSUPPORTED
"this run's parked state does not read (<reason>)":

| reason | the state | what closes it |
|---|---|---|
| `resume_state_does_not_read` | it does not read off the wire; its scopes, frames or journals (a frame's own) are not lists; or a descriptor has no kind this engine rebuilds | nothing: a malformed or foreign record |
| `resume_state_version` | a version other than 2 (docs/contracts/park-state.md: version 2 names code by its place in the pinned program, and pins each library by `park.sources` hash) | nothing: a version 1 state is the TypeScript engine's, and a version 5 run it parked fails its resume by `parkedOnEngine` before reaching here |
| `resume_state_suspended` | a `suspended` other than `true` | nothing: the park-state contract refuses it |
| `resume_state_code_does_not_read` | code the state names (a closure, a run-time arm's body, a body-local declaration, a kept walk's head or mapping) that is not text, or whose place holds no code of that kind in the pinned program (checked once the program and its pinned libraries are read, before anything runs); a code reference declared in a library the program does not link | nothing: this engine writes only places that resolve |
| `resume_state_kind:blockMeta` | a block's meta edges bound as a name | nothing: no run makes one (the TypeScript's builders of it are called nowhere, and version 5 retires every `#` hop) |

A state that reads but is malformed for its kind (a `handle` without its
record) fails the resume with MOVENG_RUNTIME ("the parked state holds …"),
as does a library the state pins that the host's source store cannot give
back ("the parked state's libraries do not read").

**Mid-run: this engine's own.** A construct this engine has no case for
fails the run where it is met, with MOVENG_UNSUPPORTED "<construct> is not
supported by the movement engine yet (<detail>)" (`ErrorClass::Unreproduced`;
never forgiven by a collection op's `onError`). The writes before it are
kept, as for any failure.

| construct | when | what closes it |
|---|---|---|
| `this statement` | a statement kind the run has no case for | nothing known: the parser and the checker pass no other kind |
| `the call '<callee>'`, `this right-hand side` | a bound call of a name that is no built-in, read where only an expression is run; a right-hand side of another kind there | nothing known: the run dispatches every call and right-hand side the checker passes before it reaches here |
| `reading '<name>' in an expression` | a walk inside an expression rooted at a name bound to something no walk starts from (a node, a callback, a kept walk) | a walk off each such binding where the checker passes one |
| `this reading (<reason>)` | an expression the evaluator could not finish without the run, read where no run is at hand (`EvalError::Fallback`): `an ambient is the run's`, `AI() is the run's`, `a record is the run's`, `<id> is not a built-in this engine runs`, `WITHIN reads the host's clock`, … | nothing known: every evaluation inside a run has the run as its reader |
| `handing a record held as a value (<kind>) to the host` | a record other than the event, a callback, a shape position or a resource reaching a host request's values | nothing known: a backstop; the checker refuses each route found (MOV_WRITE_FIELD_TYPE, MOV_CALL_ARG_TYPE, MOV_CALL_ARG_MAYBE_RECORD, MOV_GRAPH_ENTRY_RECORD, MOV_GRAPH_SPREAD_RECORD) |
| `<at>: parking a record (<kind>) as the data of its binding object` | a park reaching a record in a value no walk of held records finds | nothing known: a backstop |

**Mid-run: a host answer that is not its contract's shape.** A host answer
this engine reads a member of (`lookup.resolveActingUser`:
`{principal: {id, display?}, email?}`; `llm.transforms.invoke`: `{text?,
data?, records?, outcome?}` with every record an object;
`park.callbacks.calls`: a list; an awaitable adapter's `resolveAwait`: an
object with a status and, landed, a list of landings; a refetching adapter's
`readRecord`: an object or null; `files.resolveFileText`'s `unreadable`: one
of its four reasons) is held to that shape where it is read. One of another
shape ends the run with MOVENG_RUNTIME "the host's <call> answered something
malformed: expected <what>, got <what came>", never a JavaScript TypeError.
The marker `unreproduced: true` that once rode beside an engine refusal on
`done` is gone: nothing read it, and the error class already keeps such a
refusal out of `onError`.

**Mid-run: the language's own.** Every other MOVENG_UNSUPPORTED a run can
meet is a failure the TypeScript engine had in its words, kept here with
its message: the checker refuses each program
that reaches one under version 5, or the construct depends on what a value
or a host holds at run time. Each names its construct:

- the extraction keyword (`legacy_extraction`; MOV_EXTRACT_KEYWORD_RETIRED),
  and, at file level, extraction, blocks, writes, matches and links;
- a `_resources` head off the event or a system's record (MOV_RESOURCES_NOT_EXTRACTED);
- rootless block heads, rootless `EXISTS()`, a walk with no alias root;
- multi-hop linked writes; a `unique by` clause with no key or reading
  beyond the candidate; a WHERE or `unique by` on a shape write;
- a hop that is not an edge, in a block head, a walk, an `EXISTS` or down an
  extraction; an incoming hop on an adapter that cannot walk one; a WHERE
  on a lazy entry's hop or on a run-built node's edges; naming a deferred
  edge's landing while hopping past it; hopping past a landing that is not
  a record;
- a block head rooted at a name no head starts from (a value, a callback
  other than its `called` edge, a handle that bound no record);
- an `await` or `callback(…)` on a host that serves no park or callback
  sink, or of an edge the adapter cannot await; a named callback leaving an
  argument unsupplied;
- a movement parameter typed against something that is not an instance;
  passing a value that is not a record as a movement's position argument;
  calling an import with no file resolver;
- a plugin argument that is not a value; `bind` on, a WHERE on, or a link
  body into a node this run built;
- an expression kind with no case (`kg_value`, `kg_exists`, the TG
  engine's reads), an edge property read outside a hop's WHERE, the `llm`
  fold, SORT with no key or a key off a member that has none, a function
  no built-in and no write field answers;
- reading a record's internals as a map's key; writing out a record that
  contains itself.

### Language version 4's changes

Version 4 (Luminous Owl, main's d5bb93f794) changed what four constructs
mean. Each is a `since(v, 4)` conditional at the point of difference, so
version 5 runs it as version 4 does:

| main's change | sha | on this engine |
|---|---|---|
| a named match that finds nothing binds absent and the block carries on; a judge outage on a match leaves a `MOVENG_MATCH_JUDGE_UNAVAILABLE` warning | 26ed0b502f, 30e1acc55b | runs (crate::verbs `OnMiss`); a link's body still ends the scope on a miss, which the checker refuses (`MOV_LINK_MATCH_BODY_RETIRED`) |
| `-[:@old]->` off a write handle: the record the write found, the handle itself under `dry_run`, the previous handle on a chained write | 1bd0d3aa10, 30e1acc55b | runs: the hop is answered from the handle, never an adapter (crate::reading `is_old_edge`: an expression's walk, an `EXISTS`, a pick, a block head); the record before rides on the handle (crate::bindings `Old`) and a park carries it as `old` / `oldIsSelf` |
| `write org { … }` on a handle updates it in place | 1bd0d3aa10, 30e1acc55b | runs: the handle `org` moves on to the updated record (crate::bindings `Handle::move_to`), seen by every scope holding it, its `@old` a snapshot of it as it stood (or itself, under `dry_run`); a match's handle, a landing or a snapshot is written through as before, into a new handle |
| a handle reads the record as found (`foundData`) for a field its write did not set; a parent link carries only what the parent's own write got back | 1bd0d3aa10, ac7ac15ec8 | runs: every update that found its record by identity (`unique by`, native constraints or the adapter's own rule) or through a position keeps it (crate::write `record_before`); a hop and a parent link read only `resultData` |

### Language version 5's changes

Version 5 (Dancing Wren, main's 4319a39f..e0736369) retires constructs and
changes some meanings. A retirement is a checker refusal, so a version 5
program that uses one ends at its check before a segment opens; where the
engine still meets one, it fails as the mid-run lists above say.

| main's change | sha | on this engine |
|---|---|---|
| `write … bind` retired (`MOV_WRITE_BIND_RETIRED`) | eb334103 | the checker refuses it; one the engine meets fails as `a bound write` |
| every `#` hop retired (`MOV_META_HOP_RETIRED`); `#transform` is the plugin called as a function | 274f7f98, 66d2a376 | the checker refuses it; the function form is a plugin call, which runs |
| `delete` only of one stored record whose type's describe says `deletable: true` (`MOV_DELETE_NOT_DECLARED`, `MOV_DELETE_NOT_RECORD`) | 77a5b63c, f76e52bc | the checker refuses the rest. The catalog carries `PositionSchema.deletable` (the Rust reader declares it, so a snapshot carrying it still loads) |
| `_resources` only on an extraction's result (`MOV_RESOURCES_NOT_EXTRACTED`) | 0f522195, f76e52bc | a `_resources` head off the event or a system's record fails with MOVENG_UNSUPPORTED (crate::traverse `RESOURCES_RETIRED`) before the host is asked for the reserved reference or its `filesIn: "resources"` envelope; an extraction's resources are unchanged |
| the knowledge graph's resources edge is matched by its reserved field id (`EdgeSchema.resources`) | 2cc63d78 | a hop over an edge the schema flags `resources` goes to the adapter's `getRelated` as the reserved `_resources` field id (kg.ts `surfaceReadAdapter`; crate::traverse `related_items_as`), and its landing's fields (`URL`, `Name`, `Type`) are read through `getFieldValue` as any landing's are |
| a maybe-record (a record or data) handed to a position parameter is refused (`MOV_CALL_ARG_MAYBE_RECORD`, B15) | main merge 10 | the checker refuses it |
| a `parallel` / `race` receipt's slot holding one record reads as that record (B16) | main merge 10 | crate::reading `bare`: a `Tuple` slot holding one record reads as the record (`record::held`), as a list literal's member does |
| a closure lives only in a variable, a parameter or a call's argument (`MOV_CLOSURE_NOT_DATA`); no methods (`box.g()` is `MOV_FUNCTION_UNKNOWN`) | main merge 17 | the checker refuses both |
| `all(f, g, { concurrency, onError })` replaces `parallel`; `race(f, g)` takes its arms as arguments; no `await` on either | main merge 17 | crate::combinator: `all` is `parallel`'s join (the same branch frames, exports and park format); at most `concurrency` arms run at once, a parked arm freeing its lane; `onError` `warn`/`ignore` leaves a failing arm's slot null, before a park or after a resume (resume.rs `forgives_arm_failure`) |
| the extraction keyword retired (`MOV_EXTRACT_KEYWORD_RETIRED`) | 2026-10-16 | the checker refuses it; one the engine meets fails as `legacy_extraction` |

The values a version 5 run computes are Rust's, not JavaScript's
("JavaScript semantics, written out" above; CHANGELOG.md, "Language version
5, Dancing Wren: it runs as Rust does").

### The evidence

- **One log line per segment**, at the decision point:
  `movement engine: engine=rust|ts run=<id> outcome=<outcome>` (the outcome
  only for a Rust segment that ended at its check, or failed a check
  mid-run). At info for a Rust segment; at debug for a TypeScript one.
- **`rustRunStats`** (rust_stats.ts): `segments`, the segments this engine
  started; `unsupported`, those that failed because it would not run them,
  by reason (each is a checker or engine bug); `endedAtCheck`, runs that
  failed their check before a segment opened; `failedCheckMidRun`, segments
  that passed their check and failed a check mid-run (`IS <Decl>`);
  `shimFaults`; `hostCalls` by `family.method`.
- **`GET /api/v1/system/engine-stats`** (system scope, like `/tg-runs`):
  `{engine, uptimeSeconds, since, runs}`, this process's Rust counters
  since it started.

## The run

`run::segment` takes run.ts's steps in run.ts's order, and every step the
TypeScript takes through its host is a host request here:

| request | when | answered by the shim from |
|---|---|---|
| `check.program` | first, unless the input sets `nativeCheck` (every run segment the host opens does), when the engine checks the program itself | program_check.ts ("The check" below) |
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
| `park.sink.commitTimerPark` | a `sleep` in a run that is not a rehearsal, on a host that serves it | `host.park.sink`; `wakeAt` is `clock.now`'s answer plus the sleep |
| `park.sink.commitLimitPause` | the first time the run meets its cost cap (a budget refusal, charged, that the ledger says is the cap), on a host that serves it and can suspend | `host.park.sink.commitLimitPause` |
| `park.sink.commitSuspension` | the flow suspends: at the statement that met the cap, before each statement of a paused run (`limitPaused`), at a `suspendAt` address; on a host that serves it | `host.park.sink.commitSuspension` |
| `control.cancel.cancelledNow` | the last check (not after a park) | `host.control.cancel.cancelledNow` |
| `llm.extractCall.call` | each extraction call (`extract(content, Shape, config)`, `extractOne(…)`), once, and once more when its reply does not read: `{system, blocks, label, model, effort, maxTokens?, segmentId, budget}`, the prompt as blocks — each content item one, a cache breakpoint at the end of the longest content prefix this run already sent at that model and effort and at the end of the content, the shape and the rules last (extraction_call.ts) | `host.llm.extractCall.call`, answered on the eval wire; its cost charged; traced `{kind: "extraction", form: "call", …, cache}` |
| `llm.transforms.invoke` | a plugin's plain call ("Plugin calls" below); `{segmentId, plugin, config, extractedContext, budget}`, the plugin by its registered name | `host.llm.transforms.invoke`, on the eval wire both ways; its cost charged |
| `files.resolveFileText` | each content file of the run's extraction calls, once per run | `host.files.resolveFileText`, on the eval wire both ways (the file tagged `["F", descriptor]`; the host is handed the plain descriptor); its cost charged |
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
   `WITHIN` measured from the host's clock) — then the target's WHERE
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
field of it is null, and a park writes it as the TypeScript does. A
`return` of a record binds the block's returned records (`kind:
"positions"`), read bare as their list.

A head over what an extraction yielded (`deals-[c:company]-> { … }`) lands
on the extract's own entities under that edge, in hand: no host is asked,
the `block` entry is traced as for any head, and the alias reads each
entity's fields. A WHERE on its hop fails the run as the TypeScript's does
(MOVENG_UNSUPPORTED); an ORDER BY, a LIMIT or an incoming direction is not
read.

Heads of more than one hop run since PLAN-08A group D. A `_resources` head
runs off an extraction's result only (version 5, "Language version 5's
changes" above).

### Records held as values

A value may hold a record (chunk 7A Task 3): a member of a walk read as a
list, a closure's parameter (`bindingOf`, record.rs). Only an engine object
is one (`Js::Record`): a dict is data whatever keys it carries, a `kind`
naming a binding's included (chunk 7A Task 4b). Each is read, compared,
spread, written from, linked and walked as the TypeScript reads that
binding (`readBareName`, `traverseFrom`, `readBindingField`,
`compareRecords`, `spreadKeysOf`, `resolveTupleWriteTarget`,
`referencedRecords`), with the TypeScript's TypeError messages where it
throws one. Records compare by identity, else by address. A map is a map:
its own entries only, `__proto__` a key like any other (GROUPBY and KEYBY
file under it). The hops past a kept walk run inside it
(`resolveHeadIterations(walk.head, env, extraSteps)`): in the scope it
captured, so a WHERE there reads the names as they were when the walk was
kept, and breadth first across its origins, hop by hop, as the TypeScript
asks. A list that holds itself joins with the repeated list empty, fails a
park, `TEXT.SERIALISE` and `plainValueOf` with the RangeError their
recursive writers end in, and compares by identity first. A collection op's
`onError` never forgives this engine's own refusal
(`ErrorClass::Unreproduced`). MAP, FILTER, REDUCE, GROUPBY, KEYBY and
MEMBERS run their members `concurrency` at a time after a first batch of
`initialConcurrency` (`runMembers`, chunk 7A Task 6: each member a flow of
its own, its trace spliced in member order, a parked member holding its
slot; `interpretCollectionOp`, its `onError` and answer shapes). A park
writes a held record as the TypeScript's `recordValue` descriptor and
refuses a function (MOVENG_PARK_NONSERIALIZABLE). On the wire a record
whose binding object is data (the event, a callback, a shape position, a
resource) crosses to the host as `["x", id, descriptor]` and back as
`["x", id]`, and every object the host sends is data. A request holding any
other record is never made (`HeldRecord`, per request: "Mid-run: this
engine's own" above).

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
  `ONLY` (more than one present fails, quoting its argument as written), `COUNT` (what is present), `SUM`/`AVG`
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
  landing under it. A system's record (the event, a handle, a landing) is compared by the
  checker's assignability (`check.compatible`).
- **`ERROR(message)`**: the message evaluated and the run failed with
  MOVENG_ERROR, its text `String(value ?? '')`.
- **`@current_date`, `@current_timestamp`**: the run's pinned instant
  (`pinnedNow`), its ISO text or its date, a `{kind: 'meta', key}` origin;
  `@user_*` and `@actor_*` are looked up through the host
  (`lookup.resolveActingUser`, `extractActor`), once per segment.

### Extraction

The extraction keyword (`x = extract ["tier"] from […] { tree }`, with its
inline node shapes and `through` stages) is not run here on any version: a
run that meets one fails with MOVENG_UNSUPPORTED naming `legacy_extraction`
(Henry's ruling, 2026-10-16).
Version 5 refuses it at the check (`MOV_EXTRACT_KEYWORD_RETIRED`, with the
upgrade to a declared shape and `extract(…)` where that is mechanical), and a
version 1–4 program holding one runs on the TypeScript engine, which keeps
the keyword as those versions' reference. `lf` refuses such a project, saying to run `lf upgrade`. The
extraction call (`extract(content, Shape, { … })`, `extractOne(…)`) runs
whole (crate::extract::call).

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
shared distinctive word (split on what `char::is_alphanumeric` refuses;
kind words and a domain's TLD dropped), at most 20 landings (`candidatesCapped`). A landing
that is a reference (a `link`ed handle, a walked record) is read live and,
matched, updated through its own system under its record and identity
locks, logged as that system's write. The firing log gets a `local` row,
uncommitted, with no external id; the statement binds the landing. `link
n -[:e]-> x` appends `x`. A block head over a node's edge fans out over its
landings, the hop's WHERE scoped at each (`hopFilterKeeps`; its ORDER BY and
LIMIT are not read, as `walkNodePlane` does not read them).

### Parks

`park.rs` writes `ParkedScopeState` version 2 (docs/contracts/park-state.md),
and `resume.rs` reads it. Its run state is written as the TypeScript
engine's version 1 writes it; its code is not. A state either engine parked
resumes only on the engine that parked it (the run row's `engine`). One
state is written for the whole run: the leaf's address
and binding (`presenceBind`, `until`), the scope chain root first, each
scope's own bindings in declaration order, then the frames, innermost last
(a call's site with its finished calls and the callee's scope, a collection
op's member, a combinator arm's join), with nodes and kept walks numbered
once across all of it, as one `serializeBinding` pass numbers them. Code
(a closure, a run-time arm's body, a body-local declaration, a kept walk's
head and mapping) is named by its place in the pinned program, an AST path
(crate::code), and every library the run linked is pinned beside it by the
hash the host's source store keeps its text under (`libraries`,
`park.sources`), so a resume reads the code the run parked with, whatever
the team has saved since. States cross on the wire both ways, so every
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

A suspension (run.ts `suspendFlow`) writes `{version: 2, address,
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
  the eval wire (below), so an event payload's key order holds (a
  `field_miss` lists the keys in it). The event itself arrives on the wire
  too.
- Addresses are address.ts's (`s1.b0.s2`; a block's iteration `j` is `…i<j>…`, `s1.i0.s0`).
- `done` is one of five shapes (below). What the engine does not run it
  refuses before any request, declines before anything the host can see,
  or fails mid-run ("Refusals" above); the run fails, and no other engine
  runs it.

### Errors a run can meet mid-run

The MOVENG_UNSUPPORTED failures are listed under "Refusals" above. Beside
them, a plugin, a file reader or a model that answers a value the wire
cannot carry as data (a class instance, a function), or an adapter that
does, ends the run with `RustShimError` from the shim. (A `Date` an adapter
or the event holds is its ISO text by then: host_adapter.ts `isoDates`.)

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

**The eval wire** (src/env.rs): plain JSON. Null, booleans, finite
numbers and texts stand for themselves; a list is `["l", [items…]]`; an
object `["o", [[key, value]…]]` in the object's own key order. `undefined`,
`NaN`, `±Infinity` and `-0` are `null` (a member holding `undefined` is
left out); a lone surrogate is U+FFFD. Nothing crosses by identity. A file
is `["F", id, {handle, name, contentType, size}]` from the host and
`["F", id]` back; a record whose binding object is data is `["x", id,
descriptor]` to the host and `["x", id]` back. Any other tag, or a bare
object, does not read.

**The JSON text.** Every input, answer and output is JSON text. A string
in what the engine reads may hold a lone surrogate as its `\udXXX` escape
(`JSON.stringify` writes one); the engine reads it as U+FFFD (serde_json
alone refuses it). What it writes is Unicode text, so it holds none.

**The input** (`engine_start`): `{entry: "segment", source, languageVersion,
movementName?, event, segmentId, credentialIds?, spend?, now,
catalog, dryRun?, nativeCheck?, snapshotModels?, versionWarning?, resume?, fire?, settle?, limitPaused?, suspendAt?, serves,
extractionFileChars?, maxCallDepth?, extractionTiers?, limits?}`. `segmentId` is the segment the run host opened (`segment.open`),
named on every host request; `credentialIds` maps an import's credential name
to its id; `spend` is the run's account as the segment starts
(`{priorMicrodollars, capBaselineMicrodollars, capMicrodollars?}`). `dryRun` is a
rehearsal (writes captured, `sleep` fast-forwarded); `nativeCheck` makes the
engine answer `check.program` with the Rust checker instead of asking the host
(off by default; the host turns it on for every run segment);
`snapshotModels` is, with `nativeCheck`, the run snapshot's own `models`
(null: none) the check holds a written model to, and `versionWarning`
(`{code, message}`) a deprecated pin's warning in the host release's words,
which the run traces; `resume` is `{state,
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
deployment's `EXTRACTION_FILE_CHARS`, 50,000 when absent); a date-time
text with no offset is UTC, so the input names no zone; the engine holds no team (the shim names it on the engine's log lines, as the
host's own fact); `fire` and `settle`
run a callback body or settle a deferred race against `resume`'s state;
`maxCallDepth` is how many named calls deep a run may nest from version 3
(call_depth.ts, the deployment's `MOVEMENT_MAX_CALL_DEPTH`);
`extractionTiers` is what the deployment buys for each extraction tier
(ai_tiers.ts, its `EXTRACTION_TIERS` parsed: `{careful: {model?, effort?},
…}`, each member over the built-in row's; the built-in table when absent);
`limits` is what the segment may consume (docs/contracts/run-limits.md:
`{maxSteps?, maxTextBytes?, maxCollectionItems?, maxResultBytes?}`, each
absent one the engine's default).
Other members are ignored.

**Requests and answers.** An answer is `{value}`, `{}` for `undefined`, or
`{error: {message, name?, ref?}}`; `ref` numbers the very error object the
host keeps, so a run that fails with it can name it.

Every request but `check`'s and `log.write`'s carries `segmentId`, and is the
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
| `log.write {lines: [{level, message, fields}]}` | `undefined`: the lines on the platform's log, the run's id added (the engine's own, like `check`) |

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

**How a failure is encoded.** Three places, one rule each:

| what failed | encoding |
|---|---|
| a host call the host **threw** on (a park it could not persist, a lock timeout, a lost lease) | the answer envelope's `{error: {message, name?, ref}}`; the request's future resolves to an `Err`. `ref` numbers the very error the shim holds |
| an adapter call whose **own** result is a failure (`call_ceiling`, `adapter_error`), or a priced call refused as `budget` | data inside `{value}`: `{value: {error: {kind, message, …}}}`, as the host contract answers it; the engine decides what it means |
| the run, at its end | `done`'s `error`: `{class, code?, message}` for an engine error, or `{hostError: ref}` for the error a host call failed with (the shim throws that very object) |

**`done`**:

- `{result: {movementName, writes, extractionSites?, parked?: true, parkedAddress?, cancelled?: true}}`,
  `writes` the firing records on the eval wire, `extractionSites` (when the
  writes cite any) each cited extraction site's summary by site id;
- `{failed: {error, result}}`: the body failed, and `result` is what the run
  had when it did (the shim throws `MovementRunFailed`);
- `{thrown: error}`: it failed before the body ran;
- `{refused: reason}`: the pin is below version 5
  (`language_version_runs_on_typescript`); nothing was asked of the host;
- `{declined: reason}`: the input or the check's answer does not read;
  nothing the host can see has happened ("Refusals" above).

The shim fails the run on either of the last two. Beside any of the first
three, `cost: [{source, microdollars}]` is what the segment's priced calls
spent, by source, for the run's account.

`error` is `{class: "MovementEngineError", code, message}` (`message` without
the `CODE: ` the TypeScript constructor adds), `{class: "Error" |
"RangeError", message}`, `{class: "RunCostCapExceeded", capMicrodollars,
spentMicrodollars}` (the cap met where the run cannot suspend; the shim
builds the TypeScript's error from the figures), or `{hostError: ref}`: the
error a host call failed with, by the `ref` its answer carried. A run that
suspends at its cap ends in a parked `result`.

## Mirroring JavaScript

Version 5 runs as Rust does, not as JavaScript did (CHANGELOG.md, "Language
version 5, Dancing Wren: it runs as Rust does"): the machinery that copied
V8's quirks (its legacy date parser, its regex Annex B, `ryu-js`'s number
printing, ICU's case tables, `Object.prototype` reads, identity across the
host boundary, the `builtins` hand-back to the TypeScript standard library)
is gone. "JavaScript semantics, written out" above is what holds, each row
pinned by its test. What is still the TypeScript's behaviour, on purpose:

- **ORDER BY and `SORT` over mixed key kinds** land where JavaScript lands
  them: crate::order_limit runs V8's ArrayTimSort step for step (galloping
  and the shared `minGallop` included). tests/frozen/mixed_sort.jsonl (400
  seeded key lists, 1 to 2,000 keys; tests/mixed_sort_frozen.rs).
- **A fractional `EXTRACTION_FILE_CHARS`**: the shim passes the number as
  written; the text is cut where `slice` truncates it, and the marker prints
  the number itself (`first 2.5 of …`). tests/frozen/file_bound.jsonl
  (tests/file_bound_frozen.rs).
- **Extraction call-site numbering**: a site is numbered when its region is
  planned, as the TypeScript numbers it, so the order is the order the host
  answers (the tree's order wherever the host answers in the order asked).
- **A `Date` an adapter or the event holds** is its ISO text (`null` when
  invalid), made at the engine's side of the host boundary (host_adapter.ts
  `isoDates`), so no `Date` is on the wire.
- **Two names for one write handle across a park**: a park writes one
  handle once and a second sighting as `{kind: 'handleRef', id}`; the
  reader makes the one handle from the descriptor that numbers it.
- **Which members of a parked state hold files** is a name list in the shim
  (rust_wire.ts `filesInParkState`, `PARKED_DATA_MEMBERS`): a future
  descriptor whose new data member is left off the list is walked into.
  Open (S): a walk typed per descriptor kind.

### Known divergences

Where a version 5 run here answers differently from the TypeScript engine
on the same program, beyond the version 5 changes above (the TypeScript
engine wrote the version 5 corpora's expectations). A refusal is not one:
"Refusals" above lists each, and the run fails.

**Answers that may differ (Henry's ruling, 2026-10-12):**

| the reading | how it may differ | why it is kept |
|---|---|---|
| `CHUNKS(text, { entities: n })`'s cut and its trace's `expectedEntities` | the estimate reads letters, numbers and capitals with Rust's `is_alphanumeric` and `is_uppercase` (the TypeScript's regex reads Unicode's `Lu`), so on text with an uncommon uppercase letter a proper-noun run may count differently and a piece boundary move by a line. The size mode, the links and the list items are exact | a regex dialect grown for one estimate was ruled out; tests/frozen/chunks.jsonl holds the size mode on any text and the entities mode on ASCII text |
| the order of edge names inside a stored copy plan (a parked closure's graph spread, `edges` in `{ fields, edges }`) | the TypeScript writes them in declaration order, this engine in sorted order (the wire does not carry the declaration order, program.rs `copy_plan_js`); the park is byte-equal across engines everywhere else | Henry's ruling, 2026-10-14: the order is not significant: a copy plan's edges are a set |

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

Every run segment the host opens sets `nativeCheck`: the engine checks the
program itself with the Rust checker (crates/movement-checker), against the
run's own snapshot, and a program that fails it ends with MOVENG_CHECK (or
MOVENG_PARSE, MOVENG_LANGUAGE_VERSION) before anything else is asked. In
process the run host has already checked it (run.ts `checkPinned`), so a
program that fails has made no host request. Without `nativeCheck` the
segment asks for the check: `check.program {source, languageVersion,
upgradingFrom?}`, answered `{diagnostics, link?, stamps}` (apps/api's
program_check.ts); a program that fails it never gets an answer, and the
host ends the run with the check's error. The request carries no segment,
so an embedder may answer it, or check, before its own `segment.open`.

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

The TypeScript side: `packages/movement-engine/services/movement_engine/__test__/rust_engine.unit.test.ts`
(the shim against a scripted double, and its routes against the host
manifest), `rust_engine_abi.unit.test.ts` (the committed artifact), `rust_run.unit.test.ts` and `rust_write.unit.test.ts`
(whole runs on both engines, compared). The oracle for the evaluator and the
runs is the version 5 conformance corpus.

**Running a corpus case on Rust.** In apps/api, after
`scripts/build-movement-wasm.sh` if a crate changed, run the version 5
conformance corpus and the engine's unit suites (`pnpm test:unit
--testPathPattern movement_engine`). The Rust engine is the only engine for
version 5, so there is no engine setting to pass; the TypeScript engine stays
as the reference the version 5 corpora were checked against.

