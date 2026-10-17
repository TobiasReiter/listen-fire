#!/usr/bin/env bash
# Dev-loop boot: bring up the full stack with fakes wired in.
#
# Profiles are controlled by $DEV_LOOP_PROFILE (or the wrapper script you
# invoke). Each profile reserves its own port range so multiple stacks can
# run in parallel:
#
#   (per profile: api=base, web=base+3, admin=base+4; fake-channels in its
#    own pair.)
#   default — the primary local stack. api 3000, web 3003, admin 3004, fake-channels 5556.
#   agent   — first agent stack. api 3500 … admin 3504, 6055, 6056.
#   agent2  — second agent stack. api 4000 … admin 4004, 6155, 6156.
#   agent3  — third agent stack. api 4500 … admin 4504, 6255, 6256.
#
# Postgres + Redis are shared single docker containers across the default,
# agent2 and agent3 profiles. The `agent` profile is the exception: it gets
# its OWN docker compose project and its OWN Postgres/Redis host ports, so it
# never depends on the developer's stack (or an unrelated compose project on
# the same host, e.g. a sibling repo's `dev` project bound to the same
# default ports) being free or uncontended. See the STACK_NAME_DEFAULT /
# POSTGRES_HOST_PORT_DEFAULT / REDIS_HOST_PORT_DEFAULT block below.
# Profile state is recorded in .dev-loop/profiles/<profile>.json so that
# out-of-band dev CLIs can pick the right stack, and `pnpm dev:loop:status`
# can list / prune dead loops.
#
# Deployment shapes are controlled by $DEV_LOOP_SHAPE (independent of the
# profile, which is only a port slot):
#
#   loop      — the default. The API drains automations work on its own
#               in-process timer.
#   push-tick — the API in external drain mode with no in-process loop: a
#               door's notify POSTs the API's own drain tick (standing in for a
#               Pub/Sub push subscription), and dev/scheduler.sh ticks it every
#               5 s (standing in for Cloud Scheduler). Log:
#               .dev-loop/scheduler.log.
#
# The system endpoints' callers are controlled by $SYSTEM_AUTH_MODES, as on a
# deployment (`api_key` by default). Naming `oidc` starts a fake OpenID Connect
# issuer (`pnpm dev:fake-issuer`, log .dev-loop/fake-issuer.log) and points the
# API's oidc settings at it; under push-tick the scheduler then ticks with a
# token it mints there per tick instead of the API key. With `oidc` alone the
# door notifier, which sends the API key, is turned off.
#
# Flags:
#   --force-kill     If any of this profile's ports are already bound, kill
#                    the holders and continue. Default is to abort.
#
# Reads .env from apps/api (which already includes TEST_HARNESS_TEAM_ID).
# See docs/dev-loop.md for the surrounding workflow.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROFILE="${DEV_LOOP_PROFILE:-default}"
SHAPE="${DEV_LOOP_SHAPE:-loop}"
FORCE_KILL=0
for arg in "$@"; do
  case "$arg" in
    --force-kill) FORCE_KILL=1 ;;
    *) echo "[dev:loop] unknown arg: $arg"; exit 1 ;;
  esac
done

