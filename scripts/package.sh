#!/bin/sh
# Builds dist/Council.zip for sharing. Your runs and installed tools are left out.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/Council"
rsync -a --exclude runs --exclude .runtime --exclude .tools --exclude dist --exclude .claude --exclude .git --exclude .DS_Store --exclude node_modules "$ROOT/" "$TMP/Council/"
chmod +x "$TMP/Council/Start Council.command"
mkdir -p "$ROOT/dist"
rm -f "$ROOT/dist/Council.zip"
ditto -c -k --norsrc --noextattr --noacl --keepParent "$TMP/Council" "$ROOT/dist/Council.zip"
echo "Created $ROOT/dist/Council.zip"
