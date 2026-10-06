# movement-parser

The movement-language parser in Rust, compiled to WASM and called from
TypeScript through `packages/movement-lang/wasm/loader.ts`.

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

## The ABI (`src/abi.rs`)

| export | signature | |
|---|---|---|
| `alloc` | `(len) -> ptr` | caller writes UTF-8 input here |
| `dealloc` | `(ptr, len)` | frees an input or an output buffer |
| `parse_program` | `(src_ptr, src_len, version, out_ptr_ptr, out_len_ptr) -> status` | the `Program` as ast.ts types it; slots are `{raw, span}` |
| `parse_program_eager` | as `parse_program` | the same `Program`, each slot also carrying `tree` (its `MExpr`) or `error` (`{message, pos}`) |
| `parse_expression` | `(src_ptr, src_len, version, out_ptr_ptr, out_len_ptr) -> status` | |
| `parse_nested_call` | `(raw_ptr, raw_len, at_start, at_end, origin_line, origin_col, version, out_ptr_ptr, out_len_ptr) -> status` | |
| `last_panic` | `(out_ptr_ptr, out_len_ptr)` | the last panic's message, in a static buffer (not freed) |

Status 0 means the output is the tree; 1 means it is `{"error": {…}}`. The
output is UTF-8 JSON the caller must `dealloc`. Every value is an i32 on
wasm32.

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

Keys are sorted recursively. Emit through `to_sorted_json`: it goes via
`serde_json::Value`, whose `Map` is a `BTreeMap` while serde_json's
`preserve_order` feature is off (the default, and kept off). A derived
`Serialize` alone would write struct fields in declaration order.