# Profile-specific port assignments. Each profile reserves an api/web
# pair in the 3000-range and a fake-channels pair in the 5000-6000 range.
# Exporting these makes them visible to the parallel app processes started
# by `pnpm dev`. Each app reads them:
#   - api:           process.env.PORT          (server.ts)
#   - web (next):    $WEB_PORT in package.json dev script
#   - fake-channels: process.env.FAKE_CHANNELS_PORT (index.ts)
#   - fake CRM:      process.env.FAKE_REMOTE_ADAPTER_PORT (fake_crm_adapter.ts)
#
# STACK_NAME_DEFAULT / POSTGRES_HOST_PORT_DEFAULT / REDIS_HOST_PORT_DEFAULT
# set the developer stack's defaults up front; `agent` below overrides them
# to its own fixed compose project name and its own datastore ports, so it
# never contends with the developer's stack (or an unrelated compose project
# on this host bound to the default ports — a sibling repo's own `dev`
# project has done exactly that). Every other profile is unchanged from
# before: same shared Postgres/Redis as always.
STACK_NAME_DEFAULT="listenfire-$(basename "$REPO_ROOT")"
POSTGRES_HOST_PORT_DEFAULT=9432
REDIS_HOST_PORT_DEFAULT=6379
S3_HOST_PORT_DEFAULT=9010
case "$PROFILE" in
  default)
    API_BASE=3000; HARNESS_BASE=5555 ;;
  agent)
    API_BASE=3500; HARNESS_BASE=6055
    STACK_NAME_DEFAULT="listen-fire-dev-agent"
    POSTGRES_HOST_PORT_DEFAULT=9434
    REDIS_HOST_PORT_DEFAULT=6381
    S3_HOST_PORT_DEFAULT=9012
    ;;
  agent2)
    API_BASE=4000; HARNESS_BASE=6155 ;;
  agent3)
    API_BASE=4500; HARNESS_BASE=6255 ;;
  *)
    echo "[dev:loop] unknown DEV_LOOP_PROFILE='$PROFILE' (expected: default, agent, agent2, agent3)"
    exit 1
    ;;
esac

# Names the docker compose project (and its container names). Defaulting to
# the repo-basename form keeps a second clone/fork on the same machine from
# treating this checkout's Postgres/Redis as its own service to recreate
# (compose otherwise derives the project name from the compose file's
# directory, "dev", which every checkout shares — and, per the 2026-09-15
# incident, a shared project NAME is enough on its own to make one loop
# clobber another's containers, regardless of ports). Set $LISTEN_FIRE_STACK,
# $POSTGRES_HOST_PORT or $REDIS_HOST_PORT yourself to override any of these.
export LISTEN_FIRE_STACK="${LISTEN_FIRE_STACK:-$STACK_NAME_DEFAULT}"
export POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-$POSTGRES_HOST_PORT_DEFAULT}"
export REDIS_HOST_PORT="${REDIS_HOST_PORT:-$REDIS_HOST_PORT_DEFAULT}"
# Local S3 (SeaweedFS, the `objectstore` service): its S3 API on S3_HOST_PORT.
# Not 9000 — another project on this host holds it.
export S3_HOST_PORT="${S3_HOST_PORT:-$S3_HOST_PORT_DEFAULT}"

# File storage: the API's S3 adapter pointed at this stack's object store (credentials
# and bucket match dev/docker-compose.yml; plain local placeholders).
export AWS_S3_ENDPOINT="${AWS_S3_ENDPOINT:-http://localhost:$S3_HOST_PORT}"
export AWS_DOCUMENT_S3_BUCKET="${AWS_DOCUMENT_S3_BUCKET:-listenfire-dev}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-listenfire}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-localdevpassword}"
export AWS_S3_FORCE_PATH_STYLE="${AWS_S3_FORCE_PATH_STYLE:-true}"

# The API only uses Redis when it is named (there is no localhost default in the code), so the
# dev loop names the container it runs, on this profile's port.
export MESSAGE_QUEUE_REDIS_HOSTNAME="${MESSAGE_QUEUE_REDIS_HOSTNAME:-localhost}"
export MESSAGE_QUEUE_REDIS_PORT="${MESSAGE_QUEUE_REDIS_PORT:-$REDIS_HOST_PORT}"

case "$SHAPE" in
  loop|push-tick) ;;
  *)
    echo "[dev:loop] unknown DEV_LOOP_SHAPE='$SHAPE' (expected: loop, push-tick)"
    exit 1
    ;;
esac

echo "[dev:loop] Repo: $REPO_ROOT"
echo "[dev:loop] Profile: $PROFILE"
echo "[dev:loop] Shape: $SHAPE"
echo "[dev:loop] Compose project: $LISTEN_FIRE_STACK"
echo "[dev:loop] Postgres: localhost:$POSTGRES_HOST_PORT  Redis: localhost:$REDIS_HOST_PORT  S3: localhost:$S3_HOST_PORT"

