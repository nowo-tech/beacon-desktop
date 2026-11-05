#!/usr/bin/env bash
# Imports the friendly-message mascot art (see public/mascot/README.md).
#
# Usage: scripts/mascot/import-poses.sh <dir with pose-<id>.png> [<output dir, default public/mascot>]
#
# Each pose-<id>.png (transparent or on an opaque white background, e.g. 1024 x 1024; <id> from POSE_IDS in
# src/lib/messages/types.ts) is cleaned up (see clean() below), trimmed to its visible pixels and saved as public/mascot/pose-<id>.webp (96 px high) and pose-<id>@2x.webp (192 px high), lossy WebP
# quality 80 with alpha: the same sizes as the other poses. Then src/ui/pose-art.json lists every pose with both files,
# so the app shows the new art instead of the fallback (POSE_FALLBACK in src/ui/mascot.ts) without a code change.
#
# IMPORT_POSES_DEBUG_DIR=<dir> also keeps the cleaned full-size PNGs there (to review the clean-up).
# Needs cwebp (libwebp) and ImageMagick; without them it runs itself in a throwaway Debian container (Docker).
set -euo pipefail

POSE_HEIGHT=96
QUALITY=80
# Clean-up, in pixels of a 1024 px wide source (scaled to the real width):
# parts more than KEEP_DISTANCE from the character are stray fragments (crop leftovers at the edges of the art);
# the soft glow is kept within GLOW of what stays.
KEEP_DISTANCE=64
GLOW=16
# White background → transparent: flood fill from the four corners with this fuzz.
WHITE_FUZZ=8%

repo="$(cd "$(dirname "$0")/../.." && pwd)"
src="${1:?usage: $0 <dir with pose-<id>.png> [<output dir>]}"
src="$(cd "$src" && pwd)"
out="${2:-$repo/public/mascot}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

magick_cmd() { if command -v magick >/dev/null 2>&1; then magick "$@"; else convert "$@"; fi; }

if ! command -v cwebp >/dev/null 2>&1 || ! { command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1; }; then
  if [ "${IMPORT_POSES_IN_DOCKER:-}" = 1 ]; then
    echo "cwebp / ImageMagick missing in the container" >&2
    exit 1
  fi
  # Inside the container the default output is the repository's own public/mascot (so the manifest follows it).
  target=/out
  [ "$out" = "$repo/public/mascot" ] && target=/repo/public/mascot
  exec docker run --rm -v "$repo":/repo -v "$src":/in:ro -v "$out":/out -w /repo -e IMPORT_POSES_IN_DOCKER=1 -e DEBIAN_FRONTEND=noninteractive \
    "${IMPORT_POSES_IMAGE:-debian:stable-slim}" sh -c "
      apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends webp imagemagick >/dev/null &&
      bash scripts/mascot/import-poses.sh /in $target; status=\$?; chown -R $(id -u):$(id -g) /out src/ui/pose-art.json; exit \$status"
fi

