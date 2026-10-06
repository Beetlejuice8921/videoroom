#!/usr/bin/env bash
# Builds the Chrome Web Store upload: dist/videoroom-<version>.zip with only
# what the extension needs at runtime. Usage: bash tools/package.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./manifest.json').version")"
OUT="dist/videoroom-$VERSION.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Every path the manifest references must exist.
node -e '
const m = require("./manifest.json"), fs = require("fs");
const paths = [
  ...Object.values(m.icons), m.action.default_popup, m.background.service_worker,
  ...m.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]),
];
const missing = paths.filter((p) => !fs.existsSync(p));
if (missing.length) { console.error("missing:", missing); process.exit(1); }
'

cp -r manifest.json _locales icons src LICENSE "$STAGE/"
# The cinema page is served from GitHub Pages, not from the package.
rm -rf "$STAGE/src/room"

mkdir -p dist
rm -f "$OUT"
if command -v zip >/dev/null; then
  (cd "$STAGE" && zip -qr -X "$ROOT/$OUT" .)
else
  # Compress-Archive in Windows PowerShell writes "dir\file" entry names, which
  # the Web Store rejects; build the zip with forward slashes instead.
  powershell -NoProfile -Command "
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    \$src = '$(cygpath -w "$STAGE")'
    \$zip = [System.IO.Compression.ZipFile]::Open('$(cygpath -w "$ROOT/$OUT")', 'Create')
    Get-ChildItem -Recurse -File \$src | ForEach-Object {
      \$name = \$_.FullName.Substring(\$src.Length + 1).Replace('\\', '/')
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(\$zip, \$_.FullName, \$name, 'Optimal')
    }
    \$zip.Dispose()"
fi
echo "$OUT ($(du -h "$OUT" | cut -f1))"