export PORT="${PORT:-$API_BASE}"
# Nothing listens on APP_PORT since the legacy SPA was removed; it survives
# only to give APP_BASE_URL a value. The login + billing-notice links moved to
# WEB_BASE_URL in 5.2b, but the company-profile links (`/c/<slug>`) and the
# invite-proposal `/join/<hashid>` link still bake it in — they are blocked on
# pages apps/web does not have yet, so the var cannot die.
export APP_PORT="${APP_PORT:-$((API_BASE + 1))}"
export WEB_PORT="${WEB_PORT:-$((API_BASE + 3))}"
export FAKE_CHANNELS_PORT="${FAKE_CHANNELS_PORT:-$((HARNESS_BASE + 1))}"
# The fake CRM — the loop's one REMOTE adapter (`acme_crm`), served as a
# durable fixture on this profile's slot. It must be a STABLE port: the
# `remote_adapter` row `dev:seed` installs names this URL, and that row outlives
# any single process, so an ephemeral port would leave the install pointing at a
# dead socket (which is exactly what it used to do).
export FAKE_REMOTE_ADAPTER_PORT="${FAKE_REMOTE_ADAPTER_PORT:-$((HARNESS_BASE + 2))}"
# The fake OpenID Connect issuer, started only when SYSTEM_AUTH_MODES names oidc.
export FAKE_ISSUER_PORT="${FAKE_ISSUER_PORT:-$((HARNESS_BASE + 3))}"
# admin also runs under `pnpm -r --parallel dev`; keep it in this profile's
# range (base+4 — default stays 3004) so an agent stack never collides with
# the default stack's admin.
export ADMIN_PORT="${ADMIN_PORT:-$((API_BASE + 4))}"

# Inter-app URL hints. These flow into the dev CLIs (dev:chat, dev:inject,
# dev:ui, dev:graph) and frontend builds so they target the right stack.
export API_BASE_URL="${API_BASE_URL:-http://localhost:$PORT}"
export APP_BASE_URL="${APP_BASE_URL:-http://localhost:$APP_PORT}"
export WEB_BASE_URL="${WEB_BASE_URL:-http://localhost:$WEB_PORT}"
export ADMIN_BASE_URL="${ADMIN_BASE_URL:-http://localhost:$ADMIN_PORT}"
export FAKE_CHANNELS_URL="${FAKE_CHANNELS_URL:-http://localhost:$FAKE_CHANNELS_PORT}"
export FAKE_REMOTE_ADAPTER_URL="${FAKE_REMOTE_ADAPTER_URL:-http://127.0.0.1:$FAKE_REMOTE_ADAPTER_PORT/}"
export FAKE_ISSUER_URL="${FAKE_ISSUER_URL:-http://127.0.0.1:$FAKE_ISSUER_PORT}"
# Frontend public-env hints (read at vite/next dev time, baked into the bundle).
export VITE_API_BASE_URL="${VITE_API_BASE_URL:-$API_BASE_URL}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-$API_BASE_URL}"

# 1. Ensure docker (postgres + redis + objectstore) is up
echo "[dev:loop] Bringing up postgres + redis + objectstore (idempotent)..."
docker compose -p "$LISTEN_FIRE_STACK" -f dev/docker-compose.yml up -d

# 2. Wait for postgres
echo -n "[dev:loop] Waiting for postgres on localhost:$POSTGRES_HOST_PORT"
for i in $(seq 1 30); do
  if pg_isready -h localhost -p "$POSTGRES_HOST_PORT" -U listenfire >/dev/null 2>&1; then
    echo " ready."
    break
  fi
  echo -n "."
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo
    echo "[dev:loop] postgres did not become ready in 30s"
    exit 1
  fi
done

# 2a. Wait for the object store (it creates the dev bucket as it starts).
echo -n "[dev:loop] Waiting for the object store on localhost:$S3_HOST_PORT"
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$S3_HOST_PORT/healthz" >/dev/null 2>&1; then
    echo " ready."
    break
  fi
  echo -n "."
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo
    echo "[dev:loop] the object store did not become ready in 30s"
    exit 1
  fi
done

