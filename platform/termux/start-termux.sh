#!/data/data/com.termux/files/usr/bin/bash
# Global Reading Room — Termux launcher for later runs
set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Run: bash install-termux.sh"
  exit 1
fi

termux-wake-lock 2>/dev/null || true
exec node server.js "$@"
