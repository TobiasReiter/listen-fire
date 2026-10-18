#!/bin/sh
# Load the generated secrets, then become the real command.
#
# `env_file` cannot reach into a named volume (the docker CLI reads it on the
# host), so the volume is mounted at /config and sourced HERE instead. Values are
# single-quoted by the generator, so `.` is safe for base64 and for URLs.
set -e

# Overridable only so the test can point at a scratch directory.
CONFIG_DIR="${LF_CONFIG_DIR:-/config}"

# The generated file names the BUNDLED database, so sourcing it blindly would
# overwrite a database the operator named themselves — the one thing that must
# not happen, because that variable is also what tells compose not to start the
# bundled Postgres at all. Whatever the operator set wins; the generated value
# is the default for an installation that named nothing.
OPERATOR_DATABASE_URL="${DATABASE_URL:-}"
OPERATOR_DATABASE_URL_READONLY="${DATABASE_URL_READONLY:-}"

if [ -f "$CONFIG_DIR/generated.env" ]; then
  set -a
  . "$CONFIG_DIR/generated.env"
  set +a
fi

if [ -n "$OPERATOR_DATABASE_URL" ]; then
  export DATABASE_URL="$OPERATOR_DATABASE_URL"
  # An external database with no replica named: the read-only URL is the same
  # database, which is what every guide already tells you to set it to. Without
  # this it would still point at the bundled Postgres, which is not running.
  export DATABASE_URL_READONLY="${OPERATOR_DATABASE_URL_READONLY:-$OPERATOR_DATABASE_URL}"
elif [ -n "$OPERATOR_DATABASE_URL_READONLY" ]; then
  export DATABASE_URL_READONLY="$OPERATOR_DATABASE_URL_READONLY"
fi

# The bundled object store, on the same rule: an operator who supplied a key of
# their own has an object store of their own, and nothing here touches it.
# Otherwise this installation's own SeaweedFS (the `objectstore` service) is the
# store, and these are the four values the S3 adapter needs plus the endpoint
# and the path-style flag it needs to speak to it at all (the flag is compared
# to the literal lowercase
# `true`). The password is a file, not a line in generated.env, because an
# installation older than the bundled store has a generated.env that the
# generator will never rewrite.
# The test is AWS_S3_ENDPOINT, the same variable that tells compose not to start
# the bundled store, so the two can never disagree about which store is in use.
if [ -z "${AWS_S3_ENDPOINT:-}" ] && [ -z "${AWS_SECRET_ACCESS_KEY:-}" ] && [ -f "$CONFIG_DIR/objectstore_password" ]; then
  export AWS_S3_ENDPOINT=http://objectstore:8333
  export AWS_ACCESS_KEY_ID=listenfire
  AWS_SECRET_ACCESS_KEY="$(cat "$CONFIG_DIR/objectstore_password")"
  export AWS_SECRET_ACCESS_KEY
  export AWS_DOCUMENT_S3_BUCKET="${AWS_DOCUMENT_S3_BUCKET:-listen-fire}"
  export AWS_REGION="${AWS_REGION:-auto}"
  export AWS_S3_FORCE_PATH_STYLE=true
  # A config volume that still holds minio_password belongs to an installation
  # that ran the bundled MinIO. A container cannot see the host's volumes, so it
  # cannot tell whether the files were moved -- except that the documented copy
  # (legacy-minio.yml's copy-from-minio) records minio_copy_done here when it
  # succeeds. Warn only while a copy is still owed. This never blocks: ./up.sh
  # holds the real guard, and a bare `docker compose up` must keep working for
  # installations that never had files.
  if [ -f "$CONFIG_DIR/minio_password" ] && [ ! -f "$CONFIG_DIR/minio_copy_done" ] && [ "${LF_FRESH_OBJECTSTORE:-}" != 1 ]; then
    echo "WARNING: this installation ran the bundled MinIO ($CONFIG_DIR/minio_password exists) and no copy of its files into the new SeaweedFS store has been recorded. If they were not copied they are NOT visible here: see SELF_HOSTING.md, 'Upgrading from the bundled MinIO'. Set LF_FRESH_OBJECTSTORE=1 to silence this." >&2
  fi
fi

# The dev-loop harness ids are a SWITCH, not identity. `isTestHarnessTeam` is a
# bare comparison against them — no NODE_ENV gate — and a match rewrites every
# outbound integration credential to the fake-channels URL, so a real install
# that carried them would talk to nothing and say nothing about it. They are
# therefore derived here, per boot, and only when this IS the demo.
#
# The `unset` is not belt-and-braces: an installation whose generated.env was
# written by an older version of the generator still HAS the two lines in it,
# and the `.` above just sourced them. This is what makes those volumes safe.
if [ "${LISTEN_FIRE_DEMO:-0}" = "1" ]; then
  export TEST_HARNESS_TEAM_ID="${LISTEN_FIRE_TEAM_ID:-}"
  export TEST_HARNESS_USER_ID="${LISTEN_FIRE_USER_ID:-}"
else
  unset TEST_HARNESS_TEAM_ID TEST_HARNESS_USER_ID
fi

exec "$@"
