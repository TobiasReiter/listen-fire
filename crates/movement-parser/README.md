# movement-parser

The movement-language parser and expression lowering in Rust, compiled to
WASM and called from TypeScript through `packages/movement-lang/wasm/loader.ts`.

## Modules

| module | what |
|---|---|
| `lexer`, `expr`, `stmt`, `tree`, `ast`, `scan` | the parser: statement and expression grammars, their JSON shapes |
| `lowering` | the expression tree → the shared `Expression` (packages/shared/expression/types.ts); the only lowering since `parser/expression/lower.ts` became its wrapper |
| `abi` | the C ABI over both |

`lowering/vocabulary/data.rs` (the stdlib families, the FILE/READ and
options-map contracts, the AI tiers) is generated from the TypeScript
declarations by `packages/movement-lang/parser/expression/__test__/lowering_vocabulary.unit.test.ts`,
which pins it: run that test with `UPDATE_LOWERING_VOCABULARY=1` after
changing expression/stdlib.ts, then rebuild the WASM.

## Toolchain

Pinned in the repo-root `rust-toolchain.toml`; recorded 2026-10-06:

| tool | version |
|---|---|
| rustup | 1.29.1 (d95a37b6a 2026-08-13) |
| rustc | 1.99.0 (b940084d7 2026-09-28) |
| cargo | 1.99.0 (5f94df478 2026-08-27) |
| target | wasm32-unknown-unknown |

No wasm-bindgen and no wasm-pack: the crate exports a hand-written C ABI.

## Building

```bash
scripts/build-parser-wasm.sh   # release build → packages/movement-lang/wasm/movement_parser.wasm, prints sha256
cargo test -p movement-parser  # native unit tests
```

The `.wasm` is committed so the pnpm dev loop needs no Rust. CI
(`.github/workflows/parser-wasm.yml`) rebuilds it and fails when the bytes
differ, so a change to the crate, `Cargo.lock`, the release profile or the
toolchain ships with a rebuilt artifact.

The web app copies the artifact into `apps/web/public` (under a content-hashed
name) when `next.config.ts` loads, so a running `next dev` keeps serving the old
parser until it is restarted.

## Reproducibility

The committed artifact is built on a laptop; `--remap-path-prefix` in the build
script and the pinned toolchain are meant to make the Linux CI rebuild
byte-identical. That is unproven until the first green run of
`.github/workflows/parser-wasm.yml`, which fails with the two hashes when they
differ.

## The ABI (`src/abi.rs`)

| export | signature | |
|---|---|---|
| `alloc` | `(len) -> ptr` | caller writes UTF-8 input here |
| `dealloc` | `(ptr, len)` | frees an input or an output buffer |
| `parse_program` | `(src_ptr, src_len, version, out_ptr_ptr, out_len_ptr) -> status` | the `Program` as ast.ts types it; slots are `{raw, span}` |
| `parse_program_eager` | as `parse_program` | the same `Program`, each slot also carrying `tree` (its `MExpr`) or `error` (`{message, pos}`) |
| `parse_expression` | `(src_ptr, src_len, version, out_ptr_ptr, out_len_ptr) -> status` | |
| `parse_nested_call` | `(raw_ptr, raw_len, at_start, at_end, origin_line, origin_col, version, out_ptr_ptr, out_len_ptr) -> status` | |
| `lower_expression` | `(tree_ptr, tree_len, src_ptr, src_len, out_ptr_ptr, out_len_ptr) -> status` | the tree's JSON and its source text in; the `Expression`, or `{"error": {message, code?, class?}}` |
| `lower_condition` | as `lower_expression` | the `MovementCondition` |
| `last_panic` | `(out_ptr_ptr, out_len_ptr)` | the last panic's message, in a static buffer (not freed) |

Status 0 means the output is the tree; 1 means it is `{"error": {…}}`. The
output is UTF-8 JSON the caller must `dealloc`. Every value is an i32 on
wasm32. A lowering refusal's `class` is absent for a `LoweringError`,
`"BridgeError"` for a built-in call's static shape (the TypeScript's
expression/call_shape.ts, now ported, threw that class), and `"MalformedTree"` when the input was not a tree.

A panic aborts (`panic = "abort"`), which traps the instance. A panic hook
records the message first; the loader reads it through `last_panic` from the
trapped instance, puts it in the error it throws, then discards the instance
and instantiates a fresh one on the next call.

## Stack and nesting

