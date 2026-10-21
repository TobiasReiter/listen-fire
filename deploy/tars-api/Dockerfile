# The published API release plus Skaala's patches, nothing rebuilt: each patch
# edits the compiled output and fails the build if its anchor is missing, so a
# new release that moved the code stops here instead of shipping unpatched.
#
# Bump the tag together with deploy/render.yaml's web branch (same release).
FROM ghcr.io/listen-fire/api:v0.11.0

# MODEL_MAP sends claude-sonnet-5 to the wire model claude-sonnet-5-5, which
# v0.11.0's price table does not know, so every call was recorded at $0 (and
# MOVEMENT_MAX_RUN_COST_USD could never trip). Price it as Sonnet 5.
RUN f=build/lib/llm_usage.js \
 && grep -q "'claude-sonnet-5': {" "$f" \
 && sed -i "s|'claude-sonnet-5': {|'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheCreation: 2.5 },\n  'claude-sonnet-5': {|" "$f" \
 && grep -q "'claude-sonnet-5-5'" "$f"
