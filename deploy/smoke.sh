#!/usr/bin/env bash
# Every shape, from clean docker state, end to end.
#
#   ./smoke.sh
#
# Part of this chunk's ship gate, not CI: it builds four images and boots five
# stacks, so it costs minutes rather than seconds. Each shape is torn down with
# its volumes before the next one, so `listen-fire-config` is regenerated every time
# and the first-boot path is what is actually under test. Four shapes vary which
# units run; the fifth varies where the database is.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DEPLOY_DIR"

WEB_PORT="${WEB_PORT:-8080}"
API_PORT="${API_PORT:-8081}"
FAKE_PORT="${FAKE_CHANNELS_PORT_HOST:-8083}"
export WEB_PORT API_PORT
export ADMIN_PORT="${ADMIN_PORT:-8082}"
export FAKE_CHANNELS_PORT_HOST="$FAKE_PORT"
export API_BASE_URL="http://localhost:${API_PORT}"
export WEB_BASE_URL="http://localhost:${WEB_PORT}"

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/listen-fire-smoke.XXXXXX")"
FAILURES=0
SHAPE_FAILURES=0
SHAPE_LABEL=""
JAR=""

# Every profile, and both files, on every teardown. A `down` that omits a
# profile leaves its containers behind for the next shape to inherit, and the
# external-database shape below adds a file — naming both here means one
# teardown is correct after any shape, including a crashed one.
ALL_PROFILES=(--profile postgres --profile redis --profile objectstore --profile admin --profile demo)
teardown() {
  docker compose -f docker-compose.yml -f smoke-external-postgres.yml \
    "${ALL_PROFILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap teardown EXIT

fail() { echo "  ✗ $1" >&2; FAILURES=$((FAILURES + 1)); SHAPE_FAILURES=$((SHAPE_FAILURES + 1)); }
pass() { echo "  ✓ $1"; }

# ─── the shape's environment ────────────────────────────────────────────────
#
# `up.sh` derives all of this from the unit list and exports it for the compose
# commands it runs itself. The assertions below run compose directly — the seed
# re-run, and reading the generated secrets — so they have to be given the same
# answers, or `seed` would be told LISTEN_FIRE_PRODUCTS=all on a knowledge-only stack
# and the API would refuse the mismatch at boot.
configure_shape() {
  local unit joined=""
  for unit in "$@"; do
    [ "$unit" = "--demo" ] && continue
    joined="${joined:+$joined,}$unit"
  done
  export LISTEN_FIRE_PRODUCTS="$joined"

  case ",$joined," in
    *,core,*) export LISTEN_FIRE_PRINCIPAL=core ;;
    *) export LISTEN_FIRE_PRINCIPAL=static ;;
  esac

  # The two delivery modes are DERIVED from the unit list exactly as up.sh
  # derives them (the two blocks there that export them), and they have to be
  # re-derived here: the assertions run `compose run --rm seed`, which
  # re-resolves the api service from THIS environment. Omitted, they default to
  # `local` — an api told to deliver graph mutations in-process on a stack with
  # no automations to be that consumer, which is not the shape the smoke claims
  # to test.
  local automations=0 knowledge=0 asks=0
  case ",$joined," in *,automations,*) automations=1 ;; esac
  case ",$joined," in *,knowledge,*) knowledge=1 ;; esac
  case ",$joined," in *,asks,*) asks=1 ;; esac

  if [ "$automations" = 1 ] && [ "$knowledge" = 1 ]; then
    export KNOWLEDGE_MUTATION_DELIVERY=local
  else
    export KNOWLEDGE_MUTATION_DELIVERY=webhook
  fi

  if [ "$automations" = 1 ] && [ "$asks" = 1 ]; then
    export ASKS_SETTLE_DELIVERY=local
  else
    export ASKS_SETTLE_DELIVERY=webhook
  fi

  # Every shape here is a demo shape, so the fake third parties and the
  # non-production cookie/email behaviour are always on.
  export LISTEN_FIRE_DEMO=1
  export LISTEN_FIRE_NODE_ENV=development
  export MOCK_OUTPUT_ADAPTERS=true
  export FAKE_CHANNELS_URL=http://fake-channels:5556
  # The address automations receive mail on. Real deployments set their own;
  # the demo names one so an email trigger has something to route on at all.
  export INBOUND_EMAIL_ADDRESS="${INBOUND_EMAIL_ADDRESS:-inbox@listen-fire.local}"
  export RESEND_API_BASE_URL=http://fake-channels:5556/resend
}

