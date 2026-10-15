#!/usr/bin/env bash
# The parity harness: runs the TypeScript checker (reference.ts) and the Rust
# checker (examples/parity.rs) over every program the repository pins, and
# writes the per-code comparison to crates/movement-checker/PARITY.md.
#
#   crates/movement-checker/parity/run.sh            # both sides, then the table
#   crates/movement-checker/parity/run.sh --rust     # the Rust side only, against the last reference
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="${PARITY_WORK:-$ROOT/target/parity}"
mkdir -p "$WORK"
if [ "${1:-}" != "--rust" ]; then
  (cd "$ROOT/packages/movement-lang" && node -r ../../apps/api/node_modules/ts-node/register/transpile-only "$HERE/reference.ts" "$WORK")
fi
cargo run --quiet --release -p movement-checker --example parity -- "$WORK" "$ROOT/crates/movement-checker/PARITY.md"
