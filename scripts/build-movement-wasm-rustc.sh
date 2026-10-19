#!/usr/bin/env bash
# The rustc wrapper scripts/build-movement-wasm.sh builds through, so a macOS
# and a Linux build of the movement artifacts are byte-identical.
#
# Cargo gives each crate a `-C metadata` hash, and rustc derives the crate's
# identity (symbol hashes, type ids, and so the order and bytes of the linked
# code) from it. Cargo's hash covers a crate's build script and proc macros,
# which are compiled for the machine running the build, so it covers that
# machine's target triple: serde, serde_json, indexmap and every crate above
# them got different hashes on aarch64-apple-darwin and x86_64-unknown-linux-gnu,
# and the artifacts the same size but different bytes (measured 2026-10-19).
#
# For the wasm crates only, this replaces that hash with one of the package
# name, its version and the crate name: unique within one build, and the same
# on every machine. Build scripts and proc macros keep cargo's hash; they run
# on the build machine and never reach the artifact.
set -euo pipefail

rustc="$1"
shift

target=""
crate_name=""
prev=""
for arg in "$@"; do
  case "$prev" in
    --target) target="$arg" ;;
    --crate-name) crate_name="$arg" ;;
  esac
  prev="$arg"
done

if [ "$target" != "wasm32-unknown-unknown" ]; then
  exec "$rustc" "$@"
fi

identity="${CARGO_PKG_NAME:-} ${CARGO_PKG_VERSION:-} $crate_name"
if command -v sha256sum >/dev/null; then
  metadata=$(printf '%s' "$identity" | sha256sum | cut -c1-16)
else
  metadata=$(printf '%s' "$identity" | shasum -a 256 | cut -c1-16)
fi

args=()
prev=""
for arg in "$@"; do
  if [ "$prev" = "-C" ] && [[ "$arg" == metadata=* ]]; then
    arg="metadata=$metadata"
  fi
  args+=("$arg")
  prev="$arg"
done
exec "$rustc" "${args[@]}"
