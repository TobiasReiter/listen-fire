#!/usr/bin/env bash
# The push-tick shape's scheduler (dev/loop.sh starts it under
# DEV_LOOP_SHAPE=push-tick): what Cloud Scheduler is on a real deployment. It
# waits for the API to answer its health check, then POSTs the drain tick every
# $DEV_LOOP_TICK_EVERY_S seconds (default 5) and logs each answer — the
# DrainResult — with a UTC timestamp.
#
# Usage: bash dev/scheduler.sh <loop pid>
# Reads API_BASE_URL and AUTOMATIONS_TICK_KEY from the environment loop.sh
# exports. When SYSTEM_AUTH_MODES names oidc it ticks with an identity token
# instead, minted per tick from the fake issuer (FAKE_ISSUER_URL) for the drain
# URL's audience and the first allowed subject, as Cloud Scheduler sends one.
# Exits once the loop's pid is gone.
set -uo pipefail

LOOP_PID="${1:?usage: scheduler.sh <loop pid>}"
: "${API_BASE_URL:?API_BASE_URL is not set}"
EVERY_S="${DEV_LOOP_TICK_EVERY_S:-5}"
TICK_URL="$API_BASE_URL/api/v1/system/automations/drain"
MODES="${SYSTEM_AUTH_MODES:-api_key}"
case ",${MODES// /}," in
  *,oidc,*)
    AUTH=oidc
    : "${FAKE_ISSUER_URL:?FAKE_ISSUER_URL is not set}"
    : "${SYSTEM_AUTH_OIDC_AUDIENCE:?SYSTEM_AUTH_OIDC_AUDIENCE is not set}"
    SUBJECT="${SYSTEM_AUTH_OIDC_ALLOWED_SUBJECTS%%,*}"
    ;;
  *)
    AUTH=api_key
    : "${AUTOMATIONS_TICK_KEY:?AUTOMATIONS_TICK_KEY is not set}"
    ;;
esac

# The bearer for one tick. A token is minted fresh each time, as a scheduler's
# would be; it is never logged.
bearer() {
  case "$AUTH" in
    oidc) curl -sf --get --data-urlencode "sub=$SUBJECT" --data-urlencode "aud=$SYSTEM_AUTH_OIDC_AUDIENCE" "$FAKE_ISSUER_URL/mint" ;;
    *) printf '%s' "$AUTOMATIONS_TICK_KEY" ;;
  esac
}
HEALTH_URL="$API_BASE_URL/.well-known/health-check"

log() { echo "[scheduler] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

loop_alive() { kill -0 "$LOOP_PID" 2>/dev/null; }

# A tick's curl runs as a background job so a signal reaches this script at
# once, and the EXIT trap takes the job down with it rather than orphaning a
# request that may wait minutes for its drain.
ANSWER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/scheduler-tick.XXXXXX")"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$ANSWER_DIR"' EXIT
trap 'exit 0' INT TERM

log "waiting for the API at $HEALTH_URL"
until curl -sf -o /dev/null "$HEALTH_URL"; do
  loop_alive || { log "the loop (pid $LOOP_PID) is gone; exiting"; exit 0; }
  sleep 1
done
log "API up; ticking $TICK_URL every ${EVERY_S}s, authenticating with $AUTH"

while loop_alive; do
  # A tick holds the request until its drain goes idle, so ticks never overlap
  # here; the bound is only for a wedged API.
  log "tick start"
  BEARER="$(bearer)" || { log "tick skipped: no bearer (the fake issuer did not mint one)"; sleep "$EVERY_S"; continue; }
  curl -s --max-time 300 -X POST \
    -H "Authorization: Bearer $BEARER" \
    -H 'content-type: application/json' \
    -d '{}' -w ' HTTP %{http_code}' -o "$ANSWER_DIR/body" "$TICK_URL" > "$ANSWER_DIR/status" 2>&1 &
  wait $!
  log "tick end $(cat "$ANSWER_DIR/body" 2>/dev/null)$(cat "$ANSWER_DIR/status")"
  rm -f "$ANSWER_DIR/body"
  sleep "$EVERY_S" &
  wait $!
done
log "the loop (pid $LOOP_PID) is gone; exiting"
