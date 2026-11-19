# Sourced by the launcher and setup script (zsh). Puts a usable Node.js on PATH if one exists.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

node_ok() {
  command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null
}

if ! node_ok; then
  export PATH="$PWD/.runtime/node/bin:$PATH"
fi
