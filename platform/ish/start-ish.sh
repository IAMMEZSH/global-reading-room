#!/bin/sh
# Global Reading Room — iSH launcher for iPhone and iPad
set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed in this iSH environment."
  echo "Run: apk add nodejs"
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$MAJOR" -lt 20 ] 2>/dev/null; then
  echo "Node.js 20 or newer is required; found $(node -v)."
  echo "Run: apk update && apk upgrade nodejs"
  exit 1
fi

echo
echo "Global Reading Room is starting."
echo "Open http://127.0.0.1:7317 in Safari. Keep iSH in the foreground."
echo "Press Control-C to stop the server."
echo
exec node server.js --no-open "$@"
