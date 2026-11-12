# Linux

Requires Node.js 20 or newer (`node --version`).

```bash
tar -xzf global-reading-room-1.0.0-linux.tar.gz
cd global-reading-room-1.0.0
chmod +x start.sh
./start.sh
```

The launcher checks the Node.js version and starts the server. It opens the browser when a desktop session is available; on a headless machine run `./start.sh --no-open` and visit the printed address.

The tarball preserves the executable bit on `start.sh`.

Checksum: see `SHA256.txt` in this folder.
