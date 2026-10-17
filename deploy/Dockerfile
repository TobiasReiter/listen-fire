# One image, every shape.
#
# Which products a container runs is LISTEN_FIRE_PRODUCTS at RUN time, not a build
# choice (D14, D30(d)) — so `asks` and the full composition are the same bytes
# with a different environment. Building a separate image per product would
# make the composition a fork, which is the thing the carve is undoing.
#
# Build context is the REPOSITORY ROOT, not this directory:
#   docker build -f deploy/Dockerfile -t listen-fire-api .
# The compose file here already says so.

FROM node:22.20.0-slim

# psql: the migration runner is a shell script over src/db/migrations/*.sql.
# curl: the compose healthcheck. openssl: Prisma's engine needs it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client ca-certificates curl openssl \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.5.0 --activate

WORKDIR /srv/listen-fire

# Manifests first, so editing source does not re-run the install. The frontends
# are deployed separately (they are Next apps); this image is the API and its
# workers, so only the api's own workspace closure is installed.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/principal/package.json packages/principal/
COPY packages/file-text/package.json packages/file-text/
COPY packages/model-providers/package.json packages/model-providers/
COPY packages/module-kit/package.json packages/module-kit/
COPY modules/dealroom/package.json modules/dealroom/
COPY modules/google-sheets/package.json modules/google-sheets/
COPY modules/google-drive/package.json modules/google-drive/
COPY packages/engine-contracts/package.json packages/engine-contracts/
COPY packages/movement-engine/package.json packages/movement-engine/
COPY packages/shared/package.json packages/shared/
COPY packages/movement-lang/package.json packages/movement-lang/
COPY packages/story-view/package.json packages/story-view/
RUN pnpm install --frozen-lockfile --filter api...

# Chromium for the browser-rendered document fetches (DocSend, Papermark,
# Notion). Installed through the api's own playwright so the browser build
# matches the lockfile's version. The skip flag above only guards the install
# step, so it is cleared for this one command. A fixed path keeps the browser
# findable by whatever user the container runs as.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN cd apps/api && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 pnpm exec playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

COPY . .

# Secrets live in the `listen-fire-config` volume, not in the image and not in an
# env_file the docker CLI would have to read off the host. Every service sources
# them through this one wrapper.
RUN cp deploy/init/with-generated-env.sh /usr/local/bin/with-generated-env \
  && chmod +x /usr/local/bin/with-generated-env

WORKDIR /srv/listen-fire/apps/api
RUN pnpm prisma generate

# The compiled artifact. Nothing here runs ts-node: `principal` and
# `engine-contracts` are vendored into the api's own build output by this step
# (see each package's tsconfig.build.json), which is what makes
# `node build/server.js` resolvable.
ARG BUILD_HEAP_MB=6144
RUN NODE_OPTIONS=--max-old-space-size=${BUILD_HEAP_MB} pnpm build

# The release this image IS. A tag build passes it (the release workflow does);
# a build from a tree nobody tagged is `dev`. Declared here, after the build, so
# changing it re-runs nothing but these last layers. The process reads it back
# out of the environment and reports it on /healthz/workers and in the UI.
ARG LISTEN_FIRE_VERSION=dev
ENV LISTEN_FIRE_VERSION=${LISTEN_FIRE_VERSION}

LABEL org.opencontainers.image.vendor="Listen-Fire" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/listen-fire/listen-fire"
ENV NODE_ENV=production
ENV TZ=UTC
ENV PORT=3000
EXPOSE 3000

# Migrations are a separate one-shot service in the compose file
# (`pnpm schema:migrate`), so a restart never races the schema.
CMD ["node", "build/server.js"]
