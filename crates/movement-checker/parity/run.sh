#!/usr/bin/env bash
# The parity harness: runs the TypeScript checker (reference.ts) and the Rust
# checker (examples/parity.rs) over every program the repository pins, and
# writes the per-code comparison to crates/movement-checker/PARITY.md. Both
# checkers answer live; the pin's diagnostics are not read. The pin holds no
# program text, so the programs come from a harvest of the tests that check
# them (`pnpm checks:corpus`, which assembles target/checks/checks.json).
#
#   crates/movement-checker/parity/run.sh            # harvest, both sides, then the table
#   crates/movement-checker/parity/run.sh --corpus   # both sides over the corpus the last harvest assembled
#   crates/movement-checker/parity/run.sh --rust     # the Rust side only, against the last reference
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="${PARITY_WORK:-$ROOT/target/parity}"
case "${1:-}" in "" | --corpus | --rust) ;; *) echo "usage: $0 [--corpus | --rust]" >&2; exit 1 ;; esac
mkdir -p "$WORK"
if [ "${1:-}" = "" ]; then
  (cd "$ROOT/packages/movement-lang" && checker/harvest/harvest.sh)
fi
# The engine oracles' programs reach apps/api modules that read env at load:
# the jest suites' inert defaults stand in.
if [ "${1:-}" != "--rust" ]; then
  (cd "$ROOT/packages/movement-lang" && node -r ../../apps/api/node_modules/ts-node/register/transpile-only -r ../../apps/api/src/test/test-env-defaults.ts "$HERE/reference.ts" "$WORK")
fi
cargo run --quiet --release -p listen-fire-checker --example parity -- "$WORK" "$ROOT/crates/movement-checker/PARITY.md"
