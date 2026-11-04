"""App and tray icon sources for TimeTrack desktop (run with Pillow; see scripts/icons/README.md).

    python scripts/icons/build.py           # writes scripts/icons/app-icon-1024.png and src-tauri/icons/tray-64.rgba
    pnpm tauri icon scripts/icons/app-icon-1024.png --output <tmp>   # then copy the sizes listed in the README

- App icon (owner-approved 2026-11-04): the Beacon mascot's head (headset to chin, from Beacon's
  public/brand/mascot.png) on Beacon's moss (#1f6f54) rounded square.
- Tray icon: the original simplified mark (tray-mark-512.png, the 0.1.0 app icon) as 64×64 raw RGBA, embedded with
  include_bytes! (no extra Tauri image feature). Running / stopped variants are derived from it at run time.
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
MOSS = (31, 111, 84, 255)


def app_icon(size: int = 1024) -> Image.Image:
    mascot = Image.open(HERE / 'mascot-source.png').convert('RGBA')
    head = mascot.crop((335, 105, 690, 335))  # headset to chin; the antenna ball is cut on purpose
    icon = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(icon).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * 0.22), fill=MOSS)
    width = int(size * 0.80)
    height = round(head.height * width / head.width)
    icon.alpha_composite(head.resize((width, height), Image.LANCZOS), ((size - width) // 2, (size - height) // 2 + size // 50))
    return icon


def main() -> None:
    icon = app_icon()
    icon.save(HERE / 'app-icon-1024.png')
    for size in (16, 32):  # legibility check, not committed
        icon.resize((size, size), Image.LANCZOS).save(HERE / f'preview-{size}.png')
    tray = Image.open(HERE / 'tray-mark-512.png').convert('RGBA').resize((64, 64), Image.LANCZOS)
    (ROOT / 'src-tauri' / 'icons' / 'tray-64.rgba').write_bytes(tray.tobytes())


if __name__ == '__main__':
    main()
