#!/bin/bash
# Global Reading Room — macOS terminal launcher
set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required. Install it with: brew install node"
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$MAJOR" -lt 20 ] 2>/dev/null; then
  echo "Node.js 20 or newer is required; found $(node -v)."
  exit 1
fi

exec node server.js "$@"
