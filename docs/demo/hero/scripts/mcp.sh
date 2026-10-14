#!/bin/bash
# Call one tool on the automation MCP connector, exactly as an agent would.
# usage: mcp.sh <tool> '<json args>'   → prints the tool's text result
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
KEY="$(cat "$HERE/.work/key")"
body=$(jq -nc --arg n "$1" --argjson a "${2:-{\}}" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')
curl -s http://localhost:3500/api/v1/mcp/automation \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d "$body" \
  | sed -n 's/^data: //p' | jq -r '.result.content[0].text // .error'
