# Android — Termux (no APK)

There is no native APK. This package runs the same application inside Termux from F-Droid.

```bash
unzip global-reading-room-1.0.0-termux.zip -d global-reading-room
cd global-reading-room
bash install-termux.sh
```

The installer adds `nodejs` inside Termux, keeps the device awake, starts the server and prints a `http://127.0.0.1:7317` address for the phone browser. Later sessions: `bash start-termux.sh`.

Checksum: see `SHA256.txt` in this folder.
