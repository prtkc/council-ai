#!/bin/sh
# Downloads the official Node.js into .runtime/node and verifies its checksum.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BASE=https://nodejs.org/dist/latest-v26.x
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unsupported processor: $(uname -m)"; exit 1 ;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LINE=$(curl -fsSL "$BASE/SHASUMS256.txt" | grep "darwin-$ARCH\.tar\.gz\$")
FILE=$(echo "$LINE" | awk '{print $2}')
echo "Downloading $FILE"
curl -fL --progress-bar -o "$TMP/$FILE" "$BASE/$FILE"
(cd "$TMP" && echo "$LINE" | shasum -a 256 -c - >/dev/null)
mkdir "$TMP/node"
tar -xzf "$TMP/$FILE" --strip-components 1 -C "$TMP/node"
mkdir -p "$ROOT/.runtime"
rm -rf "$ROOT/.runtime/node"
mv "$TMP/node" "$ROOT/.runtime/node"
echo "Node.js is ready."
