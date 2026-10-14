#!/bin/sh
# First boot: mint every secret this installation will ever use.
#
# Runs ONCE. If /config/generated.env already exists this script rewrites
# nothing and exits 0 — a rotated ENCRYPTION_MASTER_KEY makes every stored
# credential unreadable, and a rotated TOKEN_SECRET signs everybody out. Back the
# volume up; do not regenerate it.
set -eu

CONFIG_DIR="${CONFIG_DIR:-/config}"
TARGET="$CONFIG_DIR/generated.env"
PGPASS_FILE="$CONFIG_DIR/postgres_password"
OBJECTSTORE_PASS_FILE="$CONFIG_DIR/objectstore_password"

# Governs every file/dir this script creates below, including CONFIG_DIR
# itself on a from-scratch volume.
umask 077
mkdir -p "$CONFIG_DIR"

# A crash between writing the .tmp and the rename leaves a stale partial
# write; it is safe to discard because the finished generated.env (below) is
# the only thing that gates re-generation.
rm -f "$TARGET.tmp" "$PGPASS_FILE.tmp" "$OBJECTSTORE_PASS_FILE.tmp"

# node, not openssl: node:22-slim carries no openssl CLI.
rand_base64() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))'; }
rand_url()    { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))'; }
new_uuid()    { node -e 'process.stdout.write(require("crypto").randomUUID())'; }

# The bundled object store's S3 secret. Minted OUTSIDE the one-way-door set
# below, and separately from generated.env, for two reasons: an installation
# older than the bundled store has a generated.env that this script will never
# rewrite, and this password is not a one-way door — nothing is encrypted under
# it, so an installation that loses it re-mints it and carries on.
# An installation that ran the bundled MinIO also has a `minio_password` here;
# it is left exactly as it is — it is the credential that MinIO's volume still
# answers to (SELF_HOSTING.md, "Upgrading from the bundled MinIO").
if [ ! -f "$OBJECTSTORE_PASS_FILE" ]; then
  rand_url > "$OBJECTSTORE_PASS_FILE.tmp"
  mv "$OBJECTSTORE_PASS_FILE.tmp" "$OBJECTSTORE_PASS_FILE"
fi

# A deployment with no model key has no agents, no property arbitration and no
# extraction. It is still a deployment: the graph, the CRM writes, the query
# surfaces and the whole of core work without one, and the code treats a
# missing key as a supported state that degrades LOUDLY at the point of use
# (`KnowledgeLlmUnavailable`, and a platform key read on first call rather than
# on import, so that a keyless process boots on purpose).
#
# This used to exit 1, which stopped an operator standing the stack up at all
# before they had a key — including the ordinary order of standing it up,
# proving it healthy behind TLS, and then configuring it. It also sat below the
# early exit above, so it only ever fired on the very first boot: an
# installation that came up once with --demo never saw it again. A check that
# holds once is not a guarantee, and this one guarded nothing this script
# writes. So: say it, loudly, on every boot.
#
# Which credentials are missing follows MODEL_MAP: a line sending a model name
# to vertex or gemini goes through the deployment's one Google service account,
# and every name the map leaves alone goes to its own vendor's key. Boot checks
# the map exactly; this is the early, loud hint.
if [ "${LISTEN_FIRE_DEMO:-0}" != "1" ]; then
  case "${MODEL_MAP:-}" in
    *'"vertex/'* | *'"gemini/'*)
      if [ -z "${GOOGLE_PRIVATE_KEY:-}" ] ||
         [ -z "${GOOGLE_CLIENT_EMAIL:-}" ] ||
         [ -z "${GOOGLE_PROJECT_ID:-}" ]; then
        echo "[init] WARNING: MODEL_MAP sends model names to Google but the Google service account is not configured." >&2
        echo "[init]   Set GOOGLE_PRIVATE_KEY, GOOGLE_CLIENT_EMAIL and GOOGLE_PROJECT_ID" >&2
        echo "[init]   in deploy/.env. The API will refuse to boot until they are set." >&2
      fi
      ;;
  esac
  if [ -z "${MODEL_MAP:-}" ] &&
     [ -z "${ANTHROPIC_API_KEY:-}" ] &&
     [ -z "${KNOWLEDGE_LLM_API_KEY:-}" ] &&
     [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "[init] WARNING: deploy/.env names no model key." >&2
    echo "[init]   Any ONE of ANTHROPIC_API_KEY, KNOWLEDGE_LLM_API_KEY or" >&2
    echo "[init]   OPENAI_API_KEY satisfies this." >&2
    echo "[init]   The stack will start and serve. Agents, extraction and the" >&2
    echo "[init]   arbitration of conflicting facts will fail when they are asked" >&2
    echo "[init]   for, naming the missing key." >&2
  fi
fi

if [ -f "$TARGET" ]; then
  echo "[init] $TARGET exists — leaving every secret exactly as it is."
  exit 0
fi

# The dev-loop harness ids (TEST_HARNESS_TEAM_ID / TEST_HARNESS_USER_ID) are
# deliberately NOT written here. They are not identity — they are a switch:
# `isTestHarnessTeam` compares a team against them with no NODE_ENV gate, and a
# match rewrites every outbound integration credential to the fake-channels URL.
# Baked into the permanent secrets file they would make a real self-host talk to
# nothing, silently. `with-generated-env` derives them at run time, and only
# when LISTEN_FIRE_DEMO=1.

# Escapes a value for embedding inside single quotes in POSIX sh: ' -> '\''
# Only operator-supplied values (team name, admin email) ever need this —
# every other field here is this script's own hex/base64/uuid output.
sq() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }

