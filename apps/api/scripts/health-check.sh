#!/usr/bin/env bash
# Local health check — "the full lot" for a solo project. CI only gates
# prod-safety (types, smoke behaviour, schema); the heavier hygiene + the full
# test suite live here, run on demand (≈weekly). On an all-green pass it stamps
# HEALTH.md so an agent (or you) can see when it last passed and nudge a re-run
# if it's been a while. Runs every check (no fail-fast) so you see everything
# broken in one go.
#
# Usage:  pnpm health   (from apps/api)
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." # apps/api
REPO_ROOT="$(cd ../.. && pwd)"
HEALTH_FILE="$REPO_ROOT/HEALTH.md"
BIG_HEAP="--max-old-space-size=8192"

declare -a NAMES=() RESULTS=()
run() {
  local name="$1"; shift
  echo ""
  echo "━━━ $name ━━━"
  if "$@"; then NAMES+=("$name"); RESULTS+=("pass"); echo "✓ $name"
  else NAMES+=("$name"); RESULTS+=("FAIL"); echo "✗ $name"; fi
}

run "typecheck"     bash -c "pnpm code:type-check"
run "lint"          bash -c "NODE_OPTIONS=$BIG_HEAP pnpm code:lint"
run "unused (knip)" bash -c "pnpm code:unused"
run "unit tests"    bash -c "NODE_OPTIONS=$BIG_HEAP pnpm test:unit"
run "contract docs" bash -c "pnpm --filter @lf/engine-contracts test"
run "shared"        bash -c "pnpm --filter @lf/shared test"
run "movement-lang" bash -c "pnpm --filter @lf/movement-lang test"

echo ""
echo "════════ HEALTH SUMMARY ════════"
ALL_PASS=1
for i in "${!NAMES[@]}"; do
  printf "  %-16s %s\n" "${NAMES[$i]}" "${RESULTS[$i]}"
  [ "${RESULTS[$i]}" = "pass" ] || ALL_PASS=0
done

DATE="$(date -u +%Y-%m-%d)"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ "$ALL_PASS" -eq 1 ]; then
  cat > "$HEALTH_FILE" <<EOF
# Health

Last full local health check **passed**: **$DATE** (commit \`$COMMIT\`).

Run \`pnpm health\` (from apps/api) to re-check. This runs the full lot —
typecheck, lint, knip, and the full unit suite — and re-stamps this file on an
all-green pass. CI itself only gates prod-safety (types, smoke, schema); this is
the heavier hygiene + full-test sweep, run on demand (≈weekly).
EOF
  echo ""
  echo "✓ ALL GREEN — stamped $HEALTH_FILE ($DATE, $COMMIT)"
  exit 0
else
  echo ""
  echo "✗ NOT all green — $HEALTH_FILE NOT updated (fix the failures above, re-run)"
  exit 1
fi