# 2b. The agent profile's Postgres/Redis are its OWN containers (see above),
# so on a first boot they are an empty, unmigrated database and a fresh
# cache — every other profile keeps sharing the developer's already-migrated
# one, so none of this runs for them. DATABASE_URL/DATABASE_URL_READONLY
# point at the `listenfire` role and database the compose file itself
# provisions (POSTGRES_USER/POSTGRES_DB above, plus the readonly role from
# dev/readonly-user.sh) rather than at whatever apps/api/.env has locally —
# that .env may name a role that only the DEVELOPER's long-lived Postgres
# volume actually has. `bash migrate.sh` is idempotent (each migration is
# recorded and skipped on a re-run), so this is safe on every boot; NODE_ENV
# is cleared for the call so it does not also run the (slow, unnecessary —
# the generated Prisma/Kysely types are already checked in) codegen tail.
if [ "$PROFILE" = "agent" ]; then
  export DATABASE_URL="${DATABASE_URL:-postgresql://listenfire:localdevpassword@localhost:$POSTGRES_HOST_PORT/listenfire}"
  export DATABASE_URL_READONLY="${DATABASE_URL_READONLY:-postgresql://readonly:readonly@localhost:$POSTGRES_HOST_PORT/listenfire}"

  echo "[dev:loop] Applying schema to the agent stack's own database (idempotent)..."
  NODE_ENV= bash apps/api/src/db/migrate.sh "$DATABASE_URL" \
    || { echo "[dev:loop] schema migration against the agent database failed"; exit 1; }
fi

# 3. Pre-flight: hard-fail if any of THIS profile's ports are already bound.
# Default behaviour aborts; --force-kill claims the ports by killing the
# holders first. The previous behaviour was to warn-and-continue, which let
# the loop boot into a half-broken state (e.g. fake-channels missing).
# Never checks/kills postgres or redis: those are a `docker compose -p
# "$LISTEN_FIRE_STACK"` project scoped to THIS profile's own containers (see
# above), so --force-kill can only ever touch this profile's own app-port
# holders, never another stack's or another project's (e.g. an unrelated
# sibling repo's `dev` compose project) containers.
PORTS_TO_CHECK=("$PORT" "$WEB_PORT" "$FAKE_CHANNELS_PORT" "$FAKE_REMOTE_ADAPTER_PORT" "$ADMIN_PORT" "$FAKE_ISSUER_PORT")

# The loop's own background helpers (fake CRM, fake issuer, scheduler) each run
# in a process group of their own, recorded here, so a stop takes down the
# whole group — the subshell AND the node process it started — and a
# --force-kill can sweep groups a loop that died without its trap left behind.
HELPERS_FILE="$REPO_ROOT/.dev-loop/profiles/$PROFILE.helpers"
kill_helper_groups() {
  [ -f "$HELPERS_FILE" ] || return 0
  while read -r pgid; do
    [ -n "$pgid" ] && kill -TERM -- "-$pgid" 2>/dev/null || true
  done < "$HELPERS_FILE"
  rm -f "$HELPERS_FILE"
}
if [ "$FORCE_KILL" -eq 1 ] && [ -f "$HELPERS_FILE" ]; then
  echo "[dev:loop] --force-kill: terminating the helper process groups a previous loop recorded: $(tr '\n' ' ' < "$HELPERS_FILE")"
  kill_helper_groups
  sleep 1
fi
COLLISIONS=()
for p in "${PORTS_TO_CHECK[@]}"; do
  if lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    COLLISIONS+=("$p")
  fi
done

if [ "${#COLLISIONS[@]}" -gt 0 ]; then
  if [ "$FORCE_KILL" -eq 1 ]; then
    for p in "${COLLISIONS[@]}"; do
      PIDS="$(lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null || true)"
      if [ -n "$PIDS" ]; then
        echo "[dev:loop] --force-kill: terminating PID(s) on port $p: $PIDS"
        echo "$PIDS" | xargs kill -9 2>/dev/null || true
      fi
    done
    # Give the kernel a moment to release the sockets.
    sleep 1
  else
    echo "[dev:loop] aborting: port(s) already in use for profile '$PROFILE': ${COLLISIONS[*]}"
    echo "[dev:loop]   options: stop the holder, pick a different profile (default/agent/agent2/agent3),"
    echo "[dev:loop]            or rerun with --force-kill to claim the ports."
    echo "[dev:loop]   hint: 'pnpm dev:loop:status' lists known loops; --prune drops dead entries."
    exit 1
  fi
