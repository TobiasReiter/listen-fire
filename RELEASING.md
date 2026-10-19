# Releasing

## Pre-release 0.12.0-rc.1 (run in this order, from a clean `main`)

Every crate and every `@listen-fire/*` package is at `0.12.0-rc.1`.
A suffixed tag never moves `:latest`, npm `latest`, or the default docs.

1. Push the branch.
   ```sh
   git push origin main
   ```
2. Push the three tags (images, `lf` binaries + pre-release GitHub release, docs under `/docs/next/`).
   ```sh
   git tag v0.12.0-rc.1 && git tag lf-v0.12.0-rc.1 && git tag docs-v0.12.0-rc.1
   git push origin v0.12.0-rc.1 lf-v0.12.0-rc.1 docs-v0.12.0-rc.1
   ```
3. Publish the crates, in dependency order (wait a minute between each for the index).
   ```sh
   cargo publish -p listen-fire-parser
   cargo publish -p listen-fire-checker
   cargo publish -p listen-fire-engine
   cargo publish -p listen-fire-language
   cargo publish -p listen-fire
   ```
   A pre-release version is never picked by `cargo install listen-fire` without `--version 0.12.0-rc.1`.
4. Publish the npm packages; each has `publishConfig.tag: "next"`, so none takes `latest`.
   ```sh
   pnpm -r build
   pnpm -r publish --tag next --access public --no-git-checks
   ```
   (`pnpm -r publish` publishes in dependency order and skips private packages.)

## Promoting to a full release

1. Set the version (workspace `Cargo.toml`, the `version = "…"` of each path dependency in `crates/*/Cargo.toml`, every published `package.json`) to the plain version, e.g. `0.12.0`. Update `Cargo.lock`.
2. In `CHANGELOG.md`, rename the pre-release heading to the version and date, and drop the "preview" wording once it is no longer true.
3. Repeat the steps above with plain tags (`v0.12.0`, `lf-v0.12.0`, `docs-v0.12.0`): images also get `:latest`, the GitHub release is a full release, docs become the default.
4. npm: publish without `--tag next`, or move `latest` explicitly: `npm dist-tag add @listen-fire/<name>@0.12.0 latest`. Remove `publishConfig.tag` from the packages before publishing, otherwise they still take `next`.

Note: `0.12.0-rc.1` sorts above the released `0.11.0` and below `0.12.0`. The docs stay under `/docs/next/` until the plain `docs-v0.12.0` tag publishes `/docs/v5/` (and the language server's links switch with the crate version).
