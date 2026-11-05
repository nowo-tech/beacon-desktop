"""Builds the extra mascot poses of public/mascot/ from symfony-beacon's character art (see public/mascot/README.md).

Usage: python scripts/mascot/build.py <symfony-beacon checkout> [<output dir>] [--preview <png>]

Each pose is a crop of one Beacon illustration (the robot and its prop, without the big status number), resized to
POSE_HEIGHT px (1x) and 2 x POSE_HEIGHT px (@2x), saved as lossy WebP with alpha. Pillow only.
"""
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

POSE_HEIGHT = 96
QUALITY = 80
# Feather (px, source scale) of the crop edges and erased boxes, so the glows of the art fade out instead of ending in a
# hard rectangle (visible on the dark theme).
FEATHER = 14

# name: (Beacon file, crop box, boxes made transparent first: the parts of the big status number that reach the crop).
# Boxes are left, top, right, bottom in source pixels.
POSES = {
    'pose-card': ('public/illustrations/error-401.png', (182, 86, 470, 540), [(445, 86, 470, 540)]),
    'pose-hourglass': ('public/illustrations/error-408.png', (140, 140, 565, 525), [(432, 140, 565, 333)]),
    'pose-reading': ('public/illustrations/error-400.png', (545, 135, 935, 540), [(545, 135, 602, 415)]),
    'pose-wrench': ('public/illustrations/error-500.png', (450, 140, 910, 535), [(450, 140, 548, 368)]),
    'pose-reconnect': ('public/illustrations/error-502.png', (110, 135, 490, 525), [(432, 135, 490, 318)]),
    'pose-pause': ('public/illustrations/error-429.png', (150, 175, 575, 530), [(395, 175, 575, 332)]),
}


def build(beacon: Path, out: Path) -> list[tuple[str, Image.Image]]:
    out.mkdir(parents=True, exist_ok=True)
    built = []
    for name, (source, box, erase) in POSES.items():
        image = Image.open(beacon / source).convert('RGBA')
        inset = (box[0] + FEATHER, box[1] + FEATHER, box[2] - FEATHER, box[3] - FEATHER)
        mask = Image.new('L', image.size, 0)
        mask.paste(255, inset)
        for area in erase:
            mask.paste(0, area)
        mask = mask.filter(ImageFilter.GaussianBlur(FEATHER / 2))
        image.putalpha(ImageChops.multiply(image.getchannel('A'), mask))
        image = image.crop(box)
        bbox = image.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
        if bbox is not None:
            image = image.crop(bbox)
        for suffix, height in (('', POSE_HEIGHT), ('@2x', POSE_HEIGHT * 2)):
            width = round(image.width * height / image.height)
            image.resize((width, height), Image.LANCZOS).save(out / f'{name}{suffix}.webp', 'WEBP', quality=QUALITY, method=6)
        built.append((name, image))
    return built


def preview(built: list[tuple[str, Image.Image]], path: Path) -> None:
    """Every pose on the light (#f3f6f4) and dark (#0c1210) paper, to check both themes."""
    cells = [image.resize((round(image.width * 192 / image.height), 192), Image.LANCZOS) for _, image in built]
    width = sum(cell.width + 16 for cell in cells) + 16
    sheet = Image.new('RGB', (width, 2 * 224), '#f3f6f4')
    sheet.paste('#0c1210', (0, 224, width, 448))
    x = 16
    for cell in cells:
        for y in (16, 240):
            sheet.paste(cell, (x, y), cell)
        x += cell.width + 16
    sheet.save(path)


if __name__ == '__main__':
    args = [arg for arg in sys.argv[1:] if not arg.startswith('--')]
    if not args:
        sys.exit(__doc__)
    result = build(Path(args[0]), Path(args[1]) if len(args) > 1 else Path(__file__).resolve().parents[2] / 'public' / 'mascot')
    if '--preview' in sys.argv:
        preview(result, Path(sys.argv[sys.argv.index('--preview') + 1]))
