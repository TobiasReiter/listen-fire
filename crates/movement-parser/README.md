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

## The ABI (`src/abi.rs`)

| export | signature | |
|---|---|---|
| `alloc` | `(len) -> ptr` | caller writes UTF-8 input here |
| `dealloc` | `(ptr, len)` | frees an input or an output buffer |
| `parse_program` | `(src_ptr, src_len, version, out_ptr_ptr, out_len_ptr) -> status` | |
| `parse_expression` | `(src_ptr, src_len, version, out_ptr_ptr, out_len_ptr) -> status` | |
| `parse_nested_call` | `(raw_ptr, raw_len, at_start, at_end, origin_line, origin_col, version, out_ptr_ptr, out_len_ptr) -> status` | |

Status 0 means the output is the tree; 1 means it is `{"error": {…}}`. The
output is UTF-8 JSON the caller must `dealloc`. Every value is an i32 on
wasm32.

A panic aborts (`panic = "abort"`), which traps the instance; the loader
discards a trapped instance and instantiates a fresh one on the next call.

## JSON output

Keys are sorted recursively. Emit through `to_sorted_json`: it goes via
`serde_json::Value`, whose `Map` is a `BTreeMap` while serde_json's
`preserve_order` feature is off (the default, and kept off). A derived
`Serialize` alone would write struct fields in declaration order.