The grammar is recursive descent, bounded by `MAX_DEPTH` (128, in
`src/lexer.rs`): a deeper text is the syntax error `expression nesting too
deep`. Two stacks are at stake in WASM. The engine's own (V8 throws a
`RangeError` at about 450 levels of parentheses on Node's default stack) and
the shadow stack in linear memory, which the build script places first
(`--stack-first`) and sizes at 2 MiB; at the limit the deepest texts use
512–768 KiB of it. The statement grammar shares the same counter; its
deepest constructs at the limit (nested blocks, callbacks, closures in
collection calls) need 256–512 KiB (measured 2026-10-06 with 256 KiB and
512 KiB builds), and a slot's expression is parsed only after the
statement parse returns, so the two never stack. Overflowing the shadow
stack is an out-of-bounds trap, which hangs Node 22 on macOS rather than
throwing, so the limit must stay well inside it.

## JSON output

The parser's keys are sorted recursively. Emit through `to_sorted_json`: it
goes via `serde_json::Value`, whose `Map` is a `BTreeMap` while serde_json's
`preserve_order` feature is off (the default, and kept off). A derived
`Serialize` alone would write struct fields in declaration order.

The lowering's are NOT sorted: it writes its typed values directly, each
struct's fields declared in the order the TypeScript lowering built the
object, and a hop's `{ … }` settings (`config`, and `config.extra`) as
`IndexMap`s in the order they were written — the one place the order is the
source's. A consumer that walks or stringifies an `Expression` sees what it
saw from the TypeScript (the differential compared the stringified values).

The lowering reads its tree by hand from a `serde_json::Value`
(`lowering/read.rs`) rather than through derived `Deserialize`s, which more
than doubled the artifact. Measured 2026-10-07: the parser alone was 442,538
bytes; with the lowering through derived `Deserialize`s, 944,142; read by
hand, 708,832; with the vocabulary as generated Rust rather than parsed
JSON, 647,732 (215,621 gzipped, against 144,677).

## JavaScript semantics in the lowering

The lowering's refusal messages are the TypeScript's, and some of its rules
read text, so these are reproduced explicitly:

- **UTF-16 offsets.** A tree's `at` indexes its source in UTF-16 units; the
  `IS` subject, an `IS` address's hop text and a `#linked` WHERE are sliced
  that way (`util::utf16`). A duration's unit is "the last unit lowercased"
  (`js::lowercase_last_unit`), which leaves half an astral character alone.
  An option key's did-you-mean counts edits in UTF-16 units.
- **Whitespace.** `trim()` and the regexes' `\s` are JavaScript's set
  (U+FEFF in, U+0085 out), not Rust's.
- **Regexes.** None run; each is reproduced by hand: `/^[A-Za-z_][A-Za-z0-9_]*$/`
  (a plain hop label), `/^[A-Z][A-Z0-9_]+$/` (namespace-shaped),
  `/^(ASC|DESC)$/i`, `label.split(/[:\s]/, 1)` (an ending hop's base), and the
  three `#linked` adapter regexes with their leftmost-match order. `/i`
  without the `u` flag folds ASCII only.
- **Numbers.** A number in a message prints as `String(x)` does
  (`js::number_to_string`: `1e+21`, `1e-7`, `0.1`); Rust's `{}` differs at
  both ends. The tree's numbers are parsed with serde_json's
  `float_roundtrip`, without which a decimal can come back one ULP off. An
  integral number up to 2^53 is written as an integer, past it as a float;
  `JSON.parse` reads either as the same number.
- **Case.** `toUpperCase`/`toLowerCase` are Rust's `to_uppercase`/
  `to_lowercase` — both the full Unicode mapping, final sigma included.
- **Object keys.** `extra.__proto__ = v` set the TypeScript object's
  prototype instead of adding a key, so the lowering drops that key. One
  TypeScript quirk is NOT reproduced: a `_resources` WHERE name looked up on
  a plain object found `constructor` (and `__proto__`) on Object.prototype and
  lowered to a `resource` read with no field; the lowering refuses it as an
  unknown property, as the table means (reported for a ruling, 2026-10-07).
- **Lone surrogates.** A source holding one reaches the WASM as U+FFFD
  (`TextEncoder`), so a slice of it differs from the JavaScript's. The parser
  has the same boundary.

## Depth

The lowering recurses once per tree level, as the TypeScript did; the
grammar bounds nesting (`MAX_DEPTH`), but not a chain (`a.b.c…`, `a + b +
…`). Measured 2026-10-07: a chain of about 2,200 members or 2,400 operators
exhausts the engine's stack (a `RangeError`, thrown as "movement parser
crashed"), where the TypeScript lowering reached the parser's own limit of
about 2,600.
