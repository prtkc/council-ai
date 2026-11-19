#!/bin/zsh
# One-command setup, made for AI assistants that can run commands:
#   zsh scripts/setup.sh            installs both tools
#   zsh scripts/setup.sh claude     only Claude
#   zsh scripts/setup.sh chatgpt    only ChatGPT
# It downloads Node.js into this folder if needed, installs the Claude and ChatGPT
# command-line tools into .tools/, opens a sign-in window for each one that is not
# signed in, and starts Council in the background. It never needs a password.
cd "${0:A:h}/.." || exit 1
source scripts/node-env.sh

if ! node_ok; then
  echo "Downloading Node.js into this folder…"
  sh scripts/install-node.sh || exit 1
  export PATH="$PWD/.runtime/node/bin:$PATH"
fi

exec node scripts/setup.js "$@"
