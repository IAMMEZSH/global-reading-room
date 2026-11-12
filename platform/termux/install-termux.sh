#!/data/data/com.termux/files/usr/bin/bash
# Global Reading Room — Termux installer and launcher
set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js inside Termux…"
  pkg update -y
  pkg install -y nodejs
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js installation failed. Run 'pkg install nodejs' and try again."
  exit 1
fi

# Keep the process alive while the screen is off.
termux-wake-lock 2>/dev/null || true

echo
echo "Global Reading Room is starting."
echo "Open http://127.0.0.1:7317 in your phone browser."
echo "Press Control-C to stop the server."
echo
exec node server.js "$@"
