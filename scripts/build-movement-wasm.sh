#!/usr/bin/env bash
# Rebuilds the two committed movement artifacts and prints each one's sha256
# and size:
#
#  - movement.wasm, from crates/movement-engine (which links in
#    crates/movement-parser): the parser and the engine, which the API loads;
#  - movement_parser.wasm, from crates/movement-parser alone: the parser, the
#    lowering and the catalog, which the browser loads (it never runs a
#    movement, so it never downloads the engine).
#
# CI (.github/workflows/movement-wasm.yml) runs this and fails if either
# differs from what is committed, so commit both with any change to either
# crate, the lockfile, the profile or the toolchain.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"

cd "$ROOT_DIR"
# Panic-location strings embed source paths; remapping the machine-specific
# prefixes is what lets a CI rebuild reproduce a laptop's bytes.
#
# The shadow stack goes first in linear memory (`--stack-first`, also rustc's
# default for this target) so an overflow traps instead of silently
# overwriting static data, and is 2 MiB: at the parser's depth limit
# (MAX_DEPTH in crates/movement-parser/src/lexer.rs) the deepest texts need
# between 512 and 768 KiB of it (measured 2026-10-06), so about a third.
RUSTFLAGS="--remap-path-prefix=$ROOT_DIR=/listen-fire --remap-path-prefix=$CARGO_HOME_DIR=/cargo -C link-arg=--stack-first -C link-arg=-zstack-size=2097152"
export RUSTFLAGS
cargo build --locked --release --target wasm32-unknown-unknown -p listen-fire-engine
cargo build --locked --release --target wasm32-unknown-unknown -p listen-fire-parser

WASM_DIR="$ROOT_DIR/packages/movement-lang/wasm"
for artifact in movement_engine:movement movement_parser:movement_parser; do
  built="${artifact%%:*}"
  out="$WASM_DIR/${artifact##*:}.wasm"
  cp "$ROOT_DIR/target/wasm32-unknown-unknown/release/$built.wasm" "$out"
  chmod 644 "$out"
  if command -v sha256sum >/dev/null; then
    sha256sum "$out"
  else
    shasum -a 256 "$out"
  fi
  echo "raw $(wc -c < "$out" | tr -d ' ') bytes, gzipped $(gzip -9 -c "$out" | wc -c | tr -d ' ') bytes"
done
