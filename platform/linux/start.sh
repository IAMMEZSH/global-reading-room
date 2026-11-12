#!/bin/sh
# Global Reading Room — Linux launcher
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required."
  echo "Install it with your package manager, for example:"
  echo "  sudo apt install nodejs        # Debian / Ubuntu"
  echo "  sudo dnf install nodejs        # Fedora"
  echo "  sudo pacman -S nodejs          # Arch"
  echo "Then run ./start.sh again."
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$MAJOR" -lt 20 ] 2>/dev/null; then
  echo "Node.js 20 or newer is required; found $(node -v)."
  exit 1
fi

exec node server.js "$@"
