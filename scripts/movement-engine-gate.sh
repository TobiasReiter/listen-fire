#!/usr/bin/env bash
# The movement engine's local gate, no database: the two oracles regenerated
# and diffed (as CI's "is current" steps do, so a generator that breaks fails
# here too), both crates, movement-lang's suite and corpora, the
# movement_engine unit set and the version 1 and 2 conformance corpora
# (which engine runs a run is its pin alone), both artifacts rebuilt from
# clean, and the api and web type-checks. Read its output; it does not stop
# at the first failure.
cd "$(dirname "$0")/.."
echo "== oracle regenerated and diffed (CI: the Rust engine's oracle is current)"; (cd apps/api && TS_NODE_PROJECT=tsconfig.json npx ts-node --transpile-only ../../crates/movement-engine/tests/oracle/generate.ts 2>&1 | grep -v Deprecation | grep -v trace-deprecation; echo "generate exit ${PIPESTATUS[0]}"); git diff --exit-code --stat -- 'crates/movement-engine/tests/oracle/*.json' && echo "oracle current"
echo "== env fixture regenerated and diffed (CI: the environment services' fixture is current)"; (cd apps/api && TS_NODE_PROJECT=tsconfig.json npx ts-node --transpile-only ../../crates/movement-engine/tests/env/generate.ts 2>&1 | grep -v Deprecation | grep -v trace-deprecation; echo "generate exit ${PIPESTATUS[0]}"); git diff --exit-code --stat -- 'crates/movement-engine/tests/env/*.json' && echo "env fixture current"
echo "== cargo engine"; cargo test -p movement-engine 2>&1 | grep -E "^test result|FAILED|panicked|Running"
echo "== cargo parser"; cargo test -p movement-parser 2>&1 | grep -E "^test result|FAILED|panicked"
echo "== movement-lang suite"; (cd packages/movement-lang && pnpm -s test 2>&1 | grep -E "^Tests:|^Test Suites:|FAIL ")
echo "== movement-lang conformance v1"; (cd packages/movement-lang && pnpm -s test:conformance:v1 2>&1 | grep -E "^Tests:|^Test Suites:|FAIL ")
echo "== movement-lang conformance v2"; (cd packages/movement-lang && pnpm -s test:conformance:v2 2>&1 | grep -E "^Tests:|^Test Suites:|FAIL ")
echo "== ME package unit"; (cd packages/movement-engine && pnpm -s test 2>&1 | grep -E "^Tests:|^Test Suites:|FAIL ")
cd apps/api
echo "== ME unit"; npx jest -c src/test/jest-unit.config.ts --testPathPattern 'services/movement_engine/__test__' 2>&1 | grep -E "^Tests:|^Test Suites:|FAIL "
for v in v1 v2; do echo "== conformance $v"; pnpm -s test:conformance:$v 2>&1 | grep -E "^Tests:|^Test Suites:|FAIL "; done
cd ../..
echo "== artifacts"; scripts/build-movement-wasm.sh 2>&1 | grep -E "wasm|raw"; cargo clean -p movement-engine --release --target wasm32-unknown-unknown >/dev/null 2>&1; cargo clean -p movement-parser --release --target wasm32-unknown-unknown >/dev/null 2>&1; scripts/build-movement-wasm.sh 2>&1 | grep -E "wasm|raw"; git status --short packages/movement-lang/wasm
echo "== type-check"; (cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.json --noEmit >/dev/null 2>&1; echo "api tsc exit $?"); (cd apps/web && NODE_OPTIONS=--max-old-space-size=8192 pnpm -s code:type-check >/dev/null 2>&1; echo "web tsc exit $?")
echo "== done"
