# movement-engine

The movement engine in Rust. A segment of a run executes inside one WASM
instance and asks its TypeScript host for everything outside the program;
`apps/api/src/services/movement_engine/rust_engine.ts` is the host side.

Under `MOVEMENT_ENGINE=rust` the engine runs two things:

- **an expression** over value bindings, which the TypeScript evaluator hands
  to `eval_expression` (slice 1, "The evaluator" below);
- **a whole run** of a program the shim's `rustCanRun` admits: bindings, `if`
  and `return` over reads of the event and of values (slice 2a, "The run"
  below). Writes are the next slice, so no conformance program qualifies yet
  (every one writes); apps/api's `rust_run.unit.test.ts` holds these runs to
  the TypeScript engine.

## Modules

| module | what |
|---|---|
| `executor` | a single-threaded async runtime: the segment is one future; a `HostCall` future registers its request and yields; `join_all` keeps several in flight |
| `host` | one request builder per host call, named after the `EngineHost` groups (`adapters`, `llm`, `park`, `control`, `files`, `lookup`, `locks`) |
| `value` | the value model (data, record, list, map, absent), its JSON the parked state's `ValueDescriptor` |
| `abi` | the C ABI: `engine_start`, `engine_answer`, `engine_finish`, `eval_expression` |
| `eval` | `evalMovementExpr` over the host-free kinds, with its provenance rules and errors |
| `stdlib` | the 17 flat built-ins and all 15 namespaced members |
| `run` | the `segment` entry: `runMovement` for the programs the shim admits (below) |
| `bindings` | what a name in a run is bound to, the lexical scopes, the source `Position` |
| `trace` | the `MovementTraceEntry` kinds a run appends (`warning`, `gate`, `field_miss`) |
| `program` | the pinned source parsed, joined with the `check.program` host call's answer: diagnostics, the import link, the checker's stamps by AST path |
| `env_services` | `EnvServices`: zones, WHATWG URLs, locale numbers, Unicode normalisation, from the JavaScript runtime (WASM) or natively (below) |
| `filter` | packages/shared/expression/filter.ts: `compareValues`, `compareToNull`, `evaluatePredicate` |
| `env` | value bindings in scopes with a parent chain; the wire values and trails cross on |
| `js`, `js_date`, `js_regex` | the JavaScript semantics the TypeScript leans on, written out (below) |

## One artifact

This crate's `.wasm` is the only movement artifact
(`packages/movement-lang/wasm/movement.wasm`): it links in crates/movement-parser,
whose `#[no_mangle]` exports (the parses, the lowering, the catalog query,
`alloc`, `dealloc`, `last_panic`) come through unchanged. The loader
(`packages/movement-lang/wasm/loader.ts`) compiles it once; the parser keeps
one long-lived instance of it, and each engine segment gets a fresh one.

Measured 2026-10-07 (gzip -9):

| artifact | raw | gzipped |
|---|---|---|
| the parser crate alone | 1,182,582 | 321,745 |
| this crate (the parser included), the protocol only | 1,222,941 | 336,866 |
| this crate with the evaluator (slice 1) | 1,581,987 | 426,071 |
| slice 1, fix round 1 (`ryu-js`, bounded regex parsing) | 1,593,666 | 438,383 |
| slice 2a (environment services, the check, the run) | 1,751,210 | 488,922 |
| slice 2a, fix round 1 | 1,751,076 | 488,997 |

The evaluator added about 89 KB gzipped (reading the lowered `Expression`
back, the standard library, the regex matcher, Unicode case tables). The
total is under the 600 KB warning line, but no longer far under it: the
browser needs only the parser, so the next slice that grows it should weigh
splitting into two artifacts.

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
| `echo` | issues each of `requests` (`{family, method, args}`) at once, finishes with `{answers}` in the answer envelope |
| `panic` | panics with `message`: the loader's trap path, provable against the real artifact |

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

## The run

`run::segment` takes run.ts's steps in run.ts's order, and every step the
TypeScript takes through its host is a host request here:

