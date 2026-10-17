#!/usr/bin/env bash
# Runs every test corpus with the checks recorder, then folds the harvest
# (./build_fixture.cjs). From packages/movement-lang:
#
#   checker/harvest/harvest.sh          # keep the pin; assemble target/checks/ (pnpm checks:corpus, which then runs the corpus readers)
#   checker/harvest/harvest.sh --pin    # pnpm harvest:checks — rewrite the pin, then assemble
#
# Two passes. The first runs the corpora (the version 1 to 4 conformance
# suites, this package's tests and the engine's) and assembles what it found.
# The second runs the tests that read that corpus (CHECKS_CORPUS=1) and check
# programs of their own made from it: the upgrade loop's rewrites of each
# version 4 program, and the engine oracles' programs respelled to version 5.
# They are pinned too, so their texts are found the same way.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGE="$(cd "$HERE/../.." && pwd)"
cd "$PACKAGE"
mode="${1:-}"
case "$mode" in "" | --pin) ;; *) echo "usage: $0 [--pin]" >&2; exit 1 ;; esac
T="$(mktemp -d)"
JEST=../../apps/api/node_modules/jest/bin/jest.js
FOLD=(node -r ../../apps/api/node_modules/ts-node/register/transpile-only checker/harvest/build_fixture.cjs)

harvest() {
  HARVEST_CORPUS="$1" HARVEST_OUT="$T/$1.jsonl" CHECKS_CORPUS="${2:-}" node "$JEST" --config checker/harvest/jest.harvest.cjs
}

FIRST=(v1 v2 v3 v4 current api-v4 api-current)
for c in "${FIRST[@]}"; do harvest "$c"; done
first=()
for c in "${FIRST[@]}"; do first+=("$c=$T/$c.jsonl"); done
"${FOLD[@]}" "${mode:---partial}" "${first[@]}"

for c in readers api-readers; do harvest "$c" 1; done
"${FOLD[@]}" ${mode:+"$mode"} "${first[@]}" "readers=$T/readers.jsonl" "api-readers=$T/api-readers.jsonl"