# up.sh's own reader, verbatim in intent: the generated secrets live in the
# `listen-fire-config` volume, which is invisible from the host.
read_generated() {
  local name="$1" value
  if ! value="$(docker compose --profile admin --profile demo run --rm --no-deps \
      --entrypoint sh init -c ". /config/generated.env; printf %s \"\$$name\"" 2>/dev/null)"; then
    echo ""
    return
  fi
  printf %s "$value" | tr -d '\r'
}

# ─── assertions ─────────────────────────────────────────────────────────────

assert_api_healthy() {
  if curl -fsS "http://localhost:${API_PORT}/.well-known/health-check" >/dev/null; then
    pass "API healthy"
  else
    fail "API not healthy"
  fi
}

# `/api/public/capabilities` answers three facts: the mounted products in
# declaration order, the identity provider, and an MCP connector URL for each
# mounted product that serves one. This used to be a string comparison against
# a literal whole-object JSON, so the day `mcp` joined the response every shape
# failed on a response that was in fact correct. Assert the fields by name, and
# derive the expected connector set from the same product list rather than
# restating it — a brittle whole-object equality is how a passing smoke stops
# meaning the contract held.
assert_capabilities() {
  local products="$1" identity="$2" got problem
  got="$(curl -fsS "http://localhost:${API_PORT}/api/public/capabilities" || echo '')"
  if [ -z "$got" ]; then
    fail "capabilities: /api/public/capabilities did not answer"
    return
  fi

  problem="$(printf %s "$got" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      const [csv, identity, base] = process.argv.slice(1);
      let body;
      try { body = JSON.parse(raw); } catch { console.log("not JSON"); return; }
      const want = csv.split(",");
      const problems = [];
      const seen = JSON.stringify(body.products);
      if (seen !== JSON.stringify(want)) problems.push(`products ${seen} not ${JSON.stringify(want)}`);
      if (body.identity !== identity) problems.push(`identity ${body.identity} not ${identity}`);
      const connector = {
        automations: ["automation", "/api/v1/mcp/automation"],
        knowledge: ["knowledge", "/api/v1/mcp/knowledge"],
        valuations: ["valuations", "/api/v1/mcp/valuations"],
      };
      const wanted = {};
      for (const product of want) {
        if (connector[product]) wanted[connector[product][0]] = base + connector[product][1];
      }
      const flatten = (o) => JSON.stringify(Object.entries(o ?? {}).sort());
      if (flatten(body.mcp) !== flatten(wanted)) {
        problems.push(`mcp ${JSON.stringify(body.mcp)} not ${JSON.stringify(wanted)}`);
      }
      console.log(problems.join("; "));
    });
  ' "$products" "$identity" "$API_BASE_URL")" || {
    fail "capabilities: could not read $got"
    return
  }

  if [ -z "$problem" ]; then pass "capabilities: $got"; else fail "capabilities: $problem"; fi
}

