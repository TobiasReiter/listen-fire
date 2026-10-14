#!/bin/bash
# Inter and JetBrains Mono (both SIL OFL) from Google Fonts, as local TTFs, so
# frame capture never waits on the network.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/fonts"
mkdir -p "$DIR" && cd "$DIR"
# An old user agent makes Google Fonts answer with one TrueType file per weight.
curl -s -A "Mozilla/4.0" \
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600;700;800" >fonts.css
n=0
for u in $(grep -o 'https://[^)]*' fonts.css); do
  n=$((n + 1)); f="face-$n.ttf"
  curl -s "$u" -o "$f"
  perl -pi -e "s#\Q$u\E#$f#" fonts.css   # portable in-place edit (BSD and GNU)
done
echo "fonts: $(grep -c font-face fonts.css) faces"
