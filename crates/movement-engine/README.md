# movement-engine

The movement engine in Rust. A segment of a run executes inside one WASM
instance and asks its TypeScript host for everything outside the program;
`apps/api/src/services/movement_engine/rust_engine.ts` is the host side.

The first slice of language semantics is the pure evaluator: an expression
over value bindings, which the TypeScript evaluator hands to `eval_expression`
when `MOVEMENT_ENGINE=rust` (see "The evaluator" below). `rustCanRun` (in the
shim) still admits no whole program, and the only segment entries are the
protocol's probes (`echo`, `panic`).

## Modules

| module | what |
|---|---|
| `executor` | a single-threaded async runtime: the segment is one future; a `HostCall` future registers its request and yields; `join_all` keeps several in flight |
| `host` | one request builder per host call, named after the `EngineHost` groups (`adapters`, `llm`, `park`, `control`, `files`, `lookup`, `locks`) |
| `value` | the value model (data, record, list, map, absent), its JSON the parked state's `ValueDescriptor` |
| `abi` | the C ABI: `engine_start`, `engine_answer`, `engine_finish`, `eval_expression` |
| `eval` | `evalMovementExpr` over the host-free kinds, with its provenance rules and errors |
| `stdlib` | the 17 flat built-ins and 14 namespaced members (`DATETIME.AT` excepted) |
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
  languageVersion?, clock?: {today: {zone: {value} | {error}}}}`.
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
- `DATE.TODAY(zone)` is answered from `clock`: the shim works the date out
  from the run's pinned instant with the TypeScript member, because the
  zone database is not in the artifact. A segment asks the same of the host
  as `clock.now {zone}` (answered `{nowIso, zone, today}`).

The wire (env.rs has the details) carries what JSON cannot: `undefined`,
`NaN`, `±Infinity`, `-0`, key order, and identity. Identity matters because
`===` compares objects by it: the caller's own objects come back as
themselves (`["i", id]`). Provenance crosses as origin ids: the caller numbers
its origins, the engine mints one id per literal it evaluates, and a name, a
branch or a `COALESCE` passes its binding's trail through as `{binding}`.

### JavaScript semantics, written out

| what | how it is handled |
|---|---|
| `Number(text)` | StringToNumber by hand: JS whitespace trimmed, `""` → 0, `"  12 "` → 12, `"1e3"`, `".5"`, `"5."`, `0x`/`0o`/`0b` (unsigned only, rounded once), `Infinity` (case-sensitive), else NaN; Rust's `parse` sees only validated decimal digits |
| `String(number)` | shortest round-trip digits (Rust's `{:e}`), laid out by Number::toString: plain to 21 digits, `1e+21` past it, `0.000001` but `1e-7`, `-0` → `0`, `NaN`, `Infinity` |
| `String(value)` | arrays join with `,` (null and undefined members empty), objects `[object Object]` |
| `===`, `includes`, `Set` | strict equality (NaN not itself, `-0 === 0`), SameValueZero for membership, objects by identity (`Rc`) |
| truthiness | `0`, `-0`, `NaN`, `""`, null, undefined are false |
| `Math.round` | half toward +∞ (`-2.5` → `-2`), `-0` for a negative that rounds to zero; not Rust's `round` |
| `toFixed` (NUMBER.FORMAT, CURRENCY) | the double's exact decimal expansion rounded half up (`0.25` → `0.3`); not Rust's `{:.1}`, which rounds half to even |
| `%` | Rust's `%` is fmod, the dividend's sign, as JavaScript's |
| object key order | array-index keys ascending first, then insertion order; a repeated key keeps its place |
| `trim`, `\s` | JavaScript's WhiteSpace + LineTerminator set (with U+FEFF, without U+0085); not `char::is_whitespace` |
| `.length`, `<` on text | UTF-16 code units; comparison in code-unit order |
| `split("")` | per UTF-16 unit: BMP text splits per character, astral text goes back to TypeScript |
| `toLowerCase`/`toUpperCase` | Rust's Unicode case mapping (special casings and the final sigma, as V8); a character newer than one side's Unicode tables could differ |
| `new Date(text)` | the ISO forms V8's spec parser reads (`YYYY-MM-DD`, `…THH:mm[:ss[.f…]]` with `Z`/`±HH:mm`; day 31 rolls over, `24:00`, three fraction digits kept); a text with no digit is Invalid; anything else (V8's legacy parser, a date-time without offset = local time) goes back to TypeScript |
| `Date.UTC` round trip | `validParts` refuses years 0–99 (Date.UTC reads them as 19xx), months outside 1–12, days past the month |
| `toISOString` | six-digit signed years outside 0000–9999; an instant past ±8.64e15 ms throws `RangeError: Invalid time value` (DATE.ADD_DAYS) |
| regexes (TEXT.REGEX_EXTRACT) | a backtracking matcher over UTF-16 units with Annex B syntax: each iteration of a group clears its captures, an empty iteration ends a loop, `.` stops at line terminators. Invalid patterns are null, as `new RegExp` throws; lookbehind, named groups, octal and `\c` escapes, an escape class at a range end, and a match past its step/depth budget go back to TypeScript. No corpus text uses the function. |
| `URL` (URL.HOST) | WHATWG parsing for special schemes with ASCII hosts: slashes and backslashes, userinfo, ports, forbidden host code points, lower-casing. IDNA, percent-encoded hosts, IPv4/IPv6, `file:` and non-special schemes go back to TypeScript |
| `normalize("NFKD")` (TEXT.SLUG) | ASCII is its own NFKD; non-ASCII text goes back to TypeScript |
| `JSON.stringify` (TEXT.SERIALISE) | its quoting and two-space layout; keys sorted by UTF-16 unit, then laid out in object order (index keys first) as `Object.fromEntries` does |
| object-literal prototypes | `MAGNITUDE_SUFFIXES["constructor"]` is `Object`, so `"5 constructor"` is NaN; `MONTH_NAMES["constructor"]` fails `validParts` like no month |
| a dict whose `kind` names a binding kind | the TypeScript reads it as a record (`bindingOf`): its `==`, spreads and record arguments go back to TypeScript, and the shim sends no such value |

`tests/stdlib_oracle.rs` holds the standard library and the comparator to the
TypeScript's own answers over 9,132 hazardous inputs (tests/oracle/stdlib.json,
written by tests/oracle/generate.ts).

## Building and testing

```bash
scripts/build-movement-wasm.sh    # the artifact, its sha256 and size
cargo test -p movement-engine     # the executor, builders, value model, evaluator and ABI, natively
```

The TypeScript side: `apps/api/src/services/movement_engine/__test__/rust_engine.unit.test.ts`
(the shim against a scripted double), `rust_engine_abi.unit.test.ts` and
`rust_eval.unit.test.ts` (the committed artifact). The oracle for the
evaluator is the conformance corpora run with `MOVEMENT_ENGINE=rust`
(`pnpm test:conformance:v1` / `v2` in apps/api).