# clean <in.png> <out.png> <work dir>
# 1. An opaque white background becomes transparent (flood fill from the corners; transparent corners are left alone).
# 2. Connected components of the solid pixels (alpha ≥ 50 %): the largest is the character; another part is kept when
#    any of its pixels is within KEEP_DISTANCE of it (props: steam, sparkles, a leaf, the antenna arcs) and dropped
#    otherwise (cut-off fragments at the edges). The faint glow follows: it stays only within GLOW of the kept parts.
clean() {
  local in="$1" out="$2" tmp="$3"
  local width height distance glow
  read -r width height < <(magick_cmd identify -format '%w %h\n' "$in" | head -1)
  distance=$(( KEEP_DISTANCE * width / 1024 )); [ "$distance" -ge 2 ] || distance=2
  glow=$(( GLOW * width / 1024 )); [ "$glow" -ge 1 ] || glow=1
  magick_cmd "$in" -alpha set -fuzz "$WHITE_FUZZ" -fill none \
    -floodfill +0+0 white -floodfill "+$((width - 1))+0" white \
    -floodfill "+0+$((height - 1))" white -floodfill "+$((width - 1))+$((height - 1))" white "PNG32:$tmp/flat.png"
  magick_cmd "$tmp/flat.png" -alpha extract -threshold 50% "$tmp/solid.png"
  # id area, foreground (white) objects only, largest first.
  local objects
  objects="$(magick_cmd "$tmp/solid.png" -define connected-components:verbose=true -connected-components 8 null: |
    awk '$NF ~ /^(gray\(255\)|white|#FFFFFF|srgb\(255,255,255\))$/ { sub(":", "", $1); print $1, $4 }' | sort -k2,2nr)"
  if [ -z "$objects" ]; then
    cp "$tmp/flat.png" "$out"
    return
  fi
  local main keep id dropped=0
  main="$(head -1 <<<"$objects" | cut -d' ' -f1)"
  keep="$main"
  component() { magick_cmd "$tmp/solid.png" -define connected-components:keep="$1" -define connected-components:mean-color=true -connected-components 8 -threshold 50% "$2"; }
  component "$main" "$tmp/main.png"
  magick_cmd "$tmp/main.png" -morphology Dilate "Disk:$distance" "$tmp/zone.png"
  while read -r id _; do
    [ "$id" = "$main" ] && continue
    component "$id" "$tmp/part.png"
    if [ "$(magick_cmd "$tmp/zone.png" "$tmp/part.png" -compose multiply -composite -format '%[fx:maxima>0.5?1:0]' info:)" = 1 ]; then
      keep="$keep,$id"
    else
      dropped=$((dropped + 1))
    fi
  done <<<"$objects"
  component "$keep" "$tmp/keep.png"
  magick_cmd "$tmp/keep.png" -morphology Dilate "Disk:$glow" -blur "0x$(( (glow + 1) / 2 ))" "$tmp/mask.png"
  magick_cmd "$tmp/flat.png" \( "$tmp/flat.png" -alpha extract "$tmp/mask.png" -compose multiply -composite \) \
    -alpha off -compose CopyOpacity -composite "PNG32:$out"
  [ "$dropped" = 0 ] || echo "  $(basename "$in"): dropped $dropped stray fragment(s)"
}

ids="$(sed -n "/^export const POSE_IDS = \[/,/\] as const;/p" "$repo/src/lib/messages/types.ts" | grep -o "'[a-z0-9-]*'" | tr -d "'")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

shopt -s nullglob
count=0
for file in "$src"/pose-*.png; do
  id="$(basename "$file" .png)"
  id="${id#pose-}"
  if ! grep -qx -- "$id" <<<"$ids"; then
    echo "skip $(basename "$file"): '$id' is not in POSE_IDS" >&2
    continue
  fi
  clean "$file" "$work/$id-clean.png" "$work"
  [ -z "${IMPORT_POSES_DEBUG_DIR:-}" ] || cp "$work/$id-clean.png" "$IMPORT_POSES_DEBUG_DIR/pose-$id-clean.png"
  magick_cmd "$work/$id-clean.png" -trim +repage "$work/$id.png"
  cwebp -quiet -q "$QUALITY" -alpha_q 100 -resize 0 "$POSE_HEIGHT" "$work/$id.png" -o "$out/pose-$id.webp"
  cwebp -quiet -q "$QUALITY" -alpha_q 100 -resize 0 "$((POSE_HEIGHT * 2))" "$work/$id.png" -o "$out/pose-$id@2x.webp"
  echo "pose-$id.webp, pose-$id@2x.webp"
  count=$((count + 1))
done
echo "$count pose(s) imported into $out"

# The manifest follows the files in public/mascot only.
if [ "$out" = "$repo/public/mascot" ]; then
  listed=()
  for id in $ids; do
    if [ -f "$out/pose-$id.webp" ] && [ -f "$out/pose-$id@2x.webp" ]; then listed+=("  \"$id\""); fi
  done
  if [ "${#listed[@]}" -eq 0 ]; then
    echo '[]' >"$repo/src/ui/pose-art.json"
  else
    { echo '['; (IFS=$'\n'; printf '%s\n' "${listed[@]}") | sed '$!s/$/,/'; echo ']'; } >"$repo/src/ui/pose-art.json"
  fi
  echo "src/ui/pose-art.json: ${#listed[@]} pose(s) with their own art"
fi