fi

# 4. Confirm critical env from apps/api/.env
if ! grep -q "^TEST_HARNESS_TEAM_ID=" apps/api/.env 2>/dev/null; then
  echo "[dev:loop] WARNING: TEST_HARNESS_TEAM_ID not set in apps/api/.env — fakes will not be wired."
fi

# 5. Export dev-loop defaults that aren't already in .env
# MOCK_OUTPUT_ADAPTERS=true ensures the Attio service exists even without ATTIO_CLIENT_ID.
# Real Attio client is still used for the test-harness team via injectFakeBaseUrl.
export MOCK_OUTPUT_ADAPTERS="${MOCK_OUTPUT_ADAPTERS:-true}"

# Point the WhatsApp (Meta Cloud API) Graph base at the fake Meta media
# endpoint so inbound media download (services/whatsapp/dispatch.ts →
# metaApi.downloadMedia) resolves bytes through the fake instead of the real
# graph.facebook.com. The fake mounts the Graph media surface under
# /whatsapp/graph (apps/fake-channels/src/routes/whatsapp.ts).
export WHATSAPP_GRAPH_BASE_URL="${WHATSAPP_GRAPH_BASE_URL:-$FAKE_CHANNELS_URL/whatsapp/graph}"

# `exposeFile` (engine/files/expose.ts) mints blob URLs at /api/files/blob/:id,
# which the API serves. Pin its public base to THIS stack's API origin so the
# blob-URL byte path (exposeFile → /api/files/blob/:id → adapter
# fetchUrlToStream) resolves in-loop. OAUTH_REDIRECT_BASE_URL points at the web
# app on an https port the API doesn't serve, so it can't be used here.
export EXPOSED_FILE_PUBLIC_BASE_URL="${EXPOSED_FILE_PUBLIC_BASE_URL:-$API_BASE_URL}"

# Gmail. The loop runs the DEFAULT connect method — a sign-in as the mailbox,
# against the fake Google in fake-channels — so the path every deployment takes
# is the path the loop proves. `pnpm dev:gmail setup --method delegated`
# re-seeds the other shape when that is what is under test.
export GMAIL_CONNECT_METHOD="${GMAIL_CONNECT_METHOD:-oauth}"
# Sending is off by default everywhere, and the loop turns it on: both writes
# (send and reply) are things the loop has proofs for, and a consent that never
# asked for the scope cannot serve them.
export GMAIL_SEND_ENABLED="${GMAIL_SEND_ENABLED:-true}"
# The dev-loop Gmail credential (_lib.ts's ensureDevLoopGmailCredential) carries
# this exact address. Setting it means the loop exercises the ENFORCED
# allowlist, which is the half a deployment can get wrong — under the sign-in
# method an unset one would restrict nothing and prove nothing.
export GMAIL_MAILBOX_ALLOWLIST="${GMAIL_MAILBOX_ALLOWLIST:-dev-loop@listen-fire.local}"

# The address inbound mail is routed on. It has no default anywhere in the
# code — a default would have every other deployment tell its authors to
# forward mail to Listen-Fire — so the dev loop names Listen-Fire's, which is what every
# fixture is written against.
export INBOUND_EMAIL_ADDRESS="${INBOUND_EMAIL_ADDRESS:-inbox@example.com}"

# Resend's receiving API is where the inbound path goes for the body, the
# headers and the attachment bytes the webhook does NOT carry. Point it at the
# fake so `dev:inject resend-email` resolves in-loop, and fix the webhook
# secret so the injector and the door agree on it (it must match
# DEFAULT_RESEND_WEBHOOK_SECRET in scripts/dev/inject.ts).
export RESEND_API_BASE_URL="${RESEND_API_BASE_URL:-$FAKE_CHANNELS_URL/resend}"
export RESEND_WEBHOOK_SECRET="${RESEND_WEBHOOK_SECRET:-whsec_ZGV2LWxvb3AtcmVzZW5kLXNlY3JldA==}"