# What this can and cannot see. `/login` is CLIENT-rendered: the response body
# is the Next shell — the wordmark from the shared auth chrome plus the script
# tags — and the sign-in form itself is not in the bytes at any point. So this
# asserts the route exists and the app shell shipped, and nothing about what a
# person would actually be shown. A login page rendering an error instead of a
# form passes this check; catching that needs a browser, which is a different
# tool than a curl script.
assert_login_page_renders() {
  local body
  body="$(curl -fsS "http://localhost:${WEB_PORT}/login" || echo '')"
  if [ -z "$body" ]; then
    fail "web /login did not answer"
  elif grep -q 'Listen-Fire' <<<"$body" && grep -q '_next/static' <<<"$body"; then
    pass "web /login renders the app shell"
  else
    fail "web /login answered, but not with the app shell"
  fi
}

# `middleware.ts` bounces a request with no `listen_fire_token` to /login, so the
# unauthenticated leg is what makes the authenticated 200 mean anything.
assert_product_page_renders() {
  local page="$1" anon authed
  # `|| true` on every bare status read: under `set -e` a curl that cannot
  # connect at all aborts the whole run, so a dead stack would kill the script
  # instead of recording the ✗ that says so. curl writes `000` for a request
  # that never got a response, so the ✗ still names what happened — appending
  # our own `000` here just made it read `000000`.
  anon="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT}${page}" || true)"
  if [ "$anon" = "307" ] || [ "$anon" = "302" ]; then
    pass "$page redirects a signed-out visitor ($anon)"
  else
    fail "$page did not redirect a signed-out visitor (got $anon)"
  fi

  authed="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "http://localhost:${WEB_PORT}${page}" || true)"
  if [ "$authed" = "200" ]; then
    pass "$page renders for the signed-in session"
  else
    fail "$page did not render for the signed-in session (got $authed)"
  fi
}

assert_static_login() {
  local key headers code
  key="$(read_generated LISTEN_FIRE_API_KEY)"
  if [ -z "$key" ]; then fail "no LISTEN_FIRE_API_KEY in the config volume"; return; fi

  headers="$(curl -fsS -D - -o /dev/null -c "$JAR" -X POST \
    "http://localhost:${WEB_PORT}/api/public/auth/static/login" \
    -H 'content-type: application/json' -d "{\"apiKey\":\"${key}\"}" || echo '')"
  if grep -qi 'set-cookie: listen_fire_token=' <<<"$headers"; then
    pass "static login set the session cookie"
  else
    fail "static login set no session cookie"
  fi
  if grep -qi 'set-cookie: listen_fire_authed=' <<<"$headers"; then
    pass "static login set the readable presence marker"
  else
    fail "static login set no presence marker"
  fi
  # http, so `Secure` would be set and then silently dropped by the browser.
  if grep -i 'set-cookie: listen_fire_token=' <<<"$headers" | grep -qi 'secure'; then
    fail "the session cookie is Secure on an http base URL"
  else
    pass "the session cookie is not Secure on an http base URL"
  fi

  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://localhost:${WEB_PORT}/api/public/auth/static/login" \
    -H 'content-type: application/json' -d '{"apiKey":"wrong"}' || true)"
  if [ "$code" = "401" ]; then
    pass "static login refuses a wrong key"
  else
    fail "static login accepted a wrong key (got $code)"
  fi
}

