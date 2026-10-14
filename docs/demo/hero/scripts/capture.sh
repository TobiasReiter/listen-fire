#!/bin/bash
# The hero demo's authoring loop and run, against the dev loop booted by
# boot.sh. Plays the agent over the real automation MCP connector, then sends
# the founder's email through the fake Gmail poll. Every response lands in
# .work/capture/, which build_data.cjs turns into the video's data.js.
#
# The run makes one real extraction call, so boot.sh must have started the
# stack with ANTHROPIC_API_KEY set.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORK="$HERE/.work"; CAP="$WORK/capture"
MCP="$HERE/scripts/mcp.sh"
FAKE=http://localhost:6056
mkdir -p "$CAP"

# A key acting as the dev-loop team.
(cd "$REPO/apps/api" && TZ=utc npx ts-node --project tsconfig.dev.json --transpile-only \
  -r dotenv/config -r tsconfig-paths/register "$HERE/scripts/mint_key.ts") \
  | sed -n 's/^KEY=//p' >"$WORK/key"

# Only this demo's automation may listen to the mailbox.
"$MCP" listAutomations '{}' | jq -r '.movements[] | select(.name == "gmail_message_intake" or .name == "Founder intake") | .id' |
  while read -r id; do "$MCP" deleteAutomation "{\"automation\":\"$id\"}" >/dev/null; done

# The agent: read the systems, save the draft (refused), save the fix (live).
"$MCP" getStarted '{}' >"$CAP/01_getStarted.txt"
"$MCP" describeConnection '{"system":"attio","position":"-[:Companies]->"}' >"$CAP/02_describe_companies.txt"
"$MCP" saveAutomation "$(jq -nc --rawfile s "$HERE/programs/draft.mvt" '{source:$s, name:"Founder intake"}')" >"$CAP/10_save_draft.json"
"$MCP" saveAutomation "$(jq -nc --rawfile s "$HERE/programs/fixed.mvt" '{source:$s, name:"Founder intake"}')" >"$CAP/11_save_fixed.json"
jq -e '.ok == false' "$CAP/10_save_draft.json" >/dev/null || { echo "draft unexpectedly saved"; exit 1; }
MOVEMENT=$(jq -er '.movementId' "$CAP/11_save_fixed.json")

cd "$REPO"
# The first poll of a new listener only sets Gmail's change marker.
pnpm -s dev:inject gmail-message --subject "Lunch on Friday?" --from "sam@friend.example" --body "Are you free?" >/dev/null

# Start Attio and Slack from their seed so the cards show this run's writes only.
for s in attio slack; do curl -s -X DELETE "$FAKE/admin/$s/state" >/dev/null; done

pnpm -s dev:inject gmail-message --subject "Lumen Labs: raising our seed round" \
  --from "Maya Chen <maya@lumenlabs.io>" --labels "INBOX,Dealflow" \
  --body "$(cat "$HERE/programs/founder_email.txt")" >"$CAP/20_inject.json"

"$MCP" listRuns "{\"idOrName\":\"$MOVEMENT\"}" >"$CAP/30_runs.json"
RUN=$(jq -er '.runs[0].runId' "$CAP/30_runs.json")
for _ in $(seq 60); do
  "$MCP" checkRun "{\"runId\":\"$RUN\"}" >"$CAP/31_check.json"
  jq -e '.status != "running"' "$CAP/31_check.json" >/dev/null && break
  sleep 2
done
"$MCP" inspectRun "{\"runId\":\"$RUN\"}" >"$CAP/40_inspect.json"
for e in record:companies record:people note entry:vc_deal_flow; do
  curl -s "$FAKE/admin/attio/$e/state" >"$CAP/state_attio_${e//:/_}.json"
done
curl -s "$FAKE/admin/slack/message/state" >"$CAP/state_slack_messages.json"

jq -c '{status, committed, modelCalls, costUsd, failureReason}' "$CAP/40_inspect.json"
