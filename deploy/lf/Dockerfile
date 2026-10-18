# The Rust lf as one container image: `lf serve` (the webhook and callback
# doors) and `lf drain` (workers) are the same image with a different command.
#
# Build context is the repository root:
#   docker build -f deploy/lf/Dockerfile -t lf .

FROM rust:1.99-slim-bookworm AS lf-build
# The pinned toolchain file also asks for the wasm target, which this binary
# does not need; naming the toolchain here skips that download.
ENV RUSTUP_TOOLCHAIN=1.99.0
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
COPY examples/rust-embed examples/rust-embed
# The binary embeds the model price list at compile time, from the engine package.
COPY packages/movement-engine/lib/models/prices.json packages/movement-engine/lib/models/prices.json
RUN cargo build --release --locked -p listen-fire \
  && cp target/release/lf /lf

# The built-in modules run under node (serve-module): install only the module
# kit's, dealroom's and web's closure of the workspace (web brings file-text).
FROM node:22.20.0-slim AS modules-build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.5.0 --activate
WORKDIR /srv/lf
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages
COPY modules modules
RUN pnpm install --frozen-lockfile --filter "@listen-fire/dealroom..." --filter "@listen-fire/web..." --filter "@listen-fire/module-kit..."

FROM node:22.20.0-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/lf
COPY --from=modules-build /srv/lf /srv/lf
COPY --from=lf-build /lf /usr/local/bin/lf
COPY deploy/lf/project /srv/lf/project

ENV LF_BIND=0.0.0.0 PORT=8080
EXPOSE 8080
WORKDIR /srv/lf/project
# Run state is in Postgres (the @lf/postgres-store module), so the container keeps nothing: it
# can be stopped and replaced at any time.
CMD ["sh", "-c", "exec lf serve --port ${PORT}"]