assert_magic_link_login() {
  local email token body i
  email="$(read_generated LISTEN_FIRE_BOOTSTRAP_USER_EMAIL)"
  if [ -z "$email" ]; then fail "no LISTEN_FIRE_BOOTSTRAP_USER_EMAIL in the config volume"; return; fi

  if ! curl -fsS -X POST "http://localhost:${WEB_PORT}/api/public/auth/requestMagicLink" \
      -H 'content-type: application/json' -d "{\"email\":\"${email}\"}" >/dev/null; then
    fail "requestMagicLink was refused"
    return
  fi

  # The send is queued, so the outbox is a moment behind the request.
  token=""
  for i in 1 2 3 4 5; do
    sleep 2
    token="$(curl -fsS "http://localhost:${FAKE_PORT}/email/outbox" | node -e '
      let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{
        const msgs=JSON.parse(raw).data ?? [];
        const hit=[...msgs].reverse().map(m=>/\/magic\?token=([A-Za-z0-9._-]+)/.exec(m.data ?? ""))
          .find(Boolean);
        process.stdout.write(hit ? hit[1] : "");
      });' || echo '')"
    [ -n "$token" ] && break
  done
  if [ -z "$token" ]; then fail "no magic link reached the fake outbox"; return; fi
  pass "the magic link reached the fake outbox"

  # `verify` answers 200 with an `error` body on a bad token, so the body is
  # the only honest signal — a status check would pass on every failure.
  body="$(curl -fsS -D "$LOG_DIR/verify-headers.txt" -c "$JAR" -X POST \
    "http://localhost:${WEB_PORT}/api/public/auth/verify" \
    -H 'content-type: application/json' -d "{\"token\":\"${token}\"}" || echo '<unreachable>')"
  if grep -q '"token"' <<<"$body" && grep -qi 'set-cookie: listen_fire_token=' "$LOG_DIR/verify-headers.txt"; then
    pass "magic-link login issued a session"
  else
    fail "magic-link login failed: $body"
  fi
}

# The datastore switch, read from the outside: a container for the bundled
# service either exists in this project or it does not.
assert_bundled_service_absent() {
  local service="$1" found
  found="$(docker ps -a --filter 'label=com.docker.compose.project=listen-fire' \
    --filter "label=com.docker.compose.service=$service" -q)"
  if [ -z "$found" ]; then
    pass "the bundled $service is not in the composition"
  else
    fail "the bundled $service is still running ($found)"
  fi
}

# And read from the inside: the schema is in the database DATABASE_URL names,
# not in one this composition started for the api's sake.
assert_schema_in_external_postgres() {
  local applied
  applied="$(docker compose exec -T external-postgres \
    psql -U listenfire -d listenfire -tAc 'select count(*) from _migrations.migrations' \
    2>/dev/null | tr -d '[:space:]')"
  case "$applied" in
    ''|*[!0-9]*) fail "could not count migrations in the external database (got '${applied:-<nothing>}')" ;;
    0) fail "the external database has no migrations applied" ;;
    *) pass "the migrations are in the external database ($applied applied)" ;;
  esac
}

# The seed runs on every boot of a demo stack, so it has to be safe to run
# twice against tables it already wrote.
assert_seed_is_idempotent() {
  local log="$LOG_DIR/seed-rerun-${SHAPE_LABEL// /_}.log"
  if docker compose --profile admin --profile demo run --rm seed >"$log" 2>&1; then
    pass "a second seed run is a no-op (exit 0)"
  else
    fail "a second seed run failed — see $log"
  fi
}

# ─── shapes ─────────────────────────────────────────────────────────────────

# Which images this run has already built, so the later shapes can skip it.
# up.sh builds only what its own profiles start, and the first shape here is
# single-tenant — it never builds the admin app. So `--no-build` is safe only
# once EVERY image the shape needs is known current, which for a core shape
# means waiting for the first core shape to build the admin one.
BUILT_SHARED=0
BUILT_ADMIN=0

shape_may_skip_build() {
  local needs_admin=0
  case ",$LISTEN_FIRE_PRODUCTS," in *,core,*) needs_admin=1 ;; esac
  [ "$BUILT_SHARED" -eq 1 ] || return 1
  [ "$needs_admin" -eq 0 ] || [ "$BUILT_ADMIN" -eq 1 ]
}

record_built_images() {
  BUILT_SHARED=1
  case ",$LISTEN_FIRE_PRODUCTS," in *,core,*) BUILT_ADMIN=1 ;; esac
}

