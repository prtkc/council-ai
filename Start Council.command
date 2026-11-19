#!/bin/zsh -l
# Double-click to start Council, or run: zsh "Start Council.command"
cd "${0:A:h}" || exit 1
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

node_ok() {
  command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null
}

if ! node_ok; then
  export PATH="$PWD/.runtime/node/bin:$PATH"
fi
if ! node_ok; then
  echo "Council needs Node.js 20 or newer, and it was not found on this Mac."
  echo "It can download the official version from nodejs.org into this folder (about 50 MB)."
  echo "This does not change the rest of your Mac and does not need your password."
  echo
  if read -q "?Download it now? [y/n] "; then
    echo
    sh scripts/install-node.sh
  else
    echo
  fi
  if ! node_ok; then
    echo "Council could not start without Node.js."
    read -k 1 "?Press any key to close."
    exit 1
  fi
fi

exec node src/main.js
