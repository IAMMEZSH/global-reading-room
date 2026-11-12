# iPhone / iPad — iSH (experimental)

There is no IPA. This package runs the application inside iSH, which emulates Linux on iOS.

```sh
apk add nodejs unzip
unzip global-reading-room-1.0.0-ish.zip -d global-reading-room
cd global-reading-room
sh start-ish.sh
```

Open the printed `http://127.0.0.1:7317` address in Safari. Keep iSH in the foreground while syncing. Emulation is slow; this path suits reading and small feeds rather than syncing dozens of large feeds.

Checksum: see `SHA256.txt` in this folder.
