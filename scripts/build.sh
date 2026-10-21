#!/bin/sh
# Build the installable release zip from the COMMITTED tree (git archive), so
# the zip is exactly what the tag points at, never uncommitted edits.
#   scripts/build.sh            -> dist/instagram-dm-capture-v<manifest version>.zip
set -eu
cd "$(dirname "$0")/.."

# Every file the extension loads at runtime. test/e2e-test.js --ext on the
# unzipped build is the check that nothing is missing here.
FILES="manifest.json hook.js bridge.js background.js parse.js popup.html popup.js offscreen.html offscreen.js"

VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/instagram-dm-capture-v$VERSION.zip"

if [ -n "$(git status --porcelain -- $FILES)" ]; then
  echo "uncommitted changes in extension files; commit first" >&2
  exit 1
fi

mkdir -p dist
rm -f "$OUT"
git archive --format=zip -o "$OUT" HEAD $FILES
echo "$OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, $(git rev-parse --short HEAD))"
