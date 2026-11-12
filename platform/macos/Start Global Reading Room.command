#!/bin/bash
# Global Reading Room — macOS double-click launcher
cd "$(dirname "$0")" || exit 1

pause_on_error() {
  echo
  echo "Press Return to close this window."
  read -r _
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required."
  echo "Install it from https://nodejs.org or run: brew install node"
  pause_on_error
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$MAJOR" -lt 20 ] 2>/dev/null; then
  echo "Node.js 20 or newer is required; found $(node -v)."
  pause_on_error
fi

echo "Starting Global Reading Room…"
echo "Keep this window open while you read. Press Control-C to stop."
echo
exec node server.js "$@"
