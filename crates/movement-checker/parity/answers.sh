#!/usr/bin/env bash
# Check-answer parity: what the Rust checker answers the engine besides its
# diagnostics (the stamps it settles on nodes, the import link; crate::answer)
# against the TypeScript's (program_check.ts `checkAnswer`), over the checker
# parity's corpus. Needs reference.jsonl from run.sh first.
#
#   crates/movement-checker/parity/answers.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="${PARITY_WORK:-$ROOT/target/parity}"
(cd "$ROOT/packages/movement-lang" && node -r ../../apps/api/node_modules/ts-node/register/transpile-only "$HERE/answer_reference.ts" "$WORK")
cargo run --quiet --release -p listen-fire-checker --example answer_parity -- "$WORK"
