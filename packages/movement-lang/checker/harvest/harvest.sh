#!/usr/bin/env bash
# Runs every test corpus with the checks recorder, then folds the harvest
# (./build_fixture.cjs). From packages/movement-lang:
#
#   checker/harvest/harvest.sh          # pnpm checks:corpus — keep the pin; assemble target/checks/
#   checker/harvest/harvest.sh --pin    # pnpm harvest:checks — rewrite the pin, then assemble
#
# Two passes. The first runs the corpora (the version 1 to 4 conformance
# suites, this package's tests and the engine's) and assembles what it found.
# The second runs the tests that read that corpus (CHECKS_CORPUS=1) and check
# programs of their own made from it: the upgrade loop's rewrites of each
# version 4 program, and the engine oracles' programs respelled to version 5.
# They are pinned too, so their texts are found the same way. Their own
# assertions are about the whole corpus, which the second pass is still
# completing, so they are run (not recorded) once it is complete, last, with
# the checker regression's replay.
#
# A re-harvest rewrites the pin from the first pass alone, before the second
# runs, so the readers see only programs some test writes. They re-check the
# corpus they read; were that the old pin, their re-checks would pin its
# programs again, and a program no test writes would never leave it.
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

FIRST=(v1 v2 v3 v4 current api-v4 api-current engine)
for c in "${FIRST[@]}"; do harvest "$c"; done
first=()
for c in "${FIRST[@]}"; do first+=("$c=$T/$c.jsonl"); done
"${FOLD[@]}" "${mode:---partial}" "${first[@]}"

for c in readers engine-readers; do
  harvest "$c" 1 || echo "($c: its assertions are checked over the complete corpus below)"
done
"${FOLD[@]}" ${mode:+"$mode"} "${first[@]}" "readers=$T/readers.jsonl" "engine-readers=$T/engine-readers.jsonl"

CHECKS_CORPUS=1 node "$JEST" --config jest.config.borrowed.cjs checker/__test__/checks_regression checker/__test__/upgrade_corpus
(cd ../movement-engine && CHECKS_CORPUS=1 node "$JEST" --config jest.config.borrowed.cjs services/movement_engine/__test__/reachability)
