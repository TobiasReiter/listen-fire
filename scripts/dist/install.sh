#!/bin/sh
# Installs lf from a GitHub release:
#   curl -fsSL https://raw.githubusercontent.com/listen-fire/listen-fire/main/scripts/dist/install.sh | sh
# The archive's checksum is verified against the release's SHA256SUMS before
# anything is installed. Lays down <prefix>/bin/lf and <prefix>/share/lf/modules
# (the built-in modules lf finds beside its binary).
#
#   LF_VERSION=0.1.0   install that release (default: the latest lf release)
#   LF_BASE_URL=<url>  fetch the archive and SHA256SUMS from there (a mirror, or a test)
#   LF_PREFIX=<dir>    install under <dir> (default: ~/.local; --system: /usr/local, with sudo if needed)
set -eu

repo="${LF_REPO:-listen-fire/listen-fire}"
prefix="${LF_PREFIX:-$HOME/.local}"
[ "${1:-}" = "--system" ] && prefix=/usr/local

die() { echo "install.sh: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "needs $1"; }
need curl; need tar; need uname

case "$(uname -s)" in
  Darwin) os=apple-darwin ;;
  Linux) os=unknown-linux-musl ;;
  *) die "unsupported OS $(uname -s) (macOS and Linux)" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) cpu=aarch64 ;;
  x86_64|amd64) cpu=x86_64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
target="$cpu-$os"

if [ -n "${LF_VERSION:-}" ]; then
  tag="lf-v${LF_VERSION#v}"
else
  # The newest release whose tag is an lf release (the repo also tags image releases).
  tag="$(curl -fsSL "https://api.github.com/repos/$repo/releases?per_page=30" |
    sed -n 's/.*"tag_name": *"\(lf-v[^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$tag" ] || die "found no lf release in $repo"
fi

archive="$tag-$target.tar.gz"
base="${LF_BASE_URL:-https://github.com/$repo/releases/download/$tag}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "downloading $archive"
curl -fsSL -o "$work/$archive" "$base/$archive" || die "no $archive in release $tag"
curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS" || die "no SHA256SUMS in release $tag"

expected="$(awk -v f="$archive" '$2 == f { print $1 }' "$work/SHA256SUMS")"
[ -n "$expected" ] || die "SHA256SUMS does not list $archive"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$work/$archive" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$work/$archive" | awk '{ print $1 }')"
else die "needs sha256sum or shasum to verify the download"; fi
[ "$expected" = "$actual" ] || die "checksum mismatch for $archive (expected $expected, got $actual)"

tar -C "$work" -xzf "$work/$archive"
src="$work/$tag-$target"

sudo=""
mkdir -p "$prefix/bin" "$prefix/share/lf" 2>/dev/null || true
if [ ! -w "$prefix/bin" ] || [ ! -w "$prefix/share/lf" ]; then
  need sudo; sudo=sudo
  $sudo mkdir -p "$prefix/bin" "$prefix/share/lf"
fi
$sudo rm -rf "$prefix/share/lf/modules"
$sudo cp -R "$src/share/lf/modules" "$prefix/share/lf/modules"
$sudo cp "$src/bin/lf" "$prefix/bin/lf.new"
$sudo chmod 755 "$prefix/bin/lf.new"
$sudo mv "$prefix/bin/lf.new" "$prefix/bin/lf"

echo "installed lf ${tag#lf-v} to $prefix/bin/lf"
case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *) echo "add $prefix/bin to your PATH" ;;
esac
echo "next: lf init my-project && cd my-project && lf check"