# `dev:inject` fires Slack/Telegram/WhatsApp deliveries that carry no real
# signature, and the inbound doors are fail-CLOSED without their signing secret
# (lib/unsigned_webhooks). This is the explicit opt-in that keeps injection
# working; it is refused outright in production, whatever it says here.
export ALLOW_UNSIGNED_WEBHOOKS="${ALLOW_UNSIGNED_WEBHOOKS:-true}"

# The push-tick shape: the API drains only when its tick endpoint is called.
# The shape owns the drain mode outright: a caller's AUTOMATIONS_DRAIN_MODE=loop
# would make this the default shape under another name. Its key is minted
# below, once the fake CRM is up.
if [ "$SHAPE" = "push-tick" ]; then
  export AUTOMATIONS_DRAIN_MODE=external
  export AUTOMATIONS_TICK_URLS="${AUTOMATIONS_TICK_URLS:-$API_BASE_URL/api/v1/system/automations/drain}"
  echo "[dev:loop] AUTOMATIONS_DRAIN_MODE: external  AUTOMATIONS_TICK_URLS: $AUTOMATIONS_TICK_URLS"
fi

# The system endpoints' callers. With oidc named, the API trusts the fake
# issuer, for tokens whose audience is the drain URL and whose subject is the
# scheduler's. The door notifier sends the API key, so with oidc alone it has
# nothing the API would accept, and is turned off (the boot refuses the pair).
SYSTEM_AUTH_MODES="${SYSTEM_AUTH_MODES:-api_key}"
export SYSTEM_AUTH_MODES
case ",${SYSTEM_AUTH_MODES// /}," in
  *,oidc,*) WITH_OIDC=1 ;;
  *) WITH_OIDC=0 ;;
esac
case ",${SYSTEM_AUTH_MODES// /}," in
  *,api_key,*) WITH_API_KEY=1 ;;
  *) WITH_API_KEY=0 ;;
esac
if [ "$WITH_OIDC" -eq 1 ]; then
  export SYSTEM_AUTH_OIDC_ISSUER="${SYSTEM_AUTH_OIDC_ISSUER:-$FAKE_ISSUER_URL}"
  export SYSTEM_AUTH_OIDC_AUDIENCE="${SYSTEM_AUTH_OIDC_AUDIENCE:-$API_BASE_URL/api/v1/system/automations/drain}"
  export SYSTEM_AUTH_OIDC_ALLOWED_SUBJECTS="${SYSTEM_AUTH_OIDC_ALLOWED_SUBJECTS:-dev-loop-scheduler@fake-issuer}"
  if [ "$WITH_API_KEY" -eq 0 ] && [ -n "${AUTOMATIONS_TICK_URLS:-}" ]; then
    unset AUTOMATIONS_TICK_URLS
    echo "[dev:loop] AUTOMATIONS_TICK_URLS unset: the door notifier sends the API key, which oidc alone refuses"
  fi
fi
echo "[dev:loop] SYSTEM_AUTH_MODES: $SYSTEM_AUTH_MODES${SYSTEM_AUTH_OIDC_ISSUER:+  issuer: $SYSTEM_AUTH_OIDC_ISSUER  audience: $SYSTEM_AUTH_OIDC_AUDIENCE}"

echo "[dev:loop] API: $API_BASE_URL"
echo "[dev:loop] WEB: $WEB_BASE_URL"
echo "[dev:loop] FAKE_CHANNELS_URL: $FAKE_CHANNELS_URL"
echo "[dev:loop] FAKE_REMOTE_ADAPTER_URL: $FAKE_REMOTE_ADAPTER_URL"
echo "[dev:loop] MOCK_OUTPUT_ADAPTERS: $MOCK_OUTPUT_ADAPTERS"

