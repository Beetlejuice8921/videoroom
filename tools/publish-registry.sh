#!/usr/bin/env bash
# Publishes the shared-rooms registry code (registry/ + the room model) to
# GitHub. Room data in that repo is written by its GitHub Action, so this
# script only updates code files and never touches index.json / rooms/.
# Usage: bash tools/publish-registry.sh
set -euo pipefail

OWNER="Beetlejuice8921"
REPO="videoroom-rooms"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  gh repo create "$OWNER/$REPO" --public --description "Videoroom shared rooms registry" >/dev/null
fi

cd "$WORK"
if git clone -q "https://github.com/$OWNER/$REPO.git" repo 2>/dev/null && [ -n "$(ls -A repo 2>/dev/null | grep -v '^\.git$')" ]; then
  cd repo
else
  rm -rf repo && mkdir repo && cd repo
  git init -q -b main
  git remote add origin "https://github.com/$OWNER/$REPO.git"
fi

mkdir -p scripts .github/workflows rooms
cp "$ROOT/registry/README.md" README.md
cp "$ROOT/registry/scripts/submit.js" scripts/submit.js
cp "$ROOT/src/shared/rooms.js" scripts/rooms.js
cp "$ROOT/registry/.github/workflows/submit.yml" .github/workflows/submit.yml
[ -f index.json ] || printf '{\n  "version": 1,\n  "videos": {},\n  "rooms": {}\n}\n' > index.json
[ -f rooms/.gitkeep ] || touch rooms/.gitkeep
printf '.result*\n' > .gitignore

git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "Update registry code" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push -q origin main
fi
echo "https://github.com/$OWNER/$REPO"
