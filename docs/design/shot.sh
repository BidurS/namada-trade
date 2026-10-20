#!/usr/bin/env bash
# usage: docs/design/shot.sh <file.html|url> <out.png> <width> <height> [scale=1]
# Renders with headless Chrome at an exact viewport. Phone: width 375, scale 2. Desktop: width 1280, scale 1.
# Height is the capture height in CSS px: pick it from the content (too short crops, too tall leaves blank).
set -euo pipefail
SRC="$1"; OUT="$2"; W="$3"; H="$4"; S="${5:-1}"
case "$SRC" in http*|file:*) URL="$SRC" ;; *) URL="file://$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")" ;; esac
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor="$S" --window-size="$W,$H" --virtual-time-budget=12000 --screenshot="$OUT" "$URL" >/dev/null 2>&1
echo "$OUT"