# Tee combined output to .dev-loop/loop.log so a session can `tail -F` it
# (or use the dev:logs helper) to see what the API printed in response to
# an inject / chat / inspect command.
LOG_DIR="$REPO_ROOT/.dev-loop"
LOG_FILE="$LOG_DIR/loop.log"
PROFILES_DIR="$LOG_DIR/profiles"
PROFILE_FILE="$PROFILES_DIR/$PROFILE.json"
mkdir -p "$PROFILES_DIR"
: > "$LOG_FILE"
echo "[dev:loop] log: $LOG_FILE"

# One-time migration: the previous single-slot marker is superseded by the
# per-profile files under profiles/.
rm -f "$LOG_DIR/profile.json"

# The agent profile additionally hands out-of-band CLIs its own datastore
# endpoints (see step 2b) — every other profile leaves this empty so the
# CLIs keep resolving DATABASE_URL/etc. from apps/api/.env exactly as before.
EXTRA_ENV_JSON=""
if [ "$PROFILE" = "agent" ]; then
  EXTRA_ENV_JSON=$(cat <<JSON
,
    "DATABASE_URL": "$DATABASE_URL",
    "DATABASE_URL_READONLY": "$DATABASE_URL_READONLY",
    "MESSAGE_QUEUE_REDIS_HOSTNAME": "$MESSAGE_QUEUE_REDIS_HOSTNAME",
    "MESSAGE_QUEUE_REDIS_PORT": "$MESSAGE_QUEUE_REDIS_PORT"
JSON
)
fi

# Write a marker file so that out-of-band dev CLIs (e.g. `pnpm dev:chat`
# invoked in a fresh shell) auto-discover the active stack's ports.
# `_profile_loader.ts` reads this and merges into process.env without
# overwriting existing values. Removed on shutdown.
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$PROFILE_FILE" <<EOF
{
  "profile": "$PROFILE",
  "shape": "$SHAPE",
  "pid": $$,
  "startedAt": "$STARTED_AT",
  "env": {
    "PORT": "$PORT",
    "APP_PORT": "$APP_PORT",
    "WEB_PORT": "$WEB_PORT",
    "FAKE_CHANNELS_PORT": "$FAKE_CHANNELS_PORT",
    "FAKE_REMOTE_ADAPTER_PORT": "$FAKE_REMOTE_ADAPTER_PORT",
    "FAKE_REMOTE_ADAPTER_URL": "$FAKE_REMOTE_ADAPTER_URL",
    "ADMIN_PORT": "$ADMIN_PORT",
    "API_BASE_URL": "$API_BASE_URL",
    "APP_BASE_URL": "$APP_BASE_URL",
    "WEB_BASE_URL": "$WEB_BASE_URL",
    "ADMIN_BASE_URL": "$ADMIN_BASE_URL",
    "FAKE_CHANNELS_URL": "$FAKE_CHANNELS_URL",
    "VITE_API_BASE_URL": "$VITE_API_BASE_URL",
    "NEXT_PUBLIC_API_URL": "$NEXT_PUBLIC_API_URL",
    "GMAIL_CONNECT_METHOD": "$GMAIL_CONNECT_METHOD",
    "GMAIL_SEND_ENABLED": "$GMAIL_SEND_ENABLED",
    "GMAIL_MAILBOX_ALLOWLIST": "$GMAIL_MAILBOX_ALLOWLIST",
    "INBOUND_EMAIL_ADDRESS": "$INBOUND_EMAIL_ADDRESS",
    "MOCK_OUTPUT_ADAPTERS": "$MOCK_OUTPUT_ADAPTERS"$EXTRA_ENV_JSON
  }
}
EOF
echo "[dev:loop] profile marker: $PROFILE_FILE"

# The standalone story bundle, which `GET /api/story/<token>` serves. The API's
# release build emits it; `pnpm dev` compiles nothing, so the loop builds it
# here — otherwise the dev stack serves a story page with no script on it.
echo "[dev:loop] Building the standalone story bundle..."
pnpm --filter story-view bundle >/dev/null \
  || echo "[dev:loop]   WARNING: story bundle build failed — /api/story pages will not render."

