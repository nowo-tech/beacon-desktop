#!/usr/bin/env bash
# Imports the friendly-message mascot art (see public/mascot/README.md).
#
# Usage: scripts/mascot/import-poses.sh <dir with pose-<id>.png> [<output dir, default public/mascot>]
#
# Each pose-<id>.png (transparent, e.g. 1024 x 1024; <id> from POSE_IDS in src/lib/messages/types.ts) is trimmed to its
# visible pixels and saved as public/mascot/pose-<id>.webp (96 px high) and pose-<id>@2x.webp (192 px high), lossy WebP
# quality 80 with alpha: the same sizes as the other poses. Then src/ui/pose-art.json lists every pose with both files,
# so the app shows the new art instead of the fallback (POSE_FALLBACK in src/ui/mascot.ts) without a code change.
#
# Needs cwebp (libwebp) and ImageMagick; without them it runs itself in a throwaway Debian container (Docker).
set -euo pipefail

POSE_HEIGHT=96
QUALITY=80

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

ids="$(sed -n "/^export const POSE_IDS = \[/,/\] as const;/p" "$repo/src/lib/messages/types.ts" | grep -o "'[a-z-]*'" | tr -d "'")"
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
  magick_cmd "$file" -trim +repage "$work/$id.png"
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
