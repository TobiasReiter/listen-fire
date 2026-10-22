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

# A message Gmail's history reports as added but that was deleted before the
# poll read it 404s on messages.get, and v0.11.0 lets that fail the whole scan:
# the checkpoint never moves and the mailbox stops triggering for good. Skip the
# vanished message instead; there is nothing left to triage.
RUN f=build/services/translation_graph/adapters/gmail/poll.js \
 && grep -q "messages.push((0, mime_1.decodeGmailMessage)(await input.client.getMessage(ref.id)));" "$f" \
 && sed -i "s|messages\.push(\(.*\)(await input\.client\.getMessage(ref\.id)));|let message; try { message = await input.client.getMessage(ref.id); } catch (error) { if (error?.failure === 'no_such_mailbox') continue; throw error; } messages.push(\1(message));|" "$f" \
 && grep -q "error?.failure === 'no_such_mailbox'" "$f" \
 && node --check "$f"
