#!/usr/bin/env bash
# Publishes the cinema page (src/room + src/shared) to GitHub Pages.
# YouTube refuses embeds on chrome-extension:// pages (error 153), so the
# extension opens this hosted copy instead. Usage: bash tools/publish-cinema.sh
set -euo pipefail

OWNER="Beetlejuice8921"
REPO="videoroom-cinema"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

mkdir -p "$BUILD/room" "$BUILD/shared"
cp "$ROOT"/src/room/room.{html,css,js} "$BUILD/room/"
cp "$ROOT"/src/shared/{rooms.js,embed-player.js} "$BUILD/shared/"
# Pages caches assets for 10 min; version the references so updates apply at once.
VER="$(date +%s)"
sed -i -E "s#(src|href)=\"([^\"]+\.(js|css))\"#\1=\"\2?v=$VER\"#g" "$BUILD/room/room.html"
touch "$BUILD/.nojekyll"
cat > "$BUILD/index.html" <<'HTML'
<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Videoroom</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px">
<h1>Videoroom — кинозал</h1>
<p>Страница мультиракурсного просмотра для расширения Videoroom. Открывается
из расширения со ссылкой на комнату; сама по себе ничего не показывает.</p>
</body></html>
HTML

cd "$BUILD"
git init -q -b main
git add -A
git commit -q -m "Publish Videoroom cinema" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"

if ! gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  gh repo create "$OWNER/$REPO" --public --description "Videoroom cinema page (GitHub Pages)" >/dev/null
fi
git remote add origin "https://github.com/$OWNER/$REPO.git"
git push -q -f origin main

# Enable Pages from main / (no-op if already enabled).
if ! gh api "repos/$OWNER/$REPO/pages" >/dev/null 2>&1; then
  gh api -X POST "repos/$OWNER/$REPO/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null
fi
echo "https://${OWNER,,}.github.io/$REPO/room/room.html"
