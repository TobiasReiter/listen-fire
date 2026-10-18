#!/bin/bash
# Self-contained checks for two deploy behaviours (no docker needed):
#   1. nothing in the deploy files puts a database URL on a command line that a
#      process manager echoes into a log, and the migration runner stays quiet
#      about the password it was given;
#   2. the MinIO warning in the init wrapper is shown only while a copy of the
#      old files is still owed.
# Run: bash deploy/tests/rehearsal-fixes.test.sh
set -u
DEPLOY="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$DEPLOY/.." && pwd)"
failures=0
check() { # check <name> <condition exit code>
  if [ "$2" -eq 0 ]; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi
}
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# 1a. no `schema:migrate` invocation carries the URL as an argument
grep -rnE 'schema:migrate[^a-z]+("?\$\{?DATABASE_URL|"?postgres)' "$DEPLOY" --include='*.yml' --include='*.md' --include='*.sh' --include='*.toml' --exclude-dir=tests >"$scratch/args" 2>&1
check "no deploy file passes the database URL to schema:migrate" "$([ -s "$scratch/args" ] && echo 1 || echo 0)"

# 1b. the runner, given a URL with a password and a database that refuses, prints no password
mkdir "$scratch/bin"
printf '#!/bin/sh\nexit 2\n' >"$scratch/bin/psql"; chmod +x "$scratch/bin/psql"
PATH="$scratch/bin:$PATH" DATABASE_URL='postgres://lf:s3cr3tpw@db:5432/lf' \
  bash "$ROOT/apps/api/src/db/migrate.sh" >"$scratch/migrate.out" 2>&1
check "migrate.sh output never contains the password" "$(grep -q s3cr3tpw "$scratch/migrate.out" && echo 1 || echo 0)"

# 2. the MinIO warning
warns() { # warns <files to create in config dir...>  (env LF_FRESH_OBJECTSTORE passes through)
  local cfg="$scratch/cfg.$RANDOM"
  mkdir -p "$cfg"; echo pw >"$cfg/objectstore_password"
  for f in "$@"; do echo x >"$cfg/$f"; done
  LF_CONFIG_DIR="$cfg" sh "$DEPLOY/init/with-generated-env.sh" true 2>&1 | grep -q "ran the bundled MinIO"
}
warns minio_password;                    check "copy owed -> warns" "$([ $? -eq 0 ] && echo 0 || echo 1)"
warns minio_password minio_copy_done;    check "copy recorded -> silent" "$([ $? -ne 0 ] && echo 0 || echo 1)"
warns;                                   check "never ran MinIO -> silent" "$([ $? -ne 0 ] && echo 0 || echo 1)"
LF_FRESH_OBJECTSTORE=1 warns minio_password; check "fresh store requested -> silent" "$([ $? -ne 0 ] && echo 0 || echo 1)"

# the copy service records completion only after a successful check
grep -q 'rclone check .* &&' "$DEPLOY/legacy-minio.yml" && grep -q 'touch /config/minio_copy_done' "$DEPLOY/legacy-minio.yml"
check "copy-from-minio records completion after the check" "$?"

[ "$failures" -eq 0 ] && echo "all passed" || { echo "$failures failed"; exit 1; }