| request | when | answered by the shim from |
|---|---|---|
| `check.program` | first | program_check.ts (below) |
| `adapters.credentialId`, `adapters.resolve` | the source instance (`prepareMovement`) | `host.adapters`; the answer carries the handle and the adapter's `adapterType` |
| `adapters.call` (`wire: true`) `listEntryPoints` | a discriminated event (`naturalRootTypeName`) | the live adapter |
| `trace.append` | each trace entry, as it lands | pushed onto `host.trace` (the run's trace) |
| `control.cancelled` | before each statement | `host.control.cancel.cancelled()` |
| `adapters.call` (`wire: true`) `getFieldValue` | each read of an event field, in evaluation order | the live adapter, through the surface-read wrapper's restamp (done here) |
| `builtins.function`, `builtins.compare` | a built-in reading this engine hands back (V8's date parser, local time, a regex feature) | the TypeScript member itself |
| `control.cancelledNow` | the last check | `host.control.cancel.cancelledNow()` |

- An expression is evaluated by the one evaluator. What it cannot answer
  itself it asks (`eval::Reader`); the evaluation stops, the run asks the
  host, and the expression is evaluated again from the start with the answers
  so far. So the host sees the TypeScript's calls in the TypeScript's order,
  short-circuits included, and no expression needs to be async.
- `adapters.call` with `wire: true` carries its arguments and its answer on
  the eval wire (below): an event payload's key order (a `field_miss` lists
  the keys in it), `undefined` and the numbers JSON cannot say cross as the
  JavaScript has them. The event itself arrives on the wire too.
- Addresses are address.ts's (`s1.b0.s2`), kept for the parks to come.
- `done` is one of four shapes (below). Before it touches anything the host
  can see, the engine refuses what it does not run (`run::declined_by`, its
  own guard behind the shim's allow-list) as `declined`, and the shim runs
  the program on the TypeScript engine.
- `rustRunStats` counts what the shim routed, declined and asked (by
  `family.method`); the conformance teardown prints it beside the evaluator's.

### Errors a run can meet mid-run

These end a run partway through, after it has made adapter calls, where the
TypeScript engine would carry on. Each comes back as an error (the run
fails); none produces a different answer.

- An adapter answers a value the eval wire cannot carry as itself (a
  `Date`, a class instance, a function): `RustShimError` from the shim.
- A value held in a binding is shaped like an engine binding (an object
  whose `kind` names one, the TypeScript's `bindingOf`): reading its field,
  comparing it by `==`, or spreading it fails with MOVENG_UNSUPPORTED ("this
  reading (…) is not supported…"). TypeScript reads such a dict as a record.
- A field read off a held object names one of `Object.prototype`'s members
  it does not own (`meta.\`constructor\``): MOVENG_UNSUPPORTED. TypeScript's
  `value[field] ?? null` finds the prototype's member.
- A record compared by identity (`a == b` where either is binding-shaped):
  MOVENG_UNSUPPORTED. TypeScript compares two records by identity.

None of these is a built-in's reading, so none can be handed to the
TypeScript member (`builtins.*`); each needs the record model a later slice
brings.

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
movementName?, event, teamId, now, catalog}`. `languageVersion` is the pin,
written out (the engine does not know the release's current one); `event`
is the `TriggerEvent` on the eval wire; `now` is the run's pinned instant as
a `toISOString` text (`firedAt`, else when the run began); `catalog` is the
`CatalogSnapshot`. Other members are ignored.

**Requests and answers.** An answer is `{value}`, `{}` for `undefined`, or
`{error: {message, name?, ref?}}`; `ref` numbers the very error object the
host keeps, so a run that fails with it can name it.

| request (family.method, args) | answer |
|---|---|
| `check.program {source, languageVersion, upgradingFrom?}` | `{diagnostics, link?, stamps}` (below); a program that fails its check gets no answer: the host ends the run with the check's error |
| `adapters.credentialId {credentialName}` | the credential's id, or `undefined` |
| `adapters.resolve {adapterType, teamId, credentialsId?, constructionArgs?, role: "source" \| "target"}` | `{instance, adapterType}`: the handle, and the live adapter's own `adapterType` |
| `adapters.call {instance, method, args}` | the method's result as plain JSON (anything else fails the run in the shim) |
| `adapters.call {instance, method, args, wire: true}` | `args` on the eval wire, the result too |
| `control.cancelled {}` / `control.cancelledNow {}` | a boolean: the cancel gate, debounced / not |
| `trace.append {entry}` | `undefined`; `entry` is `{kind: "warning", code, message}`, `{kind: "gate", outcome}` or `{kind: "field_miss", binding, field, available: [key…]}` |
| `builtins.function {id, args, now, languageVersion}` | `{value}` or `{threw: {class: "MovementEngineError" \| "Error" \| "RangeError", code?, message}}`: the TypeScript member's value or what it throws; `id` is the lowered function id (`date.format_iso`, `trim`), `args` on the eval wire, the value too |
| `builtins.compare {op, left, right}` | the same two shapes, for `compareValues(left, op, right)`; `op` a `FilterOperator` |

**`done`**:

- `{result: {movementName, cancelled?: true}}`;
- `{failed: {error, result}}`: the body failed, and `result` is what the run
  had when it did (the shim throws `MovementRunFailed`);
- `{thrown: error}`: it failed before the body ran;
- `{declined: reason}`: nothing the host can see has happened; run the
  program another way.

`error` is `{class: "MovementEngineError", code, message}` (`message` without
the `CODE: ` the TypeScript constructor adds), `{class: "Error" |
"RangeError", message}`, or `{hostError: ref}`: the error a host call failed
with, by the `ref` its answer carried.

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
engine asks of `EnvServices` (src/env_services.rs), four operations:

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
cargo test -p movement-engine     # the executor, builders, value model, evaluator, ABI and environment services, natively
```

The TypeScript side: `apps/api/src/services/movement_engine/__test__/rust_engine.unit.test.ts`
(the shim against a scripted double), `rust_engine_abi.unit.test.ts` and
`rust_eval.unit.test.ts` (the committed artifact). The oracle for the
evaluator is the conformance corpora run with `MOVEMENT_ENGINE=rust`
(`pnpm test:conformance:v1` / `v2` in apps/api).