start_shape() {
  SHAPE_LABEL="$1"; shift
  SHAPE_FAILURES=0
  JAR="$LOG_DIR/cookies-${SHAPE_LABEL// /_}.txt"
  : >"$JAR"
  echo
  echo "═══ $SHAPE_LABEL ═══"
  teardown
  configure_shape "$@"

  # From SOURCE, always: this verifies the TREE, not the registry — a published
  # image would prove nothing about the change under test. `--no-build` on the
  # later shapes reuses the tags the first one built, which is why the images
  # are tracked at all.
  local up_args=("$@") built=0
  if shape_may_skip_build; then
    up_args+=(--no-build)
  else
    up_args+=(--build)
    built=1
  fi

  local log="$LOG_DIR/up-${SHAPE_LABEL// /_}.log"
  if ./up.sh "${up_args[@]}" >"$log" 2>&1; then
    pass "up.sh brought the stack up"
    # Only a run that got all the way through built every image it needed. A
    # failed one may have died mid-build, and recording it would let the next
    # shape skip the build and boot a stale tag as though it were the code.
    if [ "$built" -eq 1 ]; then record_built_images; fi
  else
    fail "up.sh failed — see $log"
    tail -40 "$log" >&2
  fi
}

end_shape() {
  local seconds="$1"
  if [ "$SHAPE_FAILURES" -eq 0 ]; then
    echo "PASS  ${SHAPE_LABEL}  (${seconds}s)"
  else
    echo "FAIL  ${SHAPE_LABEL}  (${seconds}s, ${SHAPE_FAILURES} assertion(s))" >&2
  fi
}

run_shape() {
  local started ended
  started="$(date +%s)"
  "$@"
  ended="$(date +%s)"
  end_shape "$((ended - started))"
}

shape_knowledge() {
  start_shape "knowledge --demo" knowledge --demo
  assert_api_healthy
  assert_capabilities 'knowledge' 'static'
  assert_login_page_renders
  assert_static_login
  assert_product_page_renders /model
  assert_seed_is_idempotent
}

shape_automations() {
  start_shape "automations --demo" automations --demo
  assert_api_healthy
  assert_capabilities 'automations' 'static'
  assert_login_page_renders
  assert_static_login
  assert_product_page_renders /dashboard
  assert_seed_is_idempotent
}

shape_core_knowledge() {
  start_shape "core knowledge --demo" core knowledge --demo
  assert_api_healthy
  assert_capabilities 'core,knowledge' 'core'
  assert_login_page_renders
  assert_magic_link_login
  assert_product_page_renders /model
  assert_seed_is_idempotent
}

shape_all_five() {
  start_shape "all five --demo" core asks valuations knowledge automations --demo
  assert_api_healthy
  assert_capabilities 'core,valuations,automations,knowledge,asks' 'core'
  assert_login_page_renders
  assert_magic_link_login
  assert_product_page_renders /dashboard
  assert_seed_is_idempotent
}

# The one shape that is not about which units run. A second Postgres joins the
# composition under a name of its own, DATABASE_URL names it, and everything
# else follows from that single value: the bundled `postgres` service leaves the
# composition, `migrate` waits for the named database instead of a `depends_on`,
# and the schema lands where the api reads it.
shape_external_postgres() {
  export COMPOSE_FILE="docker-compose.yml:smoke-external-postgres.yml"
  export DATABASE_URL="postgresql://listenfire:smoke@external-postgres:5432/listenfire"
  start_shape "external postgres --demo" core automations --demo
  assert_api_healthy
  assert_capabilities 'core,automations' 'core'
  assert_bundled_service_absent postgres
  assert_schema_in_external_postgres
  assert_magic_link_login
  assert_product_page_renders /dashboard
  unset DATABASE_URL COMPOSE_FILE
}

echo "[smoke] logs: $LOG_DIR"

run_shape shape_knowledge
run_shape shape_automations
run_shape shape_core_knowledge
run_shape shape_all_five
run_shape shape_external_postgres

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "SMOKE PASSED"
else
  echo "SMOKE FAILED ($FAILURES assertion(s)) — logs in $LOG_DIR" >&2
  exit 1
fi
