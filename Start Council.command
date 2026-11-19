#!/bin/zsh -l
# Double-click to start Council, or run: zsh "Start Council.command"
# Set COUNCIL_AUTO_NODE=1 to download Node.js without asking, if it is missing.
cd "${0:A:h}" || exit 1
source scripts/node-env.sh

if ! node_ok; then
  echo "Council needs Node.js 20 or newer, and it was not found on this Mac."
  echo "It can download the official version from nodejs.org into this folder (about 50 MB)."
  echo "This does not change the rest of your Mac and does not need your password."
  echo
  if [ "${COUNCIL_AUTO_NODE:-}" = 1 ]; then
    sh scripts/install-node.sh
  elif read -q "?Download it now? [y/n] "; then
    echo
    sh scripts/install-node.sh
  else
    echo
  fi
  if ! node_ok; then
    echo "Council could not start without Node.js."
    [ -t 0 ] && read -k 1 "?Press any key to close."
    exit 1
  fi
fi

exec node src/main.js
