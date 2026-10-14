#!/bin/bash
# Inter and JetBrains Mono (both SIL OFL) from Google Fonts, as local TTFs, so
# frame capture never waits on the network.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/fonts"
mkdir -p "$DIR" && cd "$DIR"
# An old user agent makes Google Fonts answer with one TrueType file per weight.
curl -s -A "Mozilla/4.0" \
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600;700;800" >fonts.css
for u in $(grep -o 'https://[^)]*' fonts.css); do
  f="$(echo "$u" | md5sum | cut -c1-8).ttf"
  curl -s "$u" -o "$f"
  sed -i "s#$u#$f#" fonts.css
done
echo "fonts: $(grep -c font-face fonts.css) faces"
