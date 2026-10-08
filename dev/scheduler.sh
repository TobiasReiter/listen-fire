#!/usr/bin/env bash
# The push-tick shape's scheduler (dev/loop.sh starts it under
# DEV_LOOP_SHAPE=push-tick): what Cloud Scheduler is on a real deployment. It
# waits for the API to answer its health check, then POSTs the drain tick every
# $DEV_LOOP_TICK_EVERY_S seconds (default 5) and logs each answer — the
# DrainResult — with a UTC timestamp.
#
# Usage: bash dev/scheduler.sh <loop pid>
# Reads API_BASE_URL and AUTOMATIONS_TICK_KEY from the environment loop.sh
# exports. Exits once the loop's pid is gone.
set -uo pipefail

LOOP_PID="${1:?usage: scheduler.sh <loop pid>}"
: "${API_BASE_URL:?API_BASE_URL is not set}"
: "${AUTOMATIONS_TICK_KEY:?AUTOMATIONS_TICK_KEY is not set}"
EVERY_S="${DEV_LOOP_TICK_EVERY_S:-5}"
TICK_URL="$API_BASE_URL/api/v1/system/automations/drain"
HEALTH_URL="$API_BASE_URL/.well-known/health-check"

log() { echo "[scheduler] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

loop_alive() { kill -0 "$LOOP_PID" 2>/dev/null; }

# A tick's curl runs as a background job so a signal reaches this script at
# once, and the EXIT trap takes the job down with it rather than orphaning a
# request that may wait minutes for its drain.
ANSWER_DIR="$(mktemp -d -t scheduler-tick)"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$ANSWER_DIR"' EXIT
trap 'exit 0' INT TERM

log "waiting for the API at $HEALTH_URL"
until curl -sf -o /dev/null "$HEALTH_URL"; do
  loop_alive || { log "the loop (pid $LOOP_PID) is gone; exiting"; exit 0; }
  sleep 1
done
log "API up; ticking $TICK_URL every ${EVERY_S}s"

while loop_alive; do
  # A tick holds the request until its drain goes idle, so ticks never overlap
  # here; the bound is only for a wedged API.
  log "tick start"
  curl -s --max-time 300 -X POST \
    -H "Authorization: Bearer $AUTOMATIONS_TICK_KEY" \
    -H 'content-type: application/json' \
    -d '{}' -w ' HTTP %{http_code}' -o "$ANSWER_DIR/body" "$TICK_URL" > "$ANSWER_DIR/status" 2>&1 &
  wait $!
  log "tick end $(cat "$ANSWER_DIR/body" 2>/dev/null)$(cat "$ANSWER_DIR/status")"
  rm -f "$ANSWER_DIR/body"
  sleep "$EVERY_S" &
  wait $!
done
log "the loop (pid $LOOP_PID) is gone; exiting"