POSTGRES_PASSWORD="$(rand_url)"
TOKEN_SECRET="$(rand_url)"
# Signs the settle POSTs a `webhook`-delivery asks deployment sends. Without it
# the delivery worker holds every settle rather than sending one a receiver
# cannot authenticate, so a standalone asks install needs it from boot.
ASKS_WEBHOOK_SIGNING_SECRET="$(rand_url)"
# Signs the public document links handed to the outside world (a CRM field, a
# chat message). The signature is the ONLY thing authorising the download.
DOCUMENT_LINK_SECRET="$(rand_url)"
ENCRYPTION_MASTER_KEY="$(rand_base64)"
ENCRYPTION_SALT_BASE64="$(rand_base64)"
LISTEN_FIRE_TEAM_ID="$(new_uuid)"
LISTEN_FIRE_USER_ID="$(new_uuid)"
PUBLIC_USER_ID="$(new_uuid)"
LISTEN_FIRE_API_KEY="lf_$(rand_url)"
TEAM_NAME="$(sq "${LISTEN_FIRE_TEAM_NAME:-Acme}")"
ADMIN_EMAIL="$(sq "${LISTEN_FIRE_ADMIN_EMAIL:-admin@listen-fire.local}")"
DB="postgresql://listenfire:${POSTGRES_PASSWORD}@postgres:5432/listenfire"

# postgres_password first: DATABASE_URL above already has the raw password
# baked in, so writing this file's existence has no bearing on the
# idempotency gate — generated.env, written last, is that gate.
printf '%s' "$POSTGRES_PASSWORD" > "$PGPASS_FILE.tmp"
mv "$PGPASS_FILE.tmp" "$PGPASS_FILE"

cat > "$TARGET.tmp" <<EOF
# Generated on first boot. NEVER edit or regenerate these — rotating
# ENCRYPTION_MASTER_KEY or ENCRYPTION_SALT_BASE64 makes every stored credential
# unreadable, and rotating TOKEN_SECRET signs everybody out. Back this volume up.
POSTGRES_PASSWORD='${POSTGRES_PASSWORD}'
DATABASE_URL='${DB}'
DATABASE_URL_READONLY='${DB}'
TOKEN_SECRET='${TOKEN_SECRET}'
SESSION_JWT_AUDIENCE='listen-fire-self-host'
ASKS_WEBHOOK_SIGNING_SECRET='${ASKS_WEBHOOK_SIGNING_SECRET}'
DOCUMENT_LINK_SECRET='${DOCUMENT_LINK_SECRET}'
ENCRYPTION_MASTER_KEY='${ENCRYPTION_MASTER_KEY}'
ENCRYPTION_SALT_BASE64='${ENCRYPTION_SALT_BASE64}'
LISTEN_FIRE_TEAM_ID='${LISTEN_FIRE_TEAM_ID}'
LISTEN_FIRE_TEAM_NAME='${TEAM_NAME}'
LISTEN_FIRE_USER_ID='${LISTEN_FIRE_USER_ID}'
LISTEN_FIRE_API_KEY='${LISTEN_FIRE_API_KEY}'
PUBLIC_USER_ID='${PUBLIC_USER_ID}'
LISTEN_FIRE_BOOTSTRAP_TEAM_NAME='${TEAM_NAME}'
LISTEN_FIRE_BOOTSTRAP_USER_EMAIL='${ADMIN_EMAIL}'
EOF
mv "$TARGET.tmp" "$TARGET"

echo "[init] wrote $TARGET (team ${LISTEN_FIRE_TEAM_ID})"