# The fake CRM fixture. It isn't a workspace package (it lives in apps/api's
# dev scripts and imports the engine's own protocol server), so
# `pnpm -r --parallel dev` doesn't reach it — the loop starts it itself, and the
# cleanup trap takes it down with the stack.
FAKE_CRM_LOG="$LOG_DIR/fake-crm.log"
mkdir -p "$(dirname "$HELPERS_FILE")"
: > "$HELPERS_FILE"
# Job control gives each background job its own process group (pgid = its pid).
set -m
( cd apps/api && exec pnpm run dev:fake-crm ) > "$FAKE_CRM_LOG" 2>&1 &
FAKE_CRM_PID=$!
set +m
echo "$FAKE_CRM_PID" >> "$HELPERS_FILE"
echo "[dev:loop] fake CRM (acme_crm): $FAKE_REMOTE_ADAPTER_URL (pid $FAKE_CRM_PID, log $FAKE_CRM_LOG)"

FAKE_ISSUER_PID=""
if [ "$WITH_OIDC" -eq 1 ]; then
  FAKE_ISSUER_LOG="$LOG_DIR/fake-issuer.log"
  set -m
  ( cd apps/api && exec pnpm run dev:fake-issuer ) > "$FAKE_ISSUER_LOG" 2>&1 &
  FAKE_ISSUER_PID=$!
  set +m
  echo "$FAKE_ISSUER_PID" >> "$HELPERS_FILE"
  echo "[dev:loop] fake issuer: $FAKE_ISSUER_URL (pid $FAKE_ISSUER_PID, log $FAKE_ISSUER_LOG)"
fi

SCHEDULER_PID=""
cleanup() {
  rm -f "$PROFILE_FILE"
  kill_helper_groups
}
trap cleanup EXIT INT TERM

# The push-tick shape's key and scheduler. The key is minted before the API
# boots, because the API's tick notifier reads it at boot, and after the fake
# CRM is up, because minting provisions the dev-loop team (its owner) the way
# `dev:seed` does, and that installs the fake CRM's adapter. The scheduler is
# handed this loop's pid and exits once that is gone, so a loop killed without
# its trap does not leave it ticking.
if [ "$SHAPE" = "push-tick" ]; then
  echo -n "[dev:loop] Waiting for the fake CRM"
  for i in $(seq 1 60); do
    if curl -s -o /dev/null "$FAKE_REMOTE_ADAPTER_URL"; then echo " up."; break; fi
    echo -n "."
    sleep 1
    if [ "$i" -eq 60 ]; then echo; echo "[dev:loop] the fake CRM did not come up in 60s (log $FAKE_CRM_LOG)"; exit 1; fi
  done
  echo "[dev:loop] Minting the scheduler's system-scope key (dev-loop-scheduler)..."
  AUTOMATIONS_TICK_KEY="$( (cd apps/api && pnpm -s run dev:system-key) | tail -n 1)" || true
  case "$AUTOMATIONS_TICK_KEY" in
    lf_*) ;;
    *) echo "[dev:loop] minting the system-scope key failed (pnpm dev:system-key)"; exit 1 ;;
  esac
  # With oidc alone the API would refuse the key, so neither the notifier nor
  # the scheduler is handed it (the mint still provisioned the team).
  if [ "$WITH_API_KEY" -eq 1 ]; then
    export AUTOMATIONS_TICK_KEY
  else
    unset AUTOMATIONS_TICK_KEY
  fi
  SCHEDULER_LOG="$LOG_DIR/scheduler.log"
  set -m
  bash dev/scheduler.sh "$$" > "$SCHEDULER_LOG" 2>&1 &
  SCHEDULER_PID=$!
  set +m
  echo "$SCHEDULER_PID" >> "$HELPERS_FILE"
  echo "[dev:loop] scheduler: ticks $API_BASE_URL's drain every 5 s (pid $SCHEDULER_PID, log $SCHEDULER_LOG)"
fi

echo "[dev:loop] Starting pnpm dev (parallel: api, web, fake-channels)..."
echo

# Use `script` (BSD/macOS) to keep child stdout flushed line-by-line; falls
# back to plain pipe on systems without it. `set -o pipefail` already on.
if command -v script >/dev/null 2>&1; then
  script -q "$LOG_FILE" pnpm dev
else
  pnpm dev 2>&1 | tee "$LOG_FILE"
fi
