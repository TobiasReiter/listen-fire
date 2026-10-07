# movement-parser

The movement-language parser and expression lowering in Rust, compiled to
WASM and called from TypeScript through `packages/movement-lang/wasm/loader.ts`.

## Modules

| module | what |
|---|---|
| `lexer`, `expr`, `stmt`, `tree`, `ast`, `scan` | the parser: statement and expression grammars, their JSON shapes |
| `lowering` | the expression tree → the shared `Expression` (packages/shared/expression/types.ts); the only lowering since `parser/expression/lower.ts` became its wrapper |
| `catalog` | the checker's catalog: the schema types (checker/catalog.ts), a snapshot's lookups (service/snapshot.ts `fromCatalogSnapshot`) and the pure catalog helpers; proven by checker/__test__/catalog_differential |
| `util` | UTF-16 text, the JavaScript semantics both lean on, bounded JSON reads |
| `abi` | the C ABI over all three |

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

## Size budget

Current: about 1.18 MB raw, about 322 KB gzipped. CI measures the committed
`.wasm` gzipped (`parser-wasm.yml`, "Size budget"): it warns above 600 KB
(614,400 bytes) and fails above 1 MB (1,048,576 bytes), printing raw and
gzipped sizes either way. Policy: if the budget is approached, the checker port
replaces serde derives with hand readers, as the lowering already did.

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
| `catalog_query` | `(snapshot_ptr, snapshot_len, query_ptr, query_len, out_ptr_ptr, out_len_ptr) -> status` | one lookup (`{op: "instantiate" \| "adapter" \| "credential" \| "credentialNames" \| "plugin" \| "models" \| "constructionArgOptions", …}`) or helper call (`{op: "helper", name, args}`) against the snapshot; `{"value": …}`, `{}` for `undefined`, or `{"error": {message}}`; nothing is kept between calls |
| `last_panic` | `(out_ptr_ptr, out_len_ptr)` | the last panic's message, in a static buffer (not freed) |

Status 0 means the output is the tree; 1 means it is `{"error": {…}}`. The
output is UTF-8 JSON the caller must `dealloc`. Every value is an i32 on
wasm32. A lowering refusal's `class` is absent for a `LoweringError`,
`"BridgeError"` for a built-in call's static shape (the TypeScript's
expression/call_shape.ts, now ported, threw that class), and `"MalformedTree"` when the input was not a tree (not UTF-8, not JSON, nested past 2,048 levels, or not a tree's shape).

A tree the lowering cannot read (past the 2,048-level JSON bound or an unknown
shape) surfaces to TypeScript as a plain `Error`, not a `BridgeError`, so
apps/api aborts the run loudly rather than degrading. The invalid-UTF-8
refusal's `pos` is a byte offset (serde's `valid_up_to`), unlike every other
offset, which is in UTF-16 units; only raw `Uint8Array` callers can reach it.

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
throwing, so the limit must stay well inside it. JSON reads are bounded at
2,048 levels (see Chains).

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
  prototype instead of adding a key, so the lowering drops that key. A
  JavaScript object lists array-index keys (`"0"` to `"4294967294"`,
  canonical decimals) first, ascending, then the rest as inserted; `extra`
  is reordered so (`js::object_key_order`). One
  TypeScript quirk is NOT reproduced: a `_resources` WHERE name looked up on
  a plain object found `constructor` (and `__proto__`) on Object.prototype and
  lowered to a `resource` read with no field; the lowering refuses it as an
  unknown property, as the table means (reported for a ruling, 2026-10-07).
- **Lone surrogates.** A source holding one reaches the WASM as U+FFFD
  (`TextEncoder`), so a slice of it differs from the JavaScript's. The parser
  has the same boundary.
- **Prototype keys.** `constructor`, `__proto__` and the like are not
  properties in Rust; the TypeScript leaked them off `Object.prototype`.
  This is a recorded behaviour change (see the CHANGELOG).

## Chains

