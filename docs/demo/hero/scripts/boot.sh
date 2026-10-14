#!/bin/bash
# Boot the agent dev loop in a fresh Linux cloud container and provision what
# the hero demo needs (dev team, Gmail + Slack credentials). Idempotent.
#
# Works around three things a fresh container hits (none are needed on a
# developer's Mac with the stack already set up):
#   - Docker Hub rate limits: pull redis and pgvector through mirror.gcr.io;
#   - dev/loop.sh calls BSD `script`: a shim translates it for util-linux;
#   - a fresh clone has no generated Prisma client.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORK="$HERE/.work"
mkdir -p "$WORK/bin"

if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  (dockerd >"$WORK/dockerd.log" 2>&1 &)
  until docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do sleep 1; done
fi
for img in library/redis:7.2-alpine pgvector/pgvector:pg15; do
  local_tag="${img#library/}"
  docker image inspect "$local_tag" >/dev/null 2>&1 || {
    docker pull "mirror.gcr.io/$img" && docker tag "mirror.gcr.io/$img" "$local_tag"
  }
done

[ -f "$REPO/apps/api/.env" ] || cp "$REPO/apps/api/.env.example" "$REPO/apps/api/.env"
[ -d "$REPO/node_modules" ] || (cd "$REPO" && pnpm install --frozen-lockfile)
(cd "$REPO/apps/api" && pnpm exec prisma generate >/dev/null)

cat >"$WORK/bin/script" <<'EOF'
#!/bin/bash
# BSD `script -q LOG cmd...` -> util-linux `script -q -e -c "cmd..." LOG`
shift; log="$1"; shift
exec /usr/bin/script -q -e -c "$*" "$log"
EOF
chmod +x "$WORK/bin/script"

if [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3500/healthz)" = "000" ]; then
  # A cloud session points ANTHROPIC_BASE_URL at its own proxy; the stack's
  # model calls must go to Anthropic itself, with ANTHROPIC_API_KEY from the
  # environment's settings.
  [ -n "${ANTHROPIC_API_KEY:-}" ] || echo "warning: ANTHROPIC_API_KEY unset, so the demo's extraction will fail" >&2
  (cd "$REPO" && PATH="$WORK/bin:$PATH" ANTHROPIC_BASE_URL=https://api.anthropic.com \
    nohup pnpm dev:loop:agent --force-kill >"$WORK/loop.out" 2>&1 &)
  echo "waiting for the API on :3500 (first boot compiles for a few minutes)…"
  until [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3500/healthz)" != "000" ]; do
    grep -q ELIFECYCLE "$WORK/loop.out" && { tail -20 "$WORK/loop.out"; exit 1; }
    sleep 3
  done
fi

cd "$REPO"
pnpm -s dev:seed >/dev/null
pnpm -s dev:gmail setup >/dev/null
echo "stack up, team seeded, Gmail + Slack provisioned"
