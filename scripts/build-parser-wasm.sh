#!/usr/bin/env bash
# Rebuilds the committed parser artifact from crates/movement-parser and
# prints its sha256. CI (.github/workflows/parser-wasm.yml) runs this and
# fails if the bytes differ from what is committed, so commit the artifact
# with any change to the crate, its lockfile, the profile or the toolchain.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT_DIR/packages/movement-lang/wasm/movement_parser.wasm"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"

cd "$ROOT_DIR"
# Panic-location strings embed source paths; remapping the machine-specific
# prefixes is what lets a CI rebuild reproduce a laptop's bytes.
RUSTFLAGS="--remap-path-prefix=$ROOT_DIR=/listen-fire --remap-path-prefix=$CARGO_HOME_DIR=/cargo" \
  cargo build --locked --release --target wasm32-unknown-unknown -p movement-parser

cp "$ROOT_DIR/target/wasm32-unknown-unknown/release/movement_parser.wasm" "$OUT"
chmod 644 "$OUT"

if command -v sha256sum >/dev/null; then
  sha256sum "$OUT"
else
  shasum -a 256 "$OUT"
fi