The grammar bounds nesting (`MAX_DEPTH`) but reads a chain (`a.b.c…`,
`a + b + …`, `f(x).g(y)…`, a path's hops) with a loop, so a chain's depth in
the tree is unbounded by it, and everything after the parse recurses once
per level: the tree's JSON write, the lowering's JSON read and tree read,
the lowering itself and its JSON write. Measured 2026-10-07: about 2,200
levels exhausted the engine's stack in the lowering, 2,630 in the parser.

So a tree may be at most `MAX_CHAIN` (1,024, in `src/tree.rs`) levels deep,
a path's hops counting one level each (each is a level of the lowering) and
a call taking at most 1,024 arguments. Past it:

- the parser refuses the text with the syntax error `chain too long`, after
  building the tree with its loops and checking it with a heap-stack walk;
- the lowering refuses a tree it is handed with the `LoweringError` `chain
  too long`; it first refuses, as a malformed tree, JSON nested deeper than
  2,048 levels (`util::json::MAX_DEPTH`, twice the chain limit, which admits every
  tree the parser builds), so it never recurses over one;
- a tree is dropped level by level from a heap stack (`impl Drop for
  MExpr`), so a refused chain, or a parse that fails after building one, is
  freed without recursing.

A chain continued through parentheses is one chain: the bound is the tree's
depth, not one loop's count.

## The catalog

`catalog::types` is checker/catalog.ts's schema types and service/snapshot.ts's
`CatalogSnapshot`, field for field. A member the TypeScript does not declare
is refused when a snapshot loads (the TypeScript would pass it through, so
dropping it would be a silent disagreement), and so is a schema field typed
with what only the checker's typing builds (a union, a record).

Every object keyed by data is a `JsMap`: the order a JavaScript object holds
its keys in, since a diagnostic lists a position's fields in schema order.
That rules out a `serde_json::Value` anywhere data is read, because its maps
are sorted (`preserve_order` is off for `to_sorted_json`); the catalog reads
its inputs from their text (`util::json::from_json`, `RawValue` for the
parts read later). Its answers are written in the data's order too; the
differential canonicalises, and separately compares every data map's key
order.

`catalog::snapshot::instantiate` is `fromCatalogSnapshot`'s: the credential
argument (backtick-unwrapped) picks the schemas, the entry position the
position arguments pin picks among them, and a positioned key that is
missing falls back to the credential's unpositioned one. A credential with
no schema is no schema, never another credential's.

The differential replays every corpus record through the TypeScript checker
with its catalog and helpers recording, and asks the Rust the same; run it
with `MOVEMENT_CATALOG_DIFFERENTIAL=1` (CI's parser-tests job does). Not
compared: a `describeFieldType` or `variantOf` of a record type carrying its
position (the typing layer's `PositionTypeRef`, with sets and instance
tokens) — describing one is refused here until the typing layer is ported.

### JavaScript semantics in the catalog

- **Key order.** `JsMap` reads in JavaScript's order: array-index keys
  (`"0"`–`"4294967294"`) first, ascending, then the rest as written
  (`util::js::object_key_order`). `declaredTypesIn` is a `Map`, so it keeps
  plain insertion order.
- **Nesting limit.** Typed catalog reads are bounded at 256 levels; past it
  the answer is a clean refusal naming the limit.
- **`<` on strings.** `unionVariants` and `refinementKey`'s key sort compare
  UTF-16 units (`util::js::cmp_utf16`), not code points: an astral character
  sorts before U+E000–U+FFFF.
- **`localeCompare`.** `entryPositionKeyOf` sorts position-argument names
  with it. `util::js::locale_compare` reproduces Node's ICU order for ASCII
  (spaces and punctuation, then digits, then letters with case ignored until
  everything else ties, lower case first; control characters ignored), read
  off Node 22 on 2026-10-07. Outside ASCII it falls back to code points,
  where ICU sorts an accented letter with its base letter; TypeScript aligns to
  code-point order when the checker port replaces it. The sort only
  matters for an adapter with two or more position arguments — none in the
  corpus has more than one — and a name outside ASCII; either side would
  then key the schema differently.
- **`JSON.stringify`** of the position key and the refinement key: serde_json
  escapes strings the same way; numbers print as `String(x)` does.
- **`trim()`** is JavaScript's whitespace, as in the lowering.
- **Prototype keys.** The TypeScript looks names up on plain objects, so
  `instantiate` with a credential named `constructor` finds
  `Object.prototype.constructor` and answers it as a schema; the Rust finds
  no such schema. No corpus call names one.

