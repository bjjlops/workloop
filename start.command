#!/bin/zsh -l
# Workloop launcher — double-click me (first time: right-click -> Open).
cd "$(dirname "$0")"

# Load the user's shell config so nvm/Homebrew node is on PATH.
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" >/dev/null 2>&1
[ -f "$HOME/.zshrc" ]    && source "$HOME/.zshrc"    >/dev/null 2>&1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js was not found. Install Node 18+ (https://nodejs.org) and run me again."
  echo ""
  echo "  Press any key to close."
  read -k 1 -s
  exit 1
fi

PORT="${PORT:-4317}"
( sleep 1.2; open "http://localhost:${PORT}" ) &

echo ""
echo "  Starting Workloop on http://localhost:${PORT}  (close this window to stop)"
echo ""
exec node server.mjs
