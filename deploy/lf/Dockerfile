# The Rust lf as one container image: `lf-host serve` (the webhook and callback
# doors) and `lf-host drain` (workers) are the same image with a different command.
#
# Build context is the repository root:
#   docker build -f deploy/lf/Dockerfile -t lf .

FROM rust:1.99-slim-bookworm AS lf-build
# The pinned toolchain file also asks for the wasm target, which this binary
# does not need; naming the toolchain here skips that download.
ENV RUSTUP_TOOLCHAIN=1.99.0-x86_64-unknown-linux-gnu
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
RUN cargo build --release --locked -p lf-host \
  && cp target/release/lf-host /lf-host

# The built-in modules run under node (serve-module): install only the module
# kit's and dealroom's closure of the workspace.
FROM node:22.20.0-slim AS modules-build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.5.0 --activate
WORKDIR /srv/lf
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages
COPY modules modules
RUN pnpm install --frozen-lockfile --filter "@lf/dealroom..." --filter "module-kit..."

FROM node:22.20.0-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/lf
COPY --from=modules-build /srv/lf /srv/lf
COPY --from=lf-build /lf-host /usr/local/bin/lf-host
COPY deploy/lf/project /srv/lf/project

ENV LF_BIND=0.0.0.0 PORT=8080
EXPOSE 8080
WORKDIR /srv/lf/project
# Run state is in Postgres (LF_STORE_URL), so the container keeps nothing: it
# can be stopped and replaced at any time.
CMD ["sh", "-c", "exec lf-host serve --port ${PORT}"]
