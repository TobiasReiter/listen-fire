#!/usr/bin/env bash
# Rebuilds the committed movement artifact from crates/movement-engine (which
# links in crates/movement-parser, so the one .wasm is both the parser and the
# engine) and prints its sha256 and size. CI (.github/workflows/
# movement-wasm.yml) runs this and fails if the bytes differ from what is
# committed, so commit the artifact with any change to either crate, the
# lockfile, the profile or the toolchain.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT_DIR/packages/movement-lang/wasm/movement.wasm"
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
RUSTFLAGS="--remap-path-prefix=$ROOT_DIR=/listen-fire --remap-path-prefix=$CARGO_HOME_DIR=/cargo -C link-arg=--stack-first -C link-arg=-zstack-size=2097152" \
  cargo build --locked --release --target wasm32-unknown-unknown -p movement-engine

cp "$ROOT_DIR/target/wasm32-unknown-unknown/release/movement_engine.wasm" "$OUT"
chmod 644 "$OUT"

if command -v sha256sum >/dev/null; then
  sha256sum "$OUT"
else
  shasum -a 256 "$OUT"
fi
echo "raw $(wc -c < "$OUT" | tr -d ' ') bytes, gzipped $(gzip -9 -c "$OUT" | wc -c | tr -d ' ') bytes"
