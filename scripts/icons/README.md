# App and tray icons

| File | What |
|---|---|
| `mascot-source.png` | Beacon's mascot (`symfony-beacon/public/brand/mascot.png`, 1024×682, transparent). |
| `app-icon-1024.png` | App icon source: the mascot's head on Beacon's moss (`#1f6f54`) rounded square (owner-approved 2026-11-04). |
| `tray-mark-512.png` | The simplified Beacon mark (the 0.1.0 app icon), kept for the tray. |
| `build.py` | Writes `app-icon-1024.png` and `src-tauri/icons/tray-64.rgba` (64×64 raw RGBA, embedded with `include_bytes!`). |

Regenerate (Pillow; the desktop session runs it in `python:3.13-slim`):

```bash
python scripts/icons/build.py
pnpm tauri icon scripts/icons/app-icon-1024.png --output /tmp/tt-icons
cp /tmp/tt-icons/{32x32.png,128x128.png,128x128@2x.png,icon.icns,icon.ico,icon.png} src-tauri/icons/
```

`build.py` also writes `preview-16.png` / `preview-32.png` to check legibility at small sizes (not committed). The tray
uses the mark, not the mascot: running / stopped variants (moss dot / grey) are derived from it at run time.
